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
 *
 * SECURITY POSTURE (Phase 7, for operators and reviewers): the RSS watchdog
 * is BEST-EFFORT memory limiting, not a hard cap — a burst allocation can
 * outrun the 250 ms poll before the SIGKILL lands, and RSS is only a proxy for
 * true commitment. Likewise the budget clock kills a runaway cell; it does not
 * prevent one. These guards bound accidents and runaways from model-authored
 * code; they are not a defense against a determined same-UID attacker (see the
 * realm doc in cell-worker.ts). The fails-closed replacement is the
 * QuickJS-WASM port, tracked as prime-radiant-inc/sprout#1.
 */

import { readFile } from "node:fs/promises";
import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";
import type { StoreAccess } from "../store/store-access.ts";
import { buildInternalSproutCommand } from "../util/self-command.ts";
import { resolveCellEngineName } from "./cell-engine.ts";
import type { CellWorkerMessage, WorkerProgram } from "./cell-worker.ts";

/** Default cell wall-time budget (non-parked; spec §4). */
export const DEFAULT_CELL_BUDGET_MS = 5_000;

/** Default worker RSS budget before the watchdog kills it. */
export const DEFAULT_CELL_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * Worker-baseline headroom the RSS watchdog grants ABOVE the memory budget
 * when the QuickJS engine enforces the budget in-realm (P2). Process RSS is a
 * strict superset of the realm heap — bun runtime plus the wasm engine
 * measured at ~81 MB baseline (2026-07-20) — and wasm linear memory is
 * high-water-mark, never returned to the OS. With the same number for both,
 * the outer net would fire BEFORE the byte-precise inner cap ever engaged.
 * Under the vm engine the watchdog stays AT the budget: there it is the only
 * memory guard, so it must not loosen during the migration window.
 */
export const WORKER_RSS_HEADROOM_BYTES = 256 * 1024 * 1024;

export function resolveWorkerRssKillBytes(
	memoryBudgetBytes: number,
	env: Record<string, string | undefined> = process.env,
): number {
	return resolveCellEngineName(env) === "quickjs"
		? memoryBudgetBytes + WORKER_RSS_HEADROOM_BYTES
		: memoryBudgetBytes;
}

/** Ambient get()/parse() materialization budget (spec §4: default 1 MB). */
export const CELL_GET_BUDGET_BYTES = 1024 * 1024;

/**
 * Above this many chars, cell stdout / return values auto-bind into the store
 * and the transcript carries a marker naming the value instead.
 */
export const CELL_AUTO_BIND_THRESHOLD = 2_000;

const BUDGET_POLL_INTERVAL_MS = 100;
const RSS_POLL_INTERVAL_MS = 250;

/** Max spawns per cell (spec §4). Parent-enforced; past it, spawn() throws. */
export const CELL_SPAWN_CAP = 64;

/**
 * Max ambient calls a cell may have outstanding at once. A cell that fires
 * ambient ops without awaiting keeps them parked (parked time never accrues on
 * the budget clock), so an unbounded flood would leak the pending map; past the
 * cap the ambient request rejects in-cell. The RSS watchdog is the ultimate net
 * for any pathological flood that slips under this cap.
 */
export const CELL_MAX_OUTSTANDING_AMBIENT = 256;

/** One cell-originated spawn request, decoded from the ambient spawn() call. */
export interface CellSpawnRequest {
	agent: string;
	goal: string;
	env?: Record<string, string>;
	hints?: string[];
	blocking?: boolean;
	shared?: boolean;
	model?: string;
}

/**
 * The typed outcome envelope (spec §4 deviation #5). The delegation core in
 * the owning agent returns exactly one of these; the cell maps
 * infrastructure_error to an in-cell rejection, and completed/started resolve
 * with the spawn contract's value regardless of child success.
 */
export type DelegationOutcome =
	| { kind: "infrastructure_error"; reason: string }
	| {
			kind: "completed";
			/** Child success — never a rejection channel (spawn contract). */
			ok: boolean;
			/** Manifest-rewritten child output, published/renamed lines included. */
			summary: string;
			/** The manifest delta's delivered values. */
			bindings: CellBindingSummary[];
			handleId: string;
			stumbles: number;
			/** Tool-path renderer aid: the child's untruncated raw output. */
			rawOutput?: string;
	  }
	| { kind: "started"; handleId: string };

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
	/**
	 * Cell spawn servicing (spec §4): the owning agent wires these to its
	 * delegation core / spawner. Hosts without them (store-only hosts, tests)
	 * give cells a clean "spawn is unavailable here" error.
	 */
	delegate?: (req: CellSpawnRequest) => Promise<DelegationOutcome>;
	waitHandle?: (id: string) => Promise<DelegationOutcome>;
	messageHandle?: (
		id: string,
		text: string,
		opts?: { env?: Record<string, string>; blocking?: boolean },
	) => Promise<DelegationOutcome>;
	/**
	 * Genome programs (spec §7) exposed to the cell realm as `programs.<name>`.
	 * Sent with every cell request so the worker builds the namespace from
	 * in-context source. Fixed per agent (its genome's validated programs).
	 */
	programs?: WorkerProgram[];
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
	error?: { message: string; scopeNames: string[]; infrastructure?: boolean };
	/**
	 * Stumble accounting (spec §4): failed-child count + 1 if the cell itself
	 * errored for a non-child, non-infrastructure reason. Infrastructure
	 * failures (spawn transport, worker death) count zero.
	 */
	stumbleCount: number;
	metrics: { computeTimeMs: number; totalMs: number };
}

interface RunningCell {
	id: string;
	resolve: (msg: CellWorkerMessage & { op: "result" }) => void;
	/** Set when a guard killed the worker; overrides the exit-path error. */
	killReason?: string;
}

/** One registered future: settles when its wait resolves; reject reclaims it. */
interface PendingFuture {
	/** Resolves after the settled value is bound; rejects on wait failure/reclaim. */
	settled: Promise<void>;
	reject: (err: unknown) => void;
}

/**
 * Ambient value ops that take a value name/ulid as args[0] — a pending future
 * bound to that name pipelines here (the consumer awaits settlement first).
 * bind (a NEW name), spawn, and handle_wait/message (a handle id) are excluded.
 */
const FUTURE_REF_CONSUMING: ReadonlySet<string> = new Set([
	"publish",
	"peek",
	"size",
	"slice",
	"lines",
	"grep",
	"get",
	"parse",
]);

export class CellHost {
	private readonly store: StoreAccess;
	private readonly budgetMs: number;
	private readonly memoryBudgetBytes: number;
	private readonly rssKillBytes: number;
	private readonly spawnFn: () => CellWorkerProcessHandle;
	private worker: CellWorkerProcessHandle | undefined;
	/** Bumped per spawn so a stale worker's exit cannot fail a fresh cell. */
	private generation = 0;
	private cellSeq = 0;
	private running: RunningCell | undefined;
	private outstandingAmbient = 0;
	private newBindings: CellBindingSummary[] = [];
	private readonly delegate?: (req: CellSpawnRequest) => Promise<DelegationOutcome>;
	private readonly waitHandle?: (id: string) => Promise<DelegationOutcome>;
	private readonly messageHandle?: (
		id: string,
		text: string,
		opts?: { env?: Record<string, string>; blocking?: boolean },
	) => Promise<DelegationOutcome>;
	/** Spawns issued by the running cell, against CELL_SPAWN_CAP. */
	private cellSpawnCount = 0;
	/** Handles whose child failure already counted toward stumbleCount. */
	private failedChildHandles = new Set<string>();
	/**
	 * Futures registered by the running cell (spec §2): a started child's
	 * eventual outcome, bound to a NAME without the cell awaiting it. A consumer
	 * of that name pipelines on `settled` (registers as a dependent on the wait)
	 * instead of erroring on an unbound name. Reset per cell; a settlement whose
	 * cell has ended is dropped by generation guard, and killRunning/cell-end
	 * reclaim any still-pending entries.
	 */
	private pendingFutures = new Map<string, PendingFuture>();
	/** Bumped per cell so a stale future settlement cannot mutate a fresh cell. */
	private cellGen = 0;
	/** Promise-chain mutex: cells are serialized per host (spec §4). */
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;
	private readonly programs?: WorkerProgram[];

	constructor(store: StoreAccess, options: CellHostOptions = {}) {
		this.store = store;
		this.budgetMs = options.budgetMs ?? DEFAULT_CELL_BUDGET_MS;
		this.memoryBudgetBytes = options.memoryBudgetBytes ?? DEFAULT_CELL_MEMORY_BUDGET_BYTES;
		this.rssKillBytes = resolveWorkerRssKillBytes(this.memoryBudgetBytes);
		this.spawnFn = options.spawnFn ?? (() => spawnCellWorkerProcess());
		this.delegate = options.delegate;
		this.waitHandle = options.waitHandle;
		this.messageHandle = options.messageHandle;
		if (options.programs !== undefined && options.programs.length > 0) {
			this.programs = options.programs;
		}
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
		this.cellSpawnCount = 0;
		this.failedChildHandles = new Set();
		this.reclaimFutures("future superseded by a new cell");

		const worker = this.ensureWorker();
		const startedAt = Date.now();
		let computeMs = 0;
		let lastTick = startedAt;

		const raw = await new Promise<CellWorkerMessage & { op: "result" }>((resolve) => {
			this.running = { id, resolve };
			// The authoritative budget clock: accrue only while nothing ambient
			// is outstanding. The tick interval bounds accrual resolution; a
			// wedged sync loop keeps outstandingAmbient at 0 and dies here. A
			// cell that floods un-awaited ambient calls parks the clock instead;
			// CELL_MAX_OUTSTANDING_AMBIENT caps that, and the RSS watchdog below
			// is the ultimate net for any pathological flood that slips under it.
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
					if (rss !== undefined && rss > this.rssKillBytes) {
						this.killRunning(
							`cell memory budget exceeded (rss ${rss} > ${this.rssKillBytes} bytes)`,
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
			worker.send(
				`${JSON.stringify({
					id,
					op: "cell",
					code,
					...(this.programs ? { programs: this.programs } : {}),
					limits: { memoryBytes: this.memoryBudgetBytes, budgetMs: this.budgetMs },
				})}\n`,
			);
		});

		// Any future the cell registered but never let settle is abandoned at
		// cell end and reclaimed (spec §2). A settlement whose wait resolves from
		// here on is dropped by the pre-bind generation guard in registerFuture
		// (see that method for the one residual bind-round-trip window).
		this.reclaimFutures("future abandoned at cell end");
		const totalMs = Date.now() - startedAt;
		const metrics = { computeTimeMs: computeMs, totalMs };
		const newBindings = this.newBindings;
		const output = await this.gateForTranscript(raw.output, `cell_${cellNumber}_output`);
		// A cell failure is infrastructure only when the HOST raised it: worker
		// death, a budget/RSS kill, or an infra ambient rejection (spawn
		// transport, StoreUnavailable) the code left uncaught. Each of those
		// tags `raw.infrastructure` at its raise site (the worker tracks the
		// uncaught-rejection case by object identity), so a cell that throws an
		// error whose message merely LOOKS like infrastructure counts as a
		// stumble. Those host-raised failures count zero stumbles (spec §4).
		const infrastructure = !raw.ok && raw.infrastructure === true;
		const stumbleCount = this.failedChildHandles.size + (!raw.ok && !infrastructure ? 1 : 0);
		const result: CellResult = { ok: raw.ok, output, newBindings, stumbleCount, metrics };
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
				...(infrastructure ? { infrastructure: true } : {}),
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
		this.reclaimFutures(reason);
		this.generation++;
		this.worker?.kill();
		this.worker = undefined;
		running.resolve({
			id: running.id,
			op: "result",
			ok: false,
			output: "",
			error: reason,
			infrastructure: true,
		});
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
				infrastructure: true,
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
			if (this.outstandingAmbient >= CELL_MAX_OUTSTANDING_AMBIENT) {
				this.respondAmbient(message.id, {
					ok: false,
					error:
						`too many concurrent ambient operations (cap ${CELL_MAX_OUTSTANDING_AMBIENT}); ` +
						"await your ambient calls before issuing more",
				});
				return;
			}
			this.outstandingAmbient++;
			void this.serviceAmbient(message.method, message.args)
				.then((result) => this.respondAmbient(message.id, { ok: true, result }))
				.catch((err) =>
					this.respondAmbient(message.id, {
						ok: false,
						error: err instanceof Error ? err.message : String(err),
						...(isInfrastructureError(err) ? { infrastructure: true } : {}),
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
		response:
			| { ok: true; result: unknown }
			| { ok: false; error: string; infrastructure?: boolean },
	): void {
		this.worker?.send(`${JSON.stringify({ id, ...response })}\n`);
	}

	/**
	 * The ambient value API over the owner's StoreAccess (spec §4). Results
	 * return RAW to the cell — redaction is an above-the-line gate, and cell
	 * code runs below the line.
	 */
	private async serviceAmbient(method: string, args: unknown[]): Promise<unknown> {
		// $ref pipelining (spec §2): a value op naming a not-yet-settled future
		// registers as a dependent on its wait and resumes when it settles — no
		// busy-await in the cell. After settlement the value is a normal store
		// value and the op below resolves it exactly as any settled ref.
		if (FUTURE_REF_CONSUMING.has(method) && typeof args[0] === "string") {
			const future = this.pendingFutures.get(args[0]);
			if (future !== undefined) await future.settled;
		}
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
			case "spawn": {
				if (!this.delegate) throw new Error("spawn is unavailable here (no delegation runtime)");
				const agent = args[0];
				const goal = args[1];
				if (typeof agent !== "string" || typeof goal !== "string") {
					throw new Error("spawn(agent, goal, opts?): agent and goal must be strings");
				}
				if (++this.cellSpawnCount > CELL_SPAWN_CAP) {
					throw new Error(
						`cell spawn cap exceeded: at most ${CELL_SPAWN_CAP} spawns per cell. ` +
							"Batch the work into fewer children or split across cells.",
					);
				}
				const opts = (args[2] ?? {}) as CellSpawnRequest;
				const request: CellSpawnRequest = {
					agent,
					goal,
					...(opts.env !== undefined ? { env: opts.env } : {}),
					...(opts.hints !== undefined ? { hints: opts.hints } : {}),
					...(opts.blocking !== undefined ? { blocking: opts.blocking } : {}),
					...(opts.shared !== undefined ? { shared: opts.shared } : {}),
					...(opts.model !== undefined ? { model: opts.model } : {}),
				};
				return this.consumeOutcome(await this.delegate(request));
			}
			case "handle_wait": {
				if (!this.waitHandle)
					throw new Error("handle.wait() is unavailable here (no delegation runtime)");
				return this.consumeOutcome(await this.waitHandle(refArg(args, "handle_wait")));
			}
			case "handle_message": {
				if (!this.messageHandle)
					throw new Error("handle.message() is unavailable here (no delegation runtime)");
				const id = refArg(args, "handle_message");
				const text = args[1];
				if (typeof text !== "string")
					throw new Error("handle.message(text, opts?): text must be a string");
				const opts = (args[2] ?? {}) as { env?: Record<string, string>; blocking?: boolean };
				return this.consumeOutcome(await this.messageHandle(id, text, opts));
			}
			case "handle_future": {
				if (!this.waitHandle)
					throw new Error("handle.future() is unavailable here (no delegation runtime)");
				const id = refArg(args, "handle_future");
				const name = args[1];
				if (typeof name !== "string") throw new Error("handle.future(name): name must be a string");
				return this.registerFuture(id, name);
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

	/**
	 * Apply the spawn contract to a delegation outcome (spec §4): an
	 * infrastructure error becomes an in-cell rejection (its reason recorded so
	 * an uncaught one is recognized at cell end and counts zero stumbles); a
	 * completed child counts toward stumbleCount when it failed (once per
	 * handle); the wire shape for the worker carries plain data only.
	 */
	private consumeOutcome(outcome: DelegationOutcome): unknown {
		if (outcome.kind === "infrastructure_error") {
			throw infrastructureError(outcome.reason);
		}
		if (outcome.kind === "started") {
			return { kind: "started", handleId: outcome.handleId };
		}
		if (!outcome.ok && !this.failedChildHandles.has(outcome.handleId)) {
			this.failedChildHandles.add(outcome.handleId);
		}
		return {
			kind: "completed",
			ok: outcome.ok,
			summary: outcome.summary,
			bindings: outcome.bindings,
			handleId: outcome.handleId,
		};
	}

	/**
	 * Register a future (spec §2): bind a started child's eventual outcome to
	 * `name` without awaiting it. The wait rides the existing mechanism
	 * (waitHandle); on settlement the child's summary binds as a NORMAL immutable
	 * value (provenance origin `delegation`, truthfully naming the wait), and any
	 * consumer parked on this future resumes. The settled value's ULID is minted
	 * at bind and stable forever after.
	 *
	 * Cell-end and the generation guard: a settlement whose cell has already
	 * ended when its wait resolves is dropped by the pre-bind generation check —
	 * the value is not bound and no stale cell state is touched. One residual
	 * micro-window remains: if the cell ends DURING the store.bind round-trip
	 * (after the pre-bind check passed), the value has already been written to
	 * the store under `name`, and because names are latest-wins per scope a
	 * delegation-origin orphan can become visible to the next cell. It is never
	 * pushed to newBindings (that guard still fires), so it does not appear in
	 * the ending cell's result; the exposure is bounded to that one bind
	 * round-trip and is not a security issue. Fully closing it would require
	 * threading the cell generation into the store worker (crossing the
	 * immutability line), which is disproportionate to the risk.
	 */
	private registerFuture(handleId: string, name: string): { name: string; pending: true } {
		if (this.pendingFutures.has(name)) {
			throw new Error(`a future is already bound to "${name}" in this cell`);
		}
		const waitHandle = this.waitHandle;
		if (!waitHandle) {
			throw new Error("handle.future() is unavailable here (no delegation runtime)");
		}
		const myGen = this.cellGen;
		let resolveSettled!: () => void;
		let rejectSettled!: (err: unknown) => void;
		const settled = new Promise<void>((resolve, reject) => {
			resolveSettled = resolve;
			rejectSettled = reject;
		});
		// A future with no consumer must not surface an unhandled rejection when
		// it is reclaimed; consumers attach their own await/catch.
		settled.catch(() => {});
		this.pendingFutures.set(name, { settled, reject: rejectSettled });
		void (async () => {
			try {
				const outcome = await waitHandle(handleId);
				if (this.cellGen !== myGen) {
					rejectSettled(new Error("future abandoned: cell ended before settlement"));
					return;
				}
				// consumeOutcome throws an infrastructure error for an infra outcome
				// and records a failed child's stumble, matching an in-cell wait.
				const wire = this.consumeOutcome(outcome) as { summary?: string };
				const metadata = await this.store.bind({
					name,
					content: wire.summary ?? "",
					type: "text",
					provenance: { agentHandleId: "", origin: { kind: "delegation" } },
					explicit: true,
				});
				if (this.cellGen === myGen) {
					this.newBindings.push({
						name: metadata.name,
						ulid: metadata.ulid,
						size: metadata.size,
						preview: metadata.preview,
					});
				}
				resolveSettled();
			} catch (err) {
				rejectSettled(err);
			} finally {
				if (this.cellGen === myGen) this.pendingFutures.delete(name);
			}
		})();
		return { name, pending: true };
	}

	/**
	 * Reclaim every still-pending future: bump the generation so any in-flight
	 * settlement is dropped, reject the parked consumers with `reason`, and clear
	 * the map. Called at cell start, cell end, and on a guard kill.
	 */
	private reclaimFutures(reason: string): void {
		this.cellGen++;
		for (const future of this.pendingFutures.values()) {
			future.reject(new Error(reason));
		}
		this.pendingFutures.clear();
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

/** An error the host raised as infrastructure (spawn transport, worker death). */
function infrastructureError(reason: string): Error {
	const err = new Error(reason);
	(err as { infrastructure?: boolean }).infrastructure = true;
	return err;
}

/** True for host infrastructure errors: our tagged errors and StoreUnavailable. */
function isInfrastructureError(err: unknown): boolean {
	return err instanceof Error && (err as { infrastructure?: unknown }).infrastructure === true;
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
