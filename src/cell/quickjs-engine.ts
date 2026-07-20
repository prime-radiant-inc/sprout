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

// The singlefile release module (wasm embedded as base64) is loaded once per
// process and shared by every UNCAPPED engine instance; each cell still gets
// its own runtime + context. Memory-capped engines build their own module
// (the cap is a property of the wasm instance).
let sharedReleaseModule: Promise<QuickJSModuleLike> | undefined;
function loadReleaseModule(): Promise<QuickJSModuleLike> {
	sharedReleaseModule ??= newQuickJSWASMModuleFromVariant(releaseVariant);
	return sharedReleaseModule;
}

const WASM_PAGE_BYTES = 64 * 1024;
/** Must match the variant's emscripten INITIAL_MEMORY (256 pages = 16 MB). */
const WASM_INITIAL_PAGES = 256;

/**
 * THE real memory cap (P2): a wasm linear memory whose `maximum` the allocator
 * cannot grow past — malloc fails, QuickJS throws an in-context
 * `InternalError: out of memory`, the cell errors typed, and the module stays
 * healthy for the next cell (verified: fresh runtimes reuse freed pages).
 *
 * This is the wasm-level cap because the in-runtime one is half-broken
 * upstream (quickjs-emscripten 0.32): `setMemoryLimit` rejects a SINGLE
 * allocation larger than the limit but does not enforce cumulative growth —
 * empirically a runtime sits at 19 MB used with an 8 MB malloc_limit and no
 * error. We still set it (it catches the single-shot case early), but the
 * linear-memory maximum is what makes the cap real.
 *
 * Granularity is honest, not byte-exact: the cell also gets whatever slack
 * remains in the initial heap (< 16 MB) beyond the engine's own baseline. The
 * parent RSS watchdog stays as the outer net above this.
 */
function loadCappedReleaseModule(memoryBytes: number): Promise<QuickJSModuleLike> {
	const maximum = WASM_INITIAL_PAGES + Math.ceil(memoryBytes / WASM_PAGE_BYTES);
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
 * it makes the guarantee ours, not the toolchain default's.
 */
export const CELL_MAX_STACK_BYTES = 1024 * 1024;

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

	constructor(options: { loadModule?: () => Promise<QuickJSModuleLike> } = {}) {
		this.loadModule = options.loadModule;
	}

	async runCell(request: CellEngineRequest): Promise<CellEngineResult> {
		// The wasm memory cap is per-module, so the module is sized by the
		// FIRST capped cell this engine sees (one engine per worker; the host
		// sends the same config every cell). An injected loader wins — tests
		// own their module.
		this.modulePromise ??=
			this.loadModule !== undefined
				? this.loadModule()
				: request.limits?.memoryBytes !== undefined
					? loadCappedReleaseModule(request.limits.memoryBytes)
					: loadReleaseModule();
		const module = await this.modulePromise;
		const runtime = module.newRuntime();
		const context = runtime.newContext();
		return await new CellRun(runtime, context, request).run();
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
			this.activeSince = Date.now();
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
		} finally {
			this.teardown();
		}
	}

	private applyLimits(): void {
		this.runtime.setMaxStackSize(CELL_MAX_STACK_BYTES);
		const limits = this.request.limits;
		if (limits?.memoryBytes !== undefined) {
			// Secondary guard only: catches a single over-limit allocation
			// early. The real cumulative cap is the wasm linear-memory maximum
			// (see loadCappedReleaseModule — upstream setMemoryLimit does not
			// enforce cumulative growth).
			this.runtime.setMemoryLimit(limits.memoryBytes);
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
		if (this.outstandingAmbient === 1 && this.activeSince !== undefined) {
			// Park the deadline clock: time spent waiting on the parent never
			// accrues (the parent budget clock's exact rule).
			this.accruedActiveMs += Date.now() - this.activeSince;
			this.activeSince = undefined;
		}
		this.request.callAmbient(method, args).then(
			(result) => {
				if (!this.live) return;
				this.outstandingAmbient--;
				if (this.outstandingAmbient === 0) this.activeSince = Date.now();
				this.resolveAmbient(deferred, result);
				this.pump();
			},
			(err: unknown) => {
				if (!this.live) return;
				this.outstandingAmbient--;
				if (this.outstandingAmbient === 0) this.activeSince = Date.now();
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
		const text = this.context.newString(json);
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
		const errorHandle = this.context.newError(message);
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
		if (!this.live) return;
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
		const result = this.context.callFunction(entry.fn, this.context.undefined);
		if (entry.kind === "timeout") entry.fn.dispose();
		if (result.error) {
			// Parity with the vm engine, where a throwing timer callback
			// propagates out of the host timer and kills the worker (the parent
			// respawns it). Extract the message first, then let it fly.
			const message = this.errorMessage(result.error);
			result.error.dispose();
			throw new Error(`cell timer callback threw: ${message}`);
		}
		result.value.dispose();
		this.pump();
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
			this.finish({
				ok: false,
				error: `cell engine internal failure: ${err instanceof Error ? err.message : String(err)}`,
				infrastructure: true,
			});
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
		if (ctx.typeof(errorHandle) === "object") {
			const messageH = ctx.getProp(errorHandle, "message");
			const message = ctx.typeof(messageH) === "string" ? ctx.getString(messageH) : undefined;
			messageH.dispose();
			if (message !== undefined) return message;
		}
		return ctx.getString(errorHandle);
	}

	private failFromHandle(errorHandle: QuickJSHandle): CellEngineResult {
		const message = this.errorMessage(errorHandle);
		errorHandle.dispose();
		return { ok: false, error: message, infrastructure: false };
	}

	private teardown(): void {
		this.live = false;
		this.done = true;
		for (const entry of this.timers.values()) {
			if (entry.kind === "timeout") clearTimeout(entry.timer);
			else clearInterval(entry.timer);
			entry.fn.dispose();
		}
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
	}
}
