/**
 * Cell worker subprocess entry (sap spec §4). Each agent process owns ONE cell
 * worker (Phase 5 design decision): cells execute here, in a stripped realm,
 * and every ambient op is proxied to the PARENT over stdio — the worker holds
 * no store credentials and no channel token. The parent's stdin pipe is the
 * lease: when the owner dies the pipe closes, the line loop ends, and the
 * worker exits.
 *
 * Protocol (stdio JSONL, mirroring the store worker, plus worker-initiated
 * ambient requests):
 *   parent → worker: { id, op: "cell", code }
 *   worker → parent: { id, op: "ambient", method, args }   (worker-initiated)
 *   parent → worker: { id, ok, result | error }             (ambient response)
 *   worker → parent: { id, op: "result", ok, output, returnValue?, error? }
 */

import vm from "node:vm";

/**
 * A genome program made available to the cell realm (spec §7): its name and JS
 * body. The worker builds `programs.<name>(args)` from these in the realm
 * bootstrap — the body runs in the SAME vm context with the SAME ambient API as
 * cell code, no host constructor leak.
 */
export type WorkerProgram = { name: string; body: string };

export type CellWorkerRequest = {
	id: string;
	op: "cell";
	code: string;
	programs?: WorkerProgram[];
};

/**
 * Parent's answer to one ambient request, correlated by the worker's id. An
 * `infrastructure` rejection (worker death, StoreUnavailable, spawn transport)
 * carries the flag so the worker can track its OBJECT identity — the cell's
 * stumble accounting keys on identity, never on the message string a cell could
 * forge.
 */
export type CellAmbientResponse =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; error: string; infrastructure?: boolean };

export type CellWorkerMessage =
	| { id: string; op: "ambient"; method: string; args: unknown[] }
	| {
			id: string;
			op: "result";
			ok: boolean;
			output: string;
			returnValue?: string;
			error?: string;
			/** True only when the terminal error IS a host infrastructure error. */
			infrastructure?: boolean;
	  };

/** Ambient API methods proxied to the parent (value ops; spawn is Slice B). */
export const AMBIENT_METHODS = [
	"bind",
	"publish",
	"peek",
	"slice",
	"lines",
	"grep",
	"parse",
	"size",
	"get",
] as const;

/**
 * The cell realm (spec §4). Cell code runs inside a fresh V8 context created by
 * `node:vm` — its `globalThis`, `Function`, `eval`, and constructor chain all
 * resolve to THAT context, so `Function("return process")()`,
 * `eval("Bun")`, and `({}).constructor.constructor("return globalThis")()` all
 * evaluate against the sandbox global, which has no Bun/process/require/fetch.
 * Shadowing globals as parameters (the old `new Function` realm) was cosmetic —
 * those escapes reached the host scope. A vm context is the real boundary.
 *
 * The sandbox exposes ONLY the ambient API, console, timers, and a
 * context-native structuredClone. The standard JS intrinsics (Object, Array,
 * JSON, Math, Promise, Map, Set, Date, RegExp, Error, ...) already exist in the
 * fresh context's global — we do NOT copy host ones in (that would re-introduce
 * the host constructor chain, the whole bug). Bun's fresh context omits
 * structuredClone, TextEncoder/Decoder, and timers, so those we add: timers as
 * sealed wrappers over the host's (see below), structuredClone as pure
 * context-source JS. TextEncoder/Decoder are NOT provided — no cell path needs
 * raw byte encoding (get() yields strings), and a sealed reimplementation would
 * be dead weight.
 *
 * The bootstrap runs BEFORE cell code and installs everything from source
 * (inside the context) over three host bridges passed via the sandbox:
 * __hostCall__ (proxy an ambient op), __hostLog__ (append console output), and
 * __hostTimers__ (schedule/cancel). All three are captured in a bootstrap
 * closure and then deleted from the context global, so cell code cannot reach
 * the raw host functions to walk their constructor chain. Ambient results are
 * JSON-severed inside the context (host promises/objects never leak their
 * prototype to the cell), and timer ids are opaque context integers mapping to
 * host timer handles held in the closure.
 */
function buildCellBootstrap(): string {
	const ambientList = JSON.stringify([...AMBIENT_METHODS]);
	return `
"use strict";
(function (hostCall, hostLog, hostTimers) {
	const AMBIENT = ${ambientList};
	const sever = (r) => (r === undefined ? undefined : JSON.parse(JSON.stringify(r)));
	const callAmbient = async (method, args) => sever(await hostCall(method, args));
	for (const method of AMBIENT) {
		globalThis[method] = (...args) => callAmbient(method, args);
	}
	const mkLog = () => (...args) => { hostLog(args); };
	globalThis.console = { log: mkLog(), warn: mkLog(), error: mkLog() };

	function wrapOutcome(wire) {
		const handle = makeHandle(wire.handleId);
		if (wire.kind === "started") return { handle };
		return { ok: wire.ok, summary: wire.summary, bindings: wire.bindings, handle };
	}
	function makeHandle(hid) {
		return {
			id: hid,
			wait: async () => wrapOutcome(await callAmbient("handle_wait", [hid])),
			message: async (text, opts) => wrapOutcome(await callAmbient("handle_message", [hid, text, opts])),
			future: async (name) => callAmbient("handle_future", [hid, name]),
		};
	}
	globalThis.spawn = async (agent, goal, opts) => wrapOutcome(await callAmbient("spawn", [agent, goal, opts]));
	globalThis.handle = (hid) => {
		if (typeof hid !== "string") throw new Error("handle(id): id must be a string");
		return makeHandle(hid);
	};

	let timerSeq = 0;
	const liveTimers = new Map();
	globalThis.setTimeout = (fn, ms, ...a) => {
		const key = ++timerSeq;
		const t = hostTimers.setTimeout(() => { liveTimers.delete(key); fn(...a); }, ms);
		liveTimers.set(key, t);
		return key;
	};
	globalThis.setInterval = (fn, ms, ...a) => {
		const key = ++timerSeq;
		const t = hostTimers.setInterval(() => fn(...a), ms);
		liveTimers.set(key, t);
		return key;
	};
	globalThis.clearTimeout = (key) => {
		const t = liveTimers.get(key);
		if (t !== undefined) { hostTimers.clearTimeout(t); liveTimers.delete(key); }
	};
	globalThis.clearInterval = (key) => {
		const t = liveTimers.get(key);
		if (t !== undefined) { hostTimers.clearInterval(t); liveTimers.delete(key); }
	};

	globalThis.structuredClone = function structuredClone(value, seen) {
		if (value === null || typeof value !== "object") return value;
		seen = seen || new WeakMap();
		if (seen.has(value)) return seen.get(value);
		if (value instanceof Date) return new Date(value.getTime());
		if (value instanceof RegExp) return new RegExp(value.source, value.flags);
		if (Array.isArray(value)) {
			const out = [];
			seen.set(value, out);
			for (let i = 0; i < value.length; i++) out[i] = structuredClone(value[i], seen);
			return out;
		}
		if (value instanceof Map) {
			const out = new Map();
			seen.set(value, out);
			for (const [k, v] of value) out.set(structuredClone(k, seen), structuredClone(v, seen));
			return out;
		}
		if (value instanceof Set) {
			const out = new Set();
			seen.set(value, out);
			for (const v of value) out.add(structuredClone(v, seen));
			return out;
		}
		const out = {};
		seen.set(value, out);
		for (const k of Object.keys(value)) out[k] = structuredClone(value[k], seen);
		return out;
	};
})(__hostCall__, __hostLog__, __hostTimers__);
delete globalThis.__hostCall__;
delete globalThis.__hostLog__;
delete globalThis.__hostTimers__;
`;
}

const CELL_BOOTSTRAP = buildCellBootstrap();

/**
 * Build the `programs` namespace bootstrap (spec §7). Runs in-context AFTER the
 * ambient bootstrap: each program becomes `programs.<name> = async (args) =>
 * { <body> }`, so the body reads its typed params off `args` and reaches the
 * value/spawn API through the same context globals cell code uses. Program
 * names are validated [a-z0-9_] at the genome gate, so the key interpolation is
 * a real identifier-charset string; the body is model-written genome code that
 * already passed the lexical import/require scan, and runs at the same privilege
 * as the cell that invokes it (fresh context per cell).
 */
/**
 * Program bodies are injected verbatim, trusting the lexical import/require scan
 * already run at genome validation AND load (validateProgram). The `programs`
 * field is parent/CellHost-supplied, never model-supplied, so there is no
 * model-reachable path to inject an unscanned body here. Bodies run in the same
 * confined realm as the cell, at exactly cell privilege.
 */
function buildProgramsBootstrap(programs: WorkerProgram[]): string {
	const assignments = programs
		.map(
			(program) =>
				`\tprograms[${JSON.stringify(program.name)}] = async (args = {}) => {\n${program.body}\n\t};`,
		)
		.join("\n");
	return `"use strict";
(function () {
	const programs = {};
${assignments}
	globalThis.programs = programs;
})();
`;
}

/**
 * Lexical gate (spec §4, frozen): any `import` or `require` token occurrence
 * rejects the cell BEFORE execution — dynamic `import()` is syntax, not a
 * deletable property, so global stripping alone cannot deliver "no import".
 * Word-boundary match on the raw source; hits inside comments and strings
 * over-reject, which is safe — silence is not. Returns the rejection message,
 * or undefined when the code passes.
 */
export function rejectImportRequire(code: string): string | undefined {
	const match = code.match(/\b(import|require)\b/);
	if (!match) return undefined;
	return (
		`cell rejected: "${match[1]}" is not available in cells. ` +
		"Cells run pure JS plus the ambient API (bind, get, slice, grep, ...); " +
		"there are no modules — even in comments or strings the token is refused."
	);
}

/** Console buffer cap; past it output truncates with a note. */
export const CONSOLE_BUFFER_CAP = 64 * 1024;

/** util.format-ish console capture: strings verbatim, the rest as JSON. */
function formatConsoleArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	try {
		const json = JSON.stringify(arg);
		if (json !== undefined) return json;
	} catch {
		// Circular or otherwise unserializable — fall through to String().
	}
	return String(arg);
}

class ConsoleBuffer {
	private text = "";
	private truncated = false;

	append(args: unknown[]): void {
		if (this.truncated) return;
		this.text += `${args.map(formatConsoleArg).join(" ")}\n`;
		if (this.text.length > CONSOLE_BUFFER_CAP) {
			this.text = `${this.text.slice(0, CONSOLE_BUFFER_CAP)}\n[console output truncated at ${CONSOLE_BUFFER_CAP} bytes]\n`;
			this.truncated = true;
		}
	}

	contents(): string {
		return this.text;
	}
}

/**
 * Serialize a cell's final value for the result line. Strings pass verbatim;
 * everything else goes through JSON (String() as the honest fallback);
 * undefined stays absent — "no return statement" and "return undefined" look
 * the same, which the tool description documents.
 */
function serializeReturnValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// fall through
	}
	return String(value);
}

export interface RunCellWorkerInput {
	/** Raw stdin chunks (or pre-split lines); split on \n internally. */
	lines: AsyncIterable<string | Uint8Array>;
	/** Emit one message line (newline handled by the caller's transport). */
	write: (line: string) => void;
}

/**
 * Serve cells over a line protocol. Separated from real stdio so the protocol
 * is testable in-process. The line loop must NOT await cell execution: a
 * running cell awaits ambient responses that arrive as later lines, so cells
 * start detached and the loop keeps reading. The parent serializes cells; a
 * second cell arriving while one runs is refused loudly rather than queued.
 */
export async function runCellWorker(input: RunCellWorkerInput): Promise<void> {
	const pendingAmbient = new Map<
		string,
		{ resolve: (result: unknown) => void; reject: (err: Error) => void }
	>();
	// Errors the host tagged as infrastructure, held by OBJECT identity: a cell
	// that catches and rethrows a NEW error (however it words the message) does
	// not leak into this set, so its failure is a stumble, not infrastructure.
	const infraErrors = new WeakSet<object>();
	let ambientSeq = 0;
	let cellRunning = false;

	function callAmbient(method: string, args: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = `ambient-${++ambientSeq}`;
			pendingAmbient.set(id, { resolve, reject });
			input.write(JSON.stringify({ id, op: "ambient", method, args }));
		});
	}

	async function executeCell(id: string, code: string, programs?: WorkerProgram[]): Promise<void> {
		const consoleBuffer = new ConsoleBuffer();
		const rejection = rejectImportRequire(code);
		if (rejection !== undefined) {
			input.write(JSON.stringify({ id, op: "result", ok: false, output: "", error: rejection }));
			return;
		}
		try {
			// The realm: a fresh V8 context (node:vm). The bootstrap installs the
			// ambient API, console, timers, and structuredClone from source INSIDE
			// the context over host bridges that are deleted after capture; cell
			// code then runs in an async IIFE (so top-level await works) whose
			// Function/eval/constructor chain all resolve context-locally. The
			// cell's value is its `return` statement — a documented simplification
			// (a true completion-value REPL needs eval, which the realm bans).
			const sandbox: Record<string, unknown> = {
				__hostCall__: (method: string, args: unknown[]) => callAmbient(method, args),
				__hostLog__: (args: unknown[]) => consoleBuffer.append(args),
				__hostTimers__: {
					setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
					setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
					clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
					clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
				},
			};
			const context = vm.createContext(sandbox);
			vm.runInContext(CELL_BOOTSTRAP, context);
			if (programs !== undefined && programs.length > 0) {
				vm.runInContext(buildProgramsBootstrap(programs), context);
			}
			const value: unknown = await vm.runInContext(
				`"use strict";\n(async () => {\n${code}\n})();`,
				context,
			);
			const message: CellWorkerMessage = {
				id,
				op: "result",
				ok: true,
				output: consoleBuffer.contents(),
			};
			const returnValue = serializeReturnValue(value);
			if (returnValue !== undefined) message.returnValue = returnValue;
			input.write(JSON.stringify(message));
		} catch (err) {
			const infrastructure = typeof err === "object" && err !== null && infraErrors.has(err);
			input.write(
				JSON.stringify({
					id,
					op: "result",
					ok: false,
					output: consoleBuffer.contents(),
					error: err instanceof Error ? err.message : String(err),
					...(infrastructure ? { infrastructure: true } : {}),
				}),
			);
		}
	}

	function handleLine(line: string): void {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const message = parsed as { id?: unknown; op?: unknown; ok?: unknown };
		if (typeof message.id !== "string") return;
		if (message.op === "cell") {
			const code = (message as { code?: unknown }).code;
			if (typeof code !== "string") {
				input.write(
					JSON.stringify({
						id: message.id,
						op: "result",
						ok: false,
						output: "",
						error: "cell request must carry string code",
					}),
				);
				return;
			}
			if (cellRunning) {
				input.write(
					JSON.stringify({
						id: message.id,
						op: "result",
						ok: false,
						output: "",
						error: "a cell is already running; cells are serialized per agent",
					}),
				);
				return;
			}
			const programs = (message as { programs?: unknown }).programs;
			cellRunning = true;
			// Detached on purpose: the loop must keep reading ambient responses.
			void executeCell(
				message.id,
				code,
				Array.isArray(programs) ? (programs as WorkerProgram[]) : undefined,
			).finally(() => {
				cellRunning = false;
			});
			return;
		}
		if (typeof message.ok === "boolean") {
			const pending = pendingAmbient.get(message.id);
			if (pending === undefined) return;
			pendingAmbient.delete(message.id);
			if (message.ok) pending.resolve((message as { result?: unknown }).result);
			else {
				const err = new Error(String((message as { error?: unknown }).error));
				if ((message as { infrastructure?: unknown }).infrastructure === true) {
					infraErrors.add(err);
				}
				pending.reject(err);
			}
		}
	}

	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of input.lines) {
		buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			handleLine(buffered.slice(0, newline));
			buffered = buffered.slice(newline + 1);
			newline = buffered.indexOf("\n");
		}
	}
	if (buffered.length > 0) handleLine(buffered);
}

/** Subprocess entry: serve real stdio until the parent's pipe closes. */
export async function runCellWorkerFromStdio(): Promise<number> {
	await runCellWorker({
		lines: process.stdin,
		write: (line) => process.stdout.write(`${line}\n`),
	});
	return 0;
}

if (import.meta.main) {
	process.exit(await runCellWorkerFromStdio());
}
