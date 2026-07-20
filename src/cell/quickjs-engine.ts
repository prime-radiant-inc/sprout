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
// process and shared by every engine instance; each cell still gets its own
// runtime + context.
let sharedReleaseModule: Promise<QuickJSModuleLike> | undefined;
function loadReleaseModule(): Promise<QuickJSModuleLike> {
	sharedReleaseModule ??= newQuickJSWASMModuleFromVariant(releaseVariant);
	return sharedReleaseModule;
}

const DEADLOCK_ERROR =
	"cell deadlocked: the cell is awaiting a promise that nothing can resolve " +
	"(no ambient call or timer outstanding)";

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
	private readonly loadModule: () => Promise<QuickJSModuleLike>;
	private modulePromise?: Promise<QuickJSModuleLike>;

	constructor(options: { loadModule?: () => Promise<QuickJSModuleLike> } = {}) {
		this.loadModule = options.loadModule ?? loadReleaseModule;
	}

	async runCell(request: CellEngineRequest): Promise<CellEngineResult> {
		this.modulePromise ??= this.loadModule();
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
			this.installBridges();
			const boot = this.context.evalCode(CELL_BOOTSTRAP);
			if (boot.error) return this.failFromHandle(boot.error);
			boot.value.dispose();
			if (this.request.programs !== undefined && this.request.programs.length > 0) {
				const programs = this.context.evalCode(buildProgramsBootstrap(this.request.programs));
				if (programs.error) return this.failFromHandle(programs.error);
				programs.value.dispose();
			}
			const cell = this.context.evalCode(wrapCellCode(this.request.code));
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
		this.request.callAmbient(method, args).then(
			(result) => {
				if (!this.live) return;
				this.outstandingAmbient--;
				this.resolveAmbient(deferred, result);
				this.pump();
			},
			(err: unknown) => {
				if (!this.live) return;
				this.outstandingAmbient--;
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
