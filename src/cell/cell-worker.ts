/**
 * Cell worker subprocess entry (sap spec §4). Each agent process owns ONE cell
 * worker (Phase 5 design decision): cells execute here, in a stripped realm,
 * and every ambient op is proxied to the PARENT over stdio — the worker holds
 * no store credentials and no channel token. The parent's stdin pipe is the
 * lease: when the owner dies the pipe closes, the line loop ends, and the
 * worker exits.
 *
 * The realm itself lives behind the CellEngine seam (cell-engine.ts): node:vm
 * today, QuickJS-WASM at P3 cutover. This module owns everything
 * engine-agnostic — the line protocol, ambient correlation, infra-error
 * identity bookkeeping, console buffering, and return serialization.
 *
 * Protocol (stdio JSONL, mirroring the store worker, plus worker-initiated
 * ambient requests):
 *   parent → worker: { id, op: "cell", code }
 *   worker → parent: { id, op: "ambient", method, args }   (worker-initiated)
 *   parent → worker: { id, ok, result | error }             (ambient response)
 *   worker → parent: { id, op: "result", ok, output, returnValue?, error? }
 */

import type { WorkerProgram } from "./cell-bootstrap.ts";
import { type CellEngine, createCellEngine, resolveCellEngineName } from "./cell-engine.ts";

export { AMBIENT_METHODS, type WorkerProgram } from "./cell-bootstrap.ts";

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

export interface RunCellWorkerInput {
	/** Raw stdin chunks (or pre-split lines); split on \n internally. */
	lines: AsyncIterable<string | Uint8Array>;
	/** Emit one message line (newline handled by the caller's transport). */
	write: (line: string) => void;
	/** Engine override for tests; defaults to SPROUT_CELL_ENGINE (vm). */
	engine?: CellEngine;
}

/**
 * Serve cells over a line protocol. Separated from real stdio so the protocol
 * is testable in-process. The line loop must NOT await cell execution: a
 * running cell awaits ambient responses that arrive as later lines, so cells
 * start detached and the loop keeps reading. The parent serializes cells; a
 * second cell arriving while one runs is refused loudly rather than queued.
 */
export async function runCellWorker(input: RunCellWorkerInput): Promise<void> {
	const engine = input.engine ?? (await createCellEngine(resolveCellEngineName()));
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
		// An engine THROW (as opposed to an error result) is an engine bug or a
		// wasm-load failure — host infrastructure, never the cell's fault. The
		// worker must survive it and say so.
		const result = await engine
			.runCell({
				code,
				programs,
				callAmbient,
				isInfraError: (err) => typeof err === "object" && err !== null && infraErrors.has(err),
				log: (args) => consoleBuffer.append(args),
			})
			.catch((err: unknown) => ({
				ok: false as const,
				error: `cell engine failure: ${err instanceof Error ? err.message : String(err)}`,
				infrastructure: true,
			}));
		if (result.ok) {
			const message: CellWorkerMessage = {
				id,
				op: "result",
				ok: true,
				output: consoleBuffer.contents(),
			};
			if (result.returnValue !== undefined) message.returnValue = result.returnValue;
			input.write(JSON.stringify(message));
		} else {
			input.write(
				JSON.stringify({
					id,
					op: "result",
					ok: false,
					output: consoleBuffer.contents(),
					error: result.error,
					...(result.infrastructure ? { infrastructure: true } : {}),
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
