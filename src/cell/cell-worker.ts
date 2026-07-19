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

export type CellWorkerRequest = { id: string; op: "cell"; code: string };

/** Parent's answer to one ambient request, correlated by the worker's id. */
export type CellAmbientResponse =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; error: string };

export type CellWorkerMessage =
	| { id: string; op: "ambient"; method: string; args: unknown[] }
	| {
			id: string;
			op: "result";
			ok: boolean;
			output: string;
			returnValue?: string;
			error?: string;
	  };

/**
 * Runtime globals shadowed to undefined inside the realm. Everything that
 * grants fs/exec/network in a Bun-hosted process (spec §4: cells hold no exec
 * grant); setTimeout/setInterval stay available — plain JS timing is
 * legitimate and the budget clock bounds it.
 */
const SHADOWED_GLOBALS = [
	"Bun",
	"process",
	"require",
	"module",
	"exports",
	"global",
	"globalThis",
	"fetch",
	"XMLHttpRequest",
	"WebSocket",
	"Worker",
	"Deno",
	"__dirname",
	"__filename",
] as const;

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
	let ambientSeq = 0;
	let cellRunning = false;

	function callAmbient(method: string, args: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = `ambient-${++ambientSeq}`;
			pendingAmbient.set(id, { resolve, reject });
			input.write(JSON.stringify({ id, op: "ambient", method, args }));
		});
	}

	async function executeCell(id: string, code: string): Promise<void> {
		const consoleBuffer = new ConsoleBuffer();
		const rejection = rejectImportRequire(code);
		if (rejection !== undefined) {
			input.write(JSON.stringify({ id, op: "result", ok: false, output: "", error: rejection }));
			return;
		}
		const cellConsole = {
			log: (...args: unknown[]) => consoleBuffer.append(args),
			warn: (...args: unknown[]) => consoleBuffer.append(args),
			error: (...args: unknown[]) => consoleBuffer.append(args),
		};
		const ambient: Record<string, unknown> = { console: cellConsole };
		for (const method of AMBIENT_METHODS) {
			ambient[method] = (...args: unknown[]) => callAmbient(method, args);
		}
		// The spawn surface (spec §4): handles are worker-side wrappers around
		// plain handle IDs; every operation proxies to the parent, which maps
		// outcomes per the spawn contract (infrastructure errors arrive as
		// ambient rejections and throw in-cell).
		type SpawnWire = {
			kind: "completed" | "started";
			ok?: boolean;
			summary?: string;
			bindings?: unknown[];
			handleId: string;
		};
		const makeHandle = (id: string): Record<string, unknown> => ({
			id,
			wait: async () => wrapOutcome((await callAmbient("handle_wait", [id])) as SpawnWire),
			message: async (text: string, opts?: unknown) =>
				wrapOutcome((await callAmbient("handle_message", [id, text, opts])) as SpawnWire),
		});
		const wrapOutcome = (wire: SpawnWire): Record<string, unknown> => {
			const handle = makeHandle(wire.handleId);
			if (wire.kind === "started") return { handle };
			return { ok: wire.ok, summary: wire.summary, bindings: wire.bindings, handle };
		};
		ambient.spawn = async (agent: unknown, goal: unknown, opts?: unknown) =>
			wrapOutcome((await callAmbient("spawn", [agent, goal, opts])) as SpawnWire);
		ambient.handle = (id: unknown) => {
			if (typeof id !== "string") throw new Error("handle(id): id must be a string");
			return makeHandle(id);
		};
		try {
			// The realm: shadowed globals become undefined parameters, the
			// ambient API becomes named parameters, and the body runs inside an
			// async IIFE so top-level await works. The cell's value is its
			// `return` statement — a documented simplification (a true
			// completion-value REPL needs eval, which the realm bans).
			const realmFn = new Function(
				...SHADOWED_GLOBALS,
				...Object.keys(ambient),
				`"use strict"; return (async () => {\n${code}\n})();`,
			);
			const value: unknown = await realmFn(
				...SHADOWED_GLOBALS.map(() => undefined),
				...Object.values(ambient),
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
			input.write(
				JSON.stringify({
					id,
					op: "result",
					ok: false,
					output: consoleBuffer.contents(),
					error: err instanceof Error ? err.message : String(err),
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
			cellRunning = true;
			// Detached on purpose: the loop must keep reading ambient responses.
			void executeCell(message.id, code).finally(() => {
				cellRunning = false;
			});
			return;
		}
		if (typeof message.ok === "boolean") {
			const pending = pendingAmbient.get(message.id);
			if (pending === undefined) return;
			pendingAmbient.delete(message.id);
			if (message.ok) pending.resolve((message as { result?: unknown }).result);
			else pending.reject(new Error(String((message as { error?: unknown }).error)));
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
