/**
 * The QuickJS-WASM cell engine (QuickJS spec, 2026-07-20): the fails-closed
 * replacement for the node:vm realm. Cell code runs inside a QuickJS
 * interpreter compiled to wasm — an engine escape must break QuickJS, then the
 * wasm boundary, before it faces the host engine. Host objects cannot cross
 * the boundary as anything but marshaled values, so there is no host
 * constructor chain to leak.
 *
 * Async model (spec, decided): native-promise + job-pump. The ambient host
 * function creates a QuickJS deferred and returns its promise handle
 * synchronously; the cell's `await` suspends via QuickJS's own machinery; when
 * the parent responds we resolve the deferred and run pending jobs, pumping
 * until the top-level cell promise settles. Pumping is event-driven (ambient
 * resolution or timer fire), never a busy loop. A cell whose top-level promise
 * is pending with nothing outstanding can never settle — that surfaces as a
 * typed deadlock error, not a hang.
 *
 * Infra-error tagging across the boundary (spec): object identity does not
 * survive marshal-out, so the engine constructs infra rejection errors
 * IN-CONTEXT, retains their handles, and compares the top-level rejection
 * against them with QuickJS identity (`eq`). Cells cannot forge object
 * identity, so stumble accounting stays non-forgeable.
 *
 * Handle discipline: every handle this engine creates is disposed by cell
 * teardown — enforced by the debug-variant leak tests (quickjs-engine.test.ts).
 * One wasm module is shared per process; each cell gets a fresh runtime +
 * context, disposed at cell end.
 */

import releaseVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
	newQuickJSWASMModuleFromVariant,
	newVariant,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSRuntime,
	type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { buildProgramsBootstrap, CELL_BOOTSTRAP, wrapCellCode } from "./cell-bootstrap.ts";
import type { CellEngine, CellEngineRequest, CellEngineResult } from "./cell-engine.ts";

/** The slice of the wasm module the engine uses (lets tests inject a wrapper). */
export type QuickJSModuleLike = Pick<QuickJSWASMModule, "newRuntime">;

function loadReleaseModule(): Promise<QuickJSModuleLike> {
	return newQuickJSWASMModuleFromVariant(releaseVariant);
}

const WASM_PAGE_BYTES = 64 * 1024;
/** Must match the variant's emscripten INITIAL_MEMORY (256 pages = 16 MB). */
const WASM_INITIAL_PAGES = 256;
/**
 * The variant's own declared maximum memory (MAXIMUM_MEMORY = 2 GiB = 32768
 * pages for @jitl/quickjs-singlefile-mjs-release-sync 0.32.0, measured by
 * binary search). Importing a `WebAssembly.Memory` whose `maximum` exceeds the
 * module's declared maximum is a LinkError that aborts module instantiation —
 * hence the clamp: a memory budget above ~2 GiB pins the cap at 2 GiB rather
 * than bricking the cell subsystem.
 */
const WASM_MAX_PAGES = 32768;

/**
 * THE real memory cap (P2): a wasm linear memory whose `maximum` the allocator
 * cannot grow past — malloc fails, QuickJS throws an in-context
 * `InternalError: out of memory`, the cell errors typed, and the module stays
 * healthy for the next cell (verified: fresh runtimes reuse freed pages).
 *
 * This is the wasm-level cap because the in-runtime one is broken upstream
 * (quickjs-emscripten 0.32): `setMemoryLimit` rejects a SINGLE allocation
 * larger than the limit but does not track cumulative growth — empirically
 * 20,000 live 1 KB strings (21 MB) sail past an 8 MB malloc_limit with no
 * error. We still set it (it catches the single-shot case early), but the
 * linear-memory maximum is what makes the cap real.
 *
 * Granularity is honest, not byte-exact: the cell also gets whatever slack
 * remains in the initial heap (< 16 MB) beyond the engine's own baseline, and
 * the maximum is clamped to the wasm page ceiling (a >~4 GiB budget yields a
 * ~4 GiB cap, not a RangeError). The parent RSS watchdog stays as the outer
 * net above this.
 */
function loadCappedReleaseModule(memoryBytes: number): Promise<QuickJSModuleLike> {
	const maximum = Math.min(
		WASM_MAX_PAGES,
		WASM_INITIAL_PAGES + Math.ceil(memoryBytes / WASM_PAGE_BYTES),
	);
	const variant = newVariant(releaseVariant, {
		wasmMemory: new WebAssembly.Memory({ initial: WASM_INITIAL_PAGES, maximum }),
	});
	return newQuickJSWASMModuleFromVariant(variant);
}

const DEADLOCK_ERROR =
	"cell deadlocked: the cell is awaiting a promise that nothing can resolve " +
	"(no ambient call or timer outstanding)";

/**
 * Explicit interpreter stack cap (P2). QuickJS ships its own default; pinning
 * it makes the guarantee ours, not the toolchain default's. Sized for MARGIN:
 * every interpreter C-recursion level also consumes HOST wasm call-stack
 * frames whose size varies with the host's compilation tier (and therefore
 * with CPU load). The QuickJS soft limit must trip well before the host stack
 * exhausts, or deep recursion dies as a foreign RangeError that unwinds the
 * interpreter without cleanup (the JS_FreeRuntime list_empty abort). 256 KB
 * keeps thousands of frames for legitimate cell code while roughly quadrupling
 * the old 1 MB margin.
 */
export const CELL_MAX_STACK_BYTES = 256 * 1024;

/**
 * In-context display marshal, mirroring the worker's serializeReturnValue /
 * formatConsoleArg algorithm exactly (string verbatim → JSON → String
 * fallback) so top-level values leave the realm with the same display
 * semantics the vm engine produced via host-side JSON.stringify. Captures
 * pristine JSON.stringify and String before any cell code runs — reassigned
 * globals cannot forge it. Also keeps QuickJS internals (e.g. Error stack
 * frames from dump()) out of the transcript.
 */
const MARSHAL_DISPLAY = `((stringify, toStr) => (v) => {
	if (v === undefined) return ["absent"];
	if (typeof v === "string") return ["string", v];
	try { const j = stringify(v); if (j !== undefined) return ["json", j]; } catch (e) {}
	return ["string", toStr(v)];
})(JSON.stringify, String)`;

export class QuickJSCellEngine implements CellEngine {
	private readonly loadModule?: () => Promise<QuickJSModuleLike>;
	private modulePromise?: Promise<QuickJSModuleLike>;
	// The memory cap is a property of the wasm INSTANCE, so the module is built
	// for a specific cap. Rebuild when the cell's cap changes (the shared uncapped
	// module has no wasm ceiling and must not silently serve a later capped cell).
	private moduleMemoryBytes?: number;

	constructor(options: { loadModule?: () => Promise<QuickJSModuleLike> } = {}) {
		this.loadModule = options.loadModule;
	}

	async runCell(request: CellEngineRequest): Promise<CellEngineResult> {
		const module = await this.moduleFor(request.limits?.memoryBytes);
		const runtime = module.newRuntime();
		const context = runtime.newContext();
		const run = new CellRun(runtime, context, request);
		const result = await run.run();
		// A poisoned module (wasm OOB trap, foreign host throw, or a disposal
		// fault) must never serve another cell — drop it so the next cell
		// rebuilds a clean instance. Injected loaders are simply re-invoked.
		if (run.modulePoisoned) {
			this.modulePromise = undefined;
			this.moduleMemoryBytes = undefined;
		}
		return result;
	}

	private moduleFor(memoryBytes: number | undefined): Promise<QuickJSModuleLike> {
		if (this.loadModule !== undefined) {
			this.modulePromise ??= this.uncachedOnRejection(this.loadModule());
			return this.modulePromise;
		}
		if (this.modulePromise === undefined || this.moduleMemoryBytes !== memoryBytes) {
			this.moduleMemoryBytes = memoryBytes;
			this.modulePromise = this.uncachedOnRejection(
				memoryBytes !== undefined ? loadCappedReleaseModule(memoryBytes) : loadReleaseModule(),
			);
		}
		return this.modulePromise;
	}

	/**
	 * A rejected load must not stay cached: the parent never respawns a worker
	 * for an engine-failure result, so a cached rejection would brick cells for
	 * the whole agent process. Clear the cache so the next cell retries.
	 */
	private uncachedOnRejection(promise: Promise<QuickJSModuleLike>): Promise<QuickJSModuleLike> {
		return promise.catch((err) => {
			this.modulePromise = undefined;
			this.moduleMemoryBytes = undefined;
			throw err;
		});
	}
}

type TimerEntry = {
	kind: "timeout" | "interval";
	timer: ReturnType<typeof setTimeout>;
	fn: QuickJSHandle;
};

/** One cell execution: owns every handle it creates and disposes all of them. */
class CellRun {
	private live = true;
	private done = false;
	private outstandingAmbient = 0;
	private timerSeq = 0;
	// Deadline accounting (P2): wall time accrues only while NO ambient call is
	// outstanding — the parent budget clock's exact rule. `activeSince` is set
	// whenever the cell is unparked; transitions happen at the 0↔1 boundary of
	// outstandingAmbient. `deadlineHit` is host-owned state the cell cannot
	// forge: once set, the cell's outcome is overridden with the typed budget
	// error no matter what its code caught, returned, or threw.
	private deadlineHit = false;
	private accruedActiveMs = 0;
	private activeSince?: number;
	// Host-side wall-clock deadline covering the one thing the interpreter-step
	// interrupt cannot see: a cell idling on a long timer sleep runs no bytecode,
	// so nothing checks the deadline until the timer fires. Armed while active,
	// disarmed while parked on ambient I/O (which doesn't accrue).
	private deadlineTimer?: ReturnType<typeof setTimeout>;
	// Set when a wasm OOB trap has poisoned the module: teardown must NOT touch
	// the interpreter (disposal itself traps); the engine discards the module.
	modulePoisoned = false;
	private readonly timers = new Map<number, TimerEntry>();
	private readonly deferreds: QuickJSDeferredPromise[] = [];
	private readonly infraHandles: QuickJSHandle[] = [];
	private jsonParse?: QuickJSHandle;
	private marshalDisplay?: QuickJSHandle;
	private topPromise?: QuickJSHandle;
	private settle?: (result: CellEngineResult) => void;

	constructor(
		private readonly runtime: QuickJSRuntime,
		private readonly context: QuickJSContext,
		private readonly request: CellEngineRequest,
	) {}

	async run(): Promise<CellEngineResult> {
		try {
			return await this.runInner();
		} catch (err) {
			// A FOREIGN throw crossing the wasm boundary — JSC's RangeError when
			// the host wasm call stack exhausts before QuickJS's soft limit
			// (frame sizes vary with the host's compilation tier, hence with CPU
			// load), or an emscripten abort — leaves interpreter state
			// unknowable: poison the module so the engine discards it. A
			// stack-shaped fault is the cell's own runaway recursion (a stumble);
			// anything else is infrastructure.
			this.modulePoisoned = true;
			const message = err instanceof Error ? err.message : String(err);
			if (/stack/i.test(message)) {
				return { ok: false, error: `stack overflow: ${message}`, infrastructure: false };
			}
			return { ok: false, error: `cell engine fault: ${message}`, infrastructure: true };
		} finally {
			this.teardown();
		}
	}

	private async runInner(): Promise<CellEngineResult> {
		{
			this.applyLimits();
			this.installBridges();
			const boot = this.context.evalCode(CELL_BOOTSTRAP);
			if (boot.error) return this.failFromHandle(boot.error);
			boot.value.dispose();
			if (this.request.programs !== undefined && this.request.programs.length > 0) {
				const programs = this.context.evalCode(buildProgramsBootstrap(this.request.programs));
				if (programs.error) return this.failFromHandle(programs.error);
				programs.value.dispose();
			}
			this.setActive();
			const cell = this.context.evalCode(wrapCellCode(this.request.code));
			if (this.deadlineHit) {
				if (cell.error) cell.error.dispose();
				else cell.value.dispose();
				return this.budgetExceededResult();
			}
			if (cell.error) return this.failFromHandle(cell.error);
			this.topPromise = cell.value;
			return await new Promise<CellEngineResult>((resolve) => {
				this.settle = resolve;
				this.pump();
			});
		}
	}

	private applyLimits(): void {
		this.runtime.setMaxStackSize(CELL_MAX_STACK_BYTES);
		const limits = this.request.limits;
		if (limits?.memoryBytes !== undefined) {
			// Secondary guard only: catches a single over-limit allocation
			// early. The real cumulative cap is the wasm linear-memory maximum
			// (see loadCappedReleaseModule — upstream setMemoryLimit does not
			// enforce cumulative growth). Clamp to the wasm cap: the underlying
			// FFI takes a 32-bit size and a value past ~2 GiB traps.
			this.runtime.setMemoryLimit(Math.min(limits.memoryBytes, WASM_MAX_PAGES * WASM_PAGE_BYTES));
		}
		if (limits?.budgetMs !== undefined) {
			const budgetMs = limits.budgetMs;
			this.runtime.setInterruptHandler(() => {
				if (this.computeMsNow() > budgetMs) {
					this.deadlineHit = true;
					return true;
				}
				return false;
			});
		}
	}

	/** Compute time so far: accrued active slices plus the open one. */
	private computeMsNow(): number {
		return (
			this.accruedActiveMs + (this.activeSince !== undefined ? Date.now() - this.activeSince : 0)
		);
	}

	/** Enter an active (deadline-accruing) span and arm the wall-clock deadline. */
	private setActive(): void {
		if (this.activeSince !== undefined) return;
		this.activeSince = Date.now();
		const budgetMs = this.request.limits?.budgetMs;
		if (budgetMs === undefined) return;
		const remaining = Math.max(0, budgetMs - this.computeMsNow());
		this.deadlineTimer = setTimeout(() => {
			this.deadlineHit = true;
			this.finish(this.budgetExceededResult());
		}, remaining);
	}

	/** Park the deadline clock: waiting on the parent never accrues. */
	private setParked(): void {
		if (this.activeSince !== undefined) {
			this.accruedActiveMs += Date.now() - this.activeSince;
			this.activeSince = undefined;
		}
		this.clearDeadlineTimer();
	}

	private clearDeadlineTimer(): void {
		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
	}

	private overDeadline(): boolean {
		const budgetMs = this.request.limits?.budgetMs;
		return this.deadlineHit || (budgetMs !== undefined && this.computeMsNow() > budgetMs);
	}

	private budgetExceededResult(): CellEngineResult {
		// Mirrors the parent budget clock's kill, including its infrastructure
		// classification — a deadline is host-imposed, never a code stumble.
		return {
			ok: false,
			error: `cell budget exceeded (${this.request.limits?.budgetMs} ms of compute time)`,
			infrastructure: true,
		};
	}

	// --- host bridges -------------------------------------------------------

	private installBridges(): void {
		const ctx = this.context;
		this.jsonParse = ctx.unwrapResult(ctx.evalCode("JSON.parse"));
		this.marshalDisplay = ctx.unwrapResult(ctx.evalCode(MARSHAL_DISPLAY));

		const hostCall = ctx.newFunction("__hostCall__", (methodH, argsH) => {
			const method = ctx.getString(methodH);
			const args = argsH === undefined ? [] : (ctx.dump(argsH) as unknown[]);
			return this.beginAmbientCall(method, Array.isArray(args) ? args : []);
		});
		ctx.setProp(ctx.global, "__hostCall__", hostCall);
		hostCall.dispose();

		const hostLog = ctx.newFunction("__hostLog__", (argsH) => {
			this.request.log(this.marshalLogArgs(argsH));
		});
		ctx.setProp(ctx.global, "__hostLog__", hostLog);
		hostLog.dispose();

		const timers = ctx.newObject();
		const install = (name: string, fn: Parameters<typeof ctx.newFunction>[1]) => {
			const handle = ctx.newFunction(name, fn);
			ctx.setProp(timers, name, handle);
			handle.dispose();
		};
		install("setTimeout", (fnH, msH) => this.scheduleTimer("timeout", fnH, msH));
		install("setInterval", (fnH, msH) => this.scheduleTimer("interval", fnH, msH));
		install("clearTimeout", (tokenH) => {
			this.cancelTimer(ctx.getNumber(tokenH));
		});
		install("clearInterval", (tokenH) => {
			this.cancelTimer(ctx.getNumber(tokenH));
		});
		ctx.setProp(ctx.global, "__hostTimers__", timers);
		timers.dispose();
	}

	private beginAmbientCall(method: string, args: unknown[]): QuickJSHandle {
		const deferred = this.context.newPromise();
		this.deferreds.push(deferred);
		this.outstandingAmbient++;
		if (this.outstandingAmbient === 1) this.setParked();
		this.request.callAmbient(method, args).then(
			(result) => {
				if (!this.live) return;
				this.outstandingAmbient--;
				if (this.outstandingAmbient === 0) this.setActive();
				this.resolveAmbient(deferred, result);
				this.pump();
			},
			(err: unknown) => {
				if (!this.live) return;
				this.outstandingAmbient--;
				if (this.outstandingAmbient === 0) this.setActive();
				this.rejectAmbient(deferred, err);
				this.pump();
			},
		);
		// The wrapper consumes the returned reference; the deferred keeps its
		// own, disposed at teardown (idempotent whether or not it settled).
		return deferred.handle.dup();
	}

	private resolveAmbient(deferred: QuickJSDeferredPromise, result: unknown): void {
		// Marshal-in IS the sever: the result crosses as JSON text parsed by a
		// pristine in-context JSON.parse captured before any cell code ran.
		const json = result === undefined ? undefined : JSON.stringify(result);
		if (json === undefined || this.jsonParse === undefined) {
			deferred.resolve();
			return;
		}
		// newString allocates the marshal buffer through emscripten glue _malloc,
		// which does NOT fail gracefully at the wasm cap — it returns 0 and the
		// glue writes out of bounds, an UNCATCHABLE-cleanly wasm trap that even
		// poisons disposal. So a cell that fills its heap then pulls a large
		// ambient result would crash the worker. Guard the glue allocation: on a
		// trap, finish the cell as a typed OOM stumble and mark the module
		// poisoned so the engine discards it (teardown must not touch it).
		let text: QuickJSHandle;
		try {
			text = this.context.newString(json);
		} catch {
			this.modulePoisoned = true;
			this.finish({
				ok: false,
				error:
					"out of memory: the cell exhausted its memory budget and could not receive the ambient result",
				infrastructure: false,
			});
			return;
		}
		const parsed = this.context.callFunction(this.jsonParse, this.context.undefined, text);
		text.dispose();
		if (parsed.error) {
			deferred.reject(parsed.error);
			parsed.error.dispose();
		} else {
			deferred.resolve(parsed.value);
			parsed.value.dispose();
		}
	}

	private rejectAmbient(deferred: QuickJSDeferredPromise, err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		// Same glue-trap guard as resolveAmbient's newString: newError allocates
		// through emscripten _malloc, which traps uncleanly at the wasm cap. A
		// cell that filled its heap gets the typed OOM stumble, not a dead worker.
		let errorHandle: QuickJSHandle;
		try {
			errorHandle = this.context.newError(message);
		} catch {
			this.modulePoisoned = true;
			this.finish({
				ok: false,
				error:
					"out of memory: the cell exhausted its memory budget and could not receive the ambient error",
				infrastructure: false,
			});
			return;
		}
		if (this.request.isInfraError(err)) {
			this.infraHandles.push(errorHandle.dup());
		}
		deferred.reject(errorHandle);
		errorHandle.dispose();
	}

	/**
	 * Marshal one realm value out via the pristine in-context helper. The
	 * tuple's KIND survives the boundary: "string" means the value WAS a
	 * string (verbatim display), "json" carries the exact serialized bytes the
	 * realm produced, "absent" is undefined. Collapsing kinds here is the bug
	 * this exists to prevent — a Date must leave as its quoted JSON form, not
	 * as a bare string.
	 */
	private marshalOut(valueHandle: QuickJSHandle): ["absent"] | ["string" | "json", string] {
		if (this.marshalDisplay === undefined) return ["absent"];
		const result = this.context.callFunction(
			this.marshalDisplay,
			this.context.undefined,
			valueHandle,
		);
		if (result.error) {
			// A tampered toString/toJSON threw even past the String fallback —
			// surface it honestly rather than crash.
			const message = this.errorMessage(result.error);
			result.error.dispose();
			return ["string", `[unserializable: ${message}]`];
		}
		const tuple = this.context.dump(result.value) as ["absent"] | ["string" | "json", string];
		result.value.dispose();
		return tuple;
	}

	/** The serialized return value: absent stays absent; both other kinds are
	 * already the final bytes (verbatim string or the realm's JSON). */
	private serializeFulfilled(valueHandle: QuickJSHandle): string | undefined {
		const tuple = this.marshalOut(valueHandle);
		return tuple[0] === "absent" ? undefined : tuple[1];
	}

	private marshalLogArgs(argsH: QuickJSHandle | undefined): unknown[] {
		if (argsH === undefined) return [];
		const ctx = this.context;
		const lengthH = ctx.getProp(argsH, "length");
		const length = ctx.getNumber(lengthH);
		lengthH.dispose();
		const args: unknown[] = [];
		for (let i = 0; i < length; i++) {
			const el = ctx.getProp(argsH, String(i));
			// Each arg becomes its final display text (the worker passes
			// strings through verbatim): undefined prints as "undefined",
			// matching String(undefined) in the vm path.
			const tuple = this.marshalOut(el);
			args.push(tuple[0] === "absent" ? "undefined" : tuple[1]);
			el.dispose();
		}
		return args;
	}

	// --- timers -------------------------------------------------------------

	private scheduleTimer(
		kind: "timeout" | "interval",
		fnH: QuickJSHandle,
		msH: QuickJSHandle | undefined,
	): QuickJSHandle {
		const ms = msH === undefined ? 0 : this.context.getNumber(msH);
		const fn = fnH.dup();
		const token = ++this.timerSeq;
		const timer =
			kind === "timeout"
				? setTimeout(() => this.fireTimer(token), ms)
				: setInterval(() => this.fireTimer(token), ms);
		this.timers.set(token, { kind, timer, fn });
		return this.context.newNumber(token);
	}

	private fireTimer(token: number): void {
		if (!this.live || this.done) return;
		const entry = this.timers.get(token);
		if (entry === undefined) return;
		// A sleeping cell (timer pending, nothing parked) accrues compute time;
		// past the deadline its callback never runs — the cell ends typed.
		if (this.overDeadline()) {
			this.finish(this.budgetExceededResult());
			return;
		}
		if (entry.kind === "timeout") {
			this.timers.delete(token);
		}
		// The FFI section runs bare inside a host setTimeout: a foreign throw
		// here would be an uncaught exception that kills the worker. Contain it
		// with run()'s classification instead.
		try {
			const result = this.context.callFunction(entry.fn, this.context.undefined);
			if (entry.kind === "timeout") entry.fn.dispose();
			if (result.error) {
				const message = this.errorMessage(result.error);
				result.error.dispose();
				// A deadline interrupt fired mid-callback (callFunction reports
				// "interrupted") — end the cell typed, not as the callback's throw.
				if (this.overDeadline()) {
					this.finish(this.budgetExceededResult());
					return;
				}
				// Any other error — a genuine cell throw or an in-context OOM — fails
				// the CELL as a stumble. Unlike the vm engine (whose detached host
				// timer would crash the worker), QuickJS holds the error value, so
				// the worker survives and the failure is correctly the cell's. Timers
				// are torn down at cell end, so this only ever fires within the
				// offending cell's own run.
				this.finish({ ok: false, error: message, infrastructure: false });
				return;
			}
			result.value.dispose();
			this.pump();
		} catch (err) {
			this.containHostFault(err);
		}
	}

	private cancelTimer(token: number): void {
		const entry = this.timers.get(token);
		if (entry === undefined) return;
		this.timers.delete(token);
		if (entry.kind === "timeout") clearTimeout(entry.timer);
		else clearInterval(entry.timer);
		entry.fn.dispose();
	}

	// --- the pump -----------------------------------------------------------

	/**
	 * Run pending jobs to quiescence, then read the top-level promise: settled
	 * → finish; pending with nothing outstanding → deadlock (no future event
	 * exists that could resolve it).
	 *
	 * Pump runs from detached ambient/timer callbacks, so a throw here would
	 * neither settle the cell nor reach the worker's engine guard — it must be
	 * converted to a typed infrastructure result, never allowed to escape.
	 */
	private pump(): void {
		if (this.done || this.topPromise === undefined) return;
		try {
			this.pumpInner();
		} catch (err) {
			this.containHostFault(err);
		}
	}

	/**
	 * run()'s foreign-fault classification, shared with the detached paths
	 * (pump, timer callbacks): the throw crossed the wasm boundary, so
	 * interpreter state is unknowable — poison the module. A stack-shaped
	 * fault is the cell's own runaway recursion (a stumble); anything else is
	 * infrastructure.
	 */
	private containHostFault(err: unknown): void {
		this.modulePoisoned = true;
		const message = err instanceof Error ? err.message : String(err);
		if (/stack/i.test(message)) {
			this.finish({ ok: false, error: `stack overflow: ${message}`, infrastructure: false });
		} else {
			this.finish({ ok: false, error: `cell engine fault: ${message}`, infrastructure: true });
		}
	}

	private pumpInner(): void {
		if (this.topPromise === undefined) return;
		const jobs = this.runtime.executePendingJobs();
		// Deadline checks bracket the jobs run: the interrupt may have fired
		// mid-continuation (deadlineHit), and a cell that caught or outran the
		// interrupt must still be overridden BEFORE its settlement is honored —
		// the outcome of a past-deadline cell is always the typed budget error.
		if (this.overDeadline()) {
			jobs.dispose();
			this.finish(this.budgetExceededResult());
			return;
		}
		if (jobs.error) {
			const message = this.errorMessage(jobs.error);
			jobs.dispose();
			this.finish({ ok: false, error: message, infrastructure: false });
			return;
		}
		jobs.dispose();
		const state = this.context.getPromiseState(this.topPromise);
		if (state.type === "fulfilled") {
			const returnValue = this.serializeFulfilled(state.value);
			state.value.dispose();
			this.finish({ ok: true, returnValue });
		} else if (state.type === "rejected") {
			const infrastructure = this.infraHandles.some((h) => this.context.eq(h, state.error));
			const message = this.errorMessage(state.error);
			state.error.dispose();
			this.finish({ ok: false, error: message, infrastructure });
		} else if (this.outstandingAmbient === 0 && this.timers.size === 0) {
			this.finish({ ok: false, error: DEADLOCK_ERROR, infrastructure: false });
		}
	}

	private finish(result: CellEngineResult): void {
		if (this.done) return;
		this.done = true;
		this.clearDeadlineTimer();
		this.settle?.(result);
	}

	// --- errors and teardown ------------------------------------------------

	/**
	 * Human-facing message: `.message` off any error-like object, else
	 * in-context String coercion. Deliberately NOT byte-identical to the vm
	 * engine (whose host-side `instanceof Error` is false for realm errors,
	 * yielding "Error: boom" where this yields "boom") — the spec pins error
	 * SHAPES, not engine strings, and the bare message is the useful half.
	 */
	private errorMessage(errorHandle: QuickJSHandle): string {
		const ctx = this.context;
		const kind = ctx.typeof(errorHandle);
		if (kind === "object") {
			const messageH = ctx.getProp(errorHandle, "message");
			const message = ctx.typeof(messageH) === "string" ? ctx.getString(messageH) : undefined;
			messageH.dispose();
			if (message !== undefined && message.length > 0) return message;
		}
		// String coercion throws for a thrown symbol and yields "" for some
		// exotics — fall back to the type so the failure is never a blank line.
		try {
			const coerced = ctx.getString(errorHandle);
			if (coerced.length > 0) return coerced;
		} catch {
			// fall through to the type label
		}
		return `cell threw a non-error ${kind}`;
	}

	private failFromHandle(errorHandle: QuickJSHandle): CellEngineResult {
		const message = this.errorMessage(errorHandle);
		errorHandle.dispose();
		return { ok: false, error: message, infrastructure: false };
	}

	private teardown(): void {
		this.live = false;
		this.done = true;
		this.clearDeadlineTimer();
		// Host-side timer handles are always safe to clear (they live in this
		// process, not the wasm heap).
		for (const entry of this.timers.values()) {
			if (entry.kind === "timeout") clearTimeout(entry.timer);
			else clearInterval(entry.timer);
		}
		// A poisoned module's wasm heap is corrupt: touching ANY interpreter
		// handle (dispose included) traps. Leave everything to be reclaimed when
		// the engine drops the module and the GC collects it.
		if (this.modulePoisoned) {
			this.timers.clear();
			return;
		}
		try {
			for (const entry of this.timers.values()) entry.fn.dispose();
			this.timers.clear();
			for (const handle of this.infraHandles) handle.dispose();
			this.infraHandles.length = 0;
			for (const deferred of this.deferreds) deferred.dispose();
			this.deferreds.length = 0;
			this.topPromise?.dispose();
			this.topPromise = undefined;
			this.jsonParse?.dispose();
			this.jsonParse = undefined;
			this.marshalDisplay?.dispose();
			this.marshalDisplay = undefined;
			this.context.dispose();
			this.runtime.dispose();
		} catch {
			// Disposal itself faulted (the wild case: a foreign host-stack
			// overflow leaked GC objects mid-unwind, and JS_FreeRuntime's
			// list_empty assert surfaces as an emscripten abort THROWN from
			// dispose). The cell's result is already decided; poison the module
			// so the engine discards it — never let teardown take the worker
			// down.
			this.timers.clear();
			this.modulePoisoned = true;
		}
	}
}
