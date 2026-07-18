/**
 * Parent-side cell host (sap spec §4). Owns ONE lazily-spawned cell-worker
 * subprocess, serializes cells, services the worker's ambient requests through
 * the OWNER's StoreAccess (the worker holds no credentials), and enforces the
 * two guards the worker cannot enforce on itself:
 *
 * - Budget clock: the parent owns the authoritative clock because ambient
 *   calls flow THROUGH it — a 100 ms checker accrues wall time only while no
 *   ambient request is outstanding (parked time never accrues), and on exceed
 *   SIGKILLs the worker. A wedged sync loop cannot be interrupted in-process;
 *   the kill is the only real enforcement.
 * - RSS watchdog: 250 ms poll of the worker's resident set (/proc on Linux,
 *   `ps -o rss=` elsewhere), SIGKILL over the memory budget (default 512 MB).
 *
 * A killed worker respawns lazily on the next cell.
 */

import { readFile } from "node:fs/promises";
import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";
import type { StoreAccess } from "../store/store-access.ts";
import { buildInternalSproutCommand } from "../util/self-command.ts";
import type { CellWorkerMessage } from "./cell-worker.ts";

/** Default cell wall-time budget (non-parked; spec §4). */
export const DEFAULT_CELL_BUDGET_MS = 5_000;

/** Default worker RSS budget before the watchdog kills it. */
export const DEFAULT_CELL_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

/** Ambient get()/parse() materialization budget (spec §4: default 1 MB). */
export const CELL_GET_BUDGET_BYTES = 1024 * 1024;

/**
 * Above this many chars, cell stdout / return values auto-bind into the store
 * and the transcript carries a marker naming the value instead.
 */
export const CELL_AUTO_BIND_THRESHOLD = 2_000;

const BUDGET_POLL_INTERVAL_MS = 100;
const RSS_POLL_INTERVAL_MS = 250;

/** Minimal worker process surface — real Bun.spawn or an in-process test fake. */
export interface CellWorkerProcessHandle {
	pid?: number;
	send(line: string): void;
	kill(): void;
	onLine(handler: (line: string) => void): void;
	onExit(handler: () => void): void;
}

export interface CellHostOptions {
	budgetMs?: number;
	memoryBudgetBytes?: number;
	spawnFn?: () => CellWorkerProcessHandle;
}

export interface CellBindingSummary {
	name: string;
	ulid: string;
	size: number;
	preview: string;
}

export interface CellResult {
	ok: boolean;
	/** Captured console output — redacted, auto-bound over the threshold. */
	output: string;
	/** The cell's returned value — redacted, auto-bound over the threshold. */
	returnValue?: string;
	/** Values bind() created during this cell, in call order. */
	newBindings: CellBindingSummary[];
	error?: { message: string; scopeNames: string[] };
	metrics: { computeTimeMs: number; totalMs: number };
}

interface RunningCell {
	id: string;
	resolve: (msg: CellWorkerMessage & { op: "result" }) => void;
	/** Set when a guard killed the worker; overrides the exit-path error. */
	killReason?: string;
}

export class CellHost {
	private readonly store: StoreAccess;
	private readonly budgetMs: number;
	private readonly memoryBudgetBytes: number;
	private readonly spawnFn: () => CellWorkerProcessHandle;
	private worker: CellWorkerProcessHandle | undefined;
	/** Bumped per spawn so a stale worker's exit cannot fail a fresh cell. */
	private generation = 0;
	private cellSeq = 0;
	private running: RunningCell | undefined;
	private outstandingAmbient = 0;
	private newBindings: CellBindingSummary[] = [];
	/** Promise-chain mutex: cells are serialized per host (spec §4). */
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;

	constructor(store: StoreAccess, options: CellHostOptions = {}) {
		this.store = store;
		this.budgetMs = options.budgetMs ?? DEFAULT_CELL_BUDGET_MS;
		this.memoryBudgetBytes = options.memoryBudgetBytes ?? DEFAULT_CELL_MEMORY_BUDGET_BYTES;
		this.spawnFn = options.spawnFn ?? (() => spawnCellWorkerProcess());
	}

	runCell(code: string): Promise<CellResult> {
		const result = this.tail.then(() => this.runCellSerialized(code));
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	shutdown(): void {
		this.closed = true;
		this.generation++;
		this.worker?.kill();
		this.worker = undefined;
	}

	private async runCellSerialized(code: string): Promise<CellResult> {
		if (this.closed) throw new Error("cell host is shut down");
		const cellNumber = ++this.cellSeq;
		const id = `cell-${cellNumber}`;
		this.newBindings = [];
		this.outstandingAmbient = 0;

		const worker = this.ensureWorker();
		const startedAt = Date.now();
		let computeMs = 0;
		let lastTick = startedAt;

		const raw = await new Promise<CellWorkerMessage & { op: "result" }>((resolve) => {
			this.running = { id, resolve };
			// The authoritative budget clock: accrue only while nothing ambient
			// is outstanding. The tick interval bounds accrual resolution; a
			// wedged sync loop keeps outstandingAmbient at 0 and dies here.
			const budgetTimer = setInterval(() => {
				const now = Date.now();
				if (this.outstandingAmbient === 0) computeMs += now - lastTick;
				lastTick = now;
				if (computeMs > this.budgetMs) {
					this.killRunning(`cell budget exceeded (${this.budgetMs} ms of compute time)`);
				}
			}, BUDGET_POLL_INTERVAL_MS);
			const rssTimer = setInterval(() => {
				const pid = this.worker?.pid;
				if (pid === undefined) return;
				void readRssBytes(pid).then((rss) => {
					if (rss !== undefined && rss > this.memoryBudgetBytes) {
						this.killRunning(
							`cell memory budget exceeded (rss ${rss} > ${this.memoryBudgetBytes} bytes)`,
						);
					}
				});
			}, RSS_POLL_INTERVAL_MS);
			const settle = resolve;
			this.running.resolve = (msg) => {
				clearInterval(budgetTimer);
				clearInterval(rssTimer);
				this.running = undefined;
				settle(msg);
			};
			worker.send(`${JSON.stringify({ id, op: "cell", code })}\n`);
		});

		const totalMs = Date.now() - startedAt;
		const metrics = { computeTimeMs: computeMs, totalMs };
		const newBindings = this.newBindings;
		const output = await this.gateForTranscript(raw.output, `cell_${cellNumber}_output`);
		const result: CellResult = { ok: raw.ok, output, newBindings, metrics };
		if (raw.returnValue !== undefined) {
			result.returnValue = await this.gateForTranscript(
				raw.returnValue,
				`cell_${cellNumber}_return`,
			);
		}
		if (!raw.ok) {
			result.error = {
				message: redactSensitiveTranscriptContent(raw.error ?? "cell failed"),
				scopeNames: await this.store.names().catch(() => [] as string[]),
			};
		}
		// The journal record (spec §4): redacted AT WRITE in the engine.
		await this.store.recordCell({
			code,
			bindings: newBindings.map(({ name, ulid }) => ({ name, ulid })),
			computeTimeMs: computeMs,
			...(result.error !== undefined ? { error: result.error.message } : {}),
		});
		return result;
	}

	/**
	 * The above-the-line gate (spec §4): redact, then auto-bind past the
	 * threshold with a marker naming the bound value. The store keeps the RAW
	 * content (reads re-redact); a failed bind degrades to honest truncation.
	 */
	private async gateForTranscript(content: string, bindName: string): Promise<string> {
		const redacted = redactSensitiveTranscriptContent(content);
		if (redacted.length <= CELL_AUTO_BIND_THRESHOLD) return redacted;
		try {
			const metadata = await this.store.bind({
				name: bindName,
				content,
				type: "text",
				provenance: { agentHandleId: "", origin: { kind: "cell" } },
				explicit: false,
			});
			return `${redacted.slice(0, CELL_AUTO_BIND_THRESHOLD)}\n[... ${redacted.length - CELL_AUTO_BIND_THRESHOLD} chars truncated — full content: ⟦${metadata.name}⟧]`;
		} catch {
			return `${redacted.slice(0, CELL_AUTO_BIND_THRESHOLD)}\n[... ${redacted.length - CELL_AUTO_BIND_THRESHOLD} chars truncated; capture failed — content not captured]`;
		}
	}

	/** Guard kill: fail the running cell with `reason`, SIGKILL the worker. */
	private killRunning(reason: string): void {
		const running = this.running;
		if (running === undefined || running.killReason !== undefined) return;
		running.killReason = reason;
		this.generation++;
		this.worker?.kill();
		this.worker = undefined;
		running.resolve({ id: running.id, op: "result", ok: false, output: "", error: reason });
	}

	private ensureWorker(): CellWorkerProcessHandle {
		if (this.worker !== undefined) return this.worker;
		this.generation++;
		const generation = this.generation;
		const worker = this.spawnFn();
		this.worker = worker;
		worker.onLine((line) => this.handleWorkerLine(line));
		worker.onExit(() => {
			if (generation !== this.generation || this.closed) return;
			this.worker = undefined;
			this.running?.resolve({
				id: this.running.id,
				op: "result",
				ok: false,
				output: "",
				error: "cell worker exited unexpectedly",
			});
		});
		return worker;
	}

	private handleWorkerLine(line: string): void {
		let message: CellWorkerMessage;
		try {
			message = JSON.parse(line) as CellWorkerMessage;
		} catch {
			return;
		}
		if (message.op === "ambient") {
			this.outstandingAmbient++;
			void this.serviceAmbient(message.method, message.args)
				.then((result) => this.respondAmbient(message.id, { ok: true, result }))
				.catch((err) =>
					this.respondAmbient(message.id, {
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					}),
				)
				.finally(() => {
					this.outstandingAmbient--;
				});
			return;
		}
		if (message.op === "result" && this.running?.id === message.id) {
			this.running.resolve(message);
		}
	}

	private respondAmbient(
		id: string,
		response: { ok: true; result: unknown } | { ok: false; error: string },
	): void {
		this.worker?.send(`${JSON.stringify({ id, ...response })}\n`);
	}

	/**
	 * The ambient value API over the owner's StoreAccess (spec §4). Results
	 * return RAW to the cell — redaction is an above-the-line gate, and cell
	 * code runs below the line.
	 */
	private async serviceAmbient(method: string, args: unknown[]): Promise<unknown> {
		switch (method) {
			case "bind": {
				const [name, value] = args;
				if (typeof name !== "string") throw new Error("bind(name, value): name must be a string");
				const isString = typeof value === "string";
				const metadata = await this.store.bind({
					name,
					content: isString ? value : JSON.stringify(value),
					type: isString ? "text" : "json",
					provenance: { agentHandleId: "", origin: { kind: "cell" } },
					explicit: true,
				});
				this.newBindings.push({
					name: metadata.name,
					ulid: metadata.ulid,
					size: metadata.size,
					preview: metadata.preview,
				});
				return metadata;
			}
			case "publish":
				await this.store.publish(refArg(args, "publish"));
				return null;
			case "peek":
				return this.store.peek(refArg(args, "peek"));
			case "size":
				return (await this.store.metadata(refArg(args, "size"))).size;
			case "slice":
			case "lines": {
				const ref = refArg(args, method);
				const start = intArg(args[1], `${method} start`);
				const end = intArg(args[2], `${method} end`);
				return this.store.slice(ref, { startLine: start, lineCount: end - start + 1 });
			}
			case "grep": {
				const ref = refArg(args, "grep");
				const pattern = args[1];
				if (typeof pattern !== "string")
					throw new Error("grep(name, pattern): pattern must be a string");
				const opts = (args[2] ?? {}) as { maxResults?: number };
				return this.store.grep(ref, pattern, {
					...(typeof opts.maxResults === "number" ? { maxResults: opts.maxResults } : {}),
				});
			}
			case "get":
				return new TextDecoder().decode(await this.materialize(refArg(args, "get"), "get"));
			case "parse": {
				const text = new TextDecoder().decode(
					await this.materialize(refArg(args, "parse"), "parse"),
				);
				return JSON.parse(text);
			}
			default:
				throw new Error(`unknown ambient method: ${method}`);
		}
	}

	/** get()/parse() share the 1 MB materialization budget, with guidance. */
	private async materialize(ref: string, method: string): Promise<Uint8Array> {
		try {
			return await this.store.get(ref, { maxBytes: CELL_GET_BUDGET_BYTES });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("exceeds read budget")) {
				throw new Error(
					`${method}("${ref}") refused: value is over the ${CELL_GET_BUDGET_BYTES}-byte materialization budget (${message}). ` +
						"Use slice()/grep() to read parts, or delegate the analysis.",
				);
			}
			throw err;
		}
	}
}

function refArg(args: unknown[], method: string): string {
	const ref = args[0];
	if (typeof ref !== "string") throw new Error(`${method}(name): name must be a string`);
	return ref;
}

function intArg(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${what} must be an integer >= 1`);
	}
	return value;
}

/**
 * The worker's resident set in bytes: /proc on Linux, `ps -o rss=` (KB) as
 * the darwin fallback. undefined when unreadable (process gone, platform odd)
 * — the watchdog treats no-reading as no-verdict, never as a kill.
 */
export async function readRssBytes(pid: number): Promise<number | undefined> {
	if (process.platform === "linux") {
		try {
			const statm = await readFile(`/proc/${pid}/statm`, "utf8");
			const resident = Number(statm.split(/\s+/)[1]);
			if (!Number.isFinite(resident)) return undefined;
			return resident * 4096;
		} catch {
			return undefined;
		}
	}
	try {
		const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const kb = Number(out.trim());
		if (!Number.isFinite(kb) || kb <= 0) return undefined;
		return kb * 1024;
	} catch {
		return undefined;
	}
}

/** Default spawn: the sprout binary's internal cell-worker subcommand. */
export function spawnCellWorkerProcess(cmd?: string[]): CellWorkerProcessHandle {
	const proc = Bun.spawn(cmd ?? buildInternalSproutCommand("cell-worker"), {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	let lineHandler: (line: string) => void = () => {};
	let exitHandler: () => void = () => {};
	void (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of proc.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				lineHandler(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
		}
	})();
	void proc.exited.then(() => exitHandler());
	return {
		pid: proc.pid,
		send(line) {
			proc.stdin.write(line);
		},
		kill() {
			proc.kill("SIGKILL");
		},
		onLine(handler) {
			lineHandler = handler;
		},
		onExit(handler) {
			exitHandler = handler;
		},
	};
}
