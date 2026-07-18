/**
 * Host-side handle on the store worker subprocess (sap spec §1: "Store ops are
 * budgeted too"). Every op carries a timeout; a timed-out op means the worker
 * may be wedged inside an uninterruptible regex application, so recovery is
 * SIGKILL + respawn (SapStore.resume in the new worker) and transparent
 * re-issue of every in-flight op — ops are idempotent: reads trivially, binds
 * by client-minted ulid. Only when restarts exhaust does an op fail, and that
 * failure is infrastructure-tagged so callers can fail a cell without counting
 * a stumble.
 */

import { buildInternalSproutCommand } from "../util/self-command.ts";
import { ulid } from "../util/ulid.ts";
import type { BindArgs, GrepResult, SapStoreOptions } from "./store.ts";
import {
	decodeWireContent,
	encodeWireContent,
	STORE_WORKER_CAS_ENV,
	STORE_WORKER_JOURNAL_ENV,
	STORE_WORKER_OPTIONS_ENV,
	STORE_WORKER_ROOT_SCOPE_ENV,
	type StoreWorkerRequest,
	type StoreWorkerResponse,
	type WireBody,
} from "./store-worker.ts";
import type { ValueMetadata } from "./value.ts";

/**
 * Store infrastructure failed (restarts exhausted or client shut down). The
 * `.infrastructure` tag is the spec's contract: callers fail the cell WITHOUT
 * counting a stumble — the store's own recovery path must never pollute the
 * fitness function.
 */
export class StoreUnavailableError extends Error {
	readonly infrastructure = true;
}

/** Minimal worker process surface — real Bun.spawn or an in-process test fake. */
export interface StoreWorkerHandle {
	send(line: string): void;
	kill(): void;
	onLine(handler: (line: string) => void): void;
	onExit(handler: () => void): void;
}

export interface StoreWorkerClientInit {
	journalPath: string;
	casRoot: string;
	rootScopeId: string;
	options?: Partial<SapStoreOptions>;
	/** Per-op timeout before the worker is presumed wedged (default 10 s). */
	opTimeoutMs?: number;
	/** Kill+respawn attempts within one op's lifetime (default 2). */
	maxRestarts?: number;
	spawnFn?: () => StoreWorkerHandle;
}

interface PendingOp {
	request: StoreWorkerRequest;
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	/** Restarts this op has survived; exhausting maxRestarts rejects it. */
	restarts: number;
}

export class StoreWorkerClient {
	private readonly opTimeoutMs: number;
	private readonly maxRestarts: number;
	private readonly spawnFn: () => StoreWorkerHandle;
	private readonly pending = new Map<string, PendingOp>();
	private worker: StoreWorkerHandle | undefined;
	/** Bumped per spawn so a stale worker's exit event cannot restart us. */
	private generation = 0;
	private closed = false;

	constructor(init: StoreWorkerClientInit) {
		this.opTimeoutMs = init.opTimeoutMs ?? 10_000;
		this.maxRestarts = init.maxRestarts ?? 2;
		this.spawnFn = init.spawnFn ?? (() => spawnStoreWorkerProcess(init));
	}

	async createScope(args: {
		scopeId: string;
		ownerHandleId: string;
		parentScopeId: string;
	}): Promise<void> {
		await this.issue({ id: ulid(), op: "createScope", ...args });
	}

	async bind(args: Omit<BindArgs, "ulid">): Promise<ValueMetadata> {
		// The client mints the value's ulid so a re-issue across a worker
		// restart dedups instead of double-binding.
		const wire = encodeWireContent(
			typeof args.content === "string" ? new TextEncoder().encode(args.content) : args.content,
			args.type,
		);
		return (await this.issue({
			id: ulid(),
			op: "bind",
			scopeId: args.scopeId,
			name: args.name,
			content: wire.content,
			encoding: wire.encoding,
			type: args.type,
			provenance: args.provenance,
			explicit: args.explicit,
			ulid: ulid(),
		})) as ValueMetadata;
	}

	async peek(scopeId: string, ref: string): Promise<string> {
		return (await this.issue({ id: ulid(), op: "peek", scopeId, ref })) as string;
	}

	async metadata(scopeId: string, ref: string): Promise<ValueMetadata> {
		return (await this.issue({ id: ulid(), op: "metadata", scopeId, ref })) as ValueMetadata;
	}

	async names(scopeId: string): Promise<string[]> {
		return (await this.issue({ id: ulid(), op: "names", scopeId })) as string[];
	}

	async get(scopeId: string, ref: string, options: { maxBytes: number }): Promise<Uint8Array> {
		const body = await this.getWire(scopeId, ref, options);
		return decodeWireContent(body.content, body.encoding);
	}

	/**
	 * The wire form of get — content plus encoding from the worker's single get
	 * op. Channel handlers use this directly so one channel get costs exactly
	 * one worker round-trip (no separate metadata op for the encoding).
	 */
	async getWire(scopeId: string, ref: string, options: { maxBytes: number }): Promise<WireBody> {
		return (await this.issue({
			id: ulid(),
			op: "get",
			scopeId,
			ref,
			maxBytes: options.maxBytes,
		})) as WireBody;
	}

	async slice(
		scopeId: string,
		ref: string,
		options: { startLine: number; lineCount: number; maxBytes?: number },
	): Promise<string> {
		return (await this.issue({ id: ulid(), op: "slice", scopeId, ref, ...options })) as string;
	}

	async grep(
		scopeId: string,
		ref: string,
		pattern: string,
		options: { maxResults?: number } = {},
	): Promise<GrepResult> {
		const request: StoreWorkerRequest = { id: ulid(), op: "grep", scopeId, ref, pattern };
		if (options.maxResults !== undefined) request.maxResults = options.maxResults;
		return (await this.issue(request)) as GrepResult;
	}

	async publish(scopeId: string, ref: string): Promise<void> {
		await this.issue({ id: ulid(), op: "publish", scopeId, ref });
	}

	/** Kill the worker and reject everything in flight as infrastructure. */
	async shutdown(): Promise<void> {
		this.closed = true;
		this.generation++;
		this.worker?.kill();
		this.worker = undefined;
		for (const [id, op] of this.pending) {
			clearTimeout(op.timer);
			this.pending.delete(id);
			op.reject(new StoreUnavailableError("store client shut down"));
		}
	}

	private issue(request: StoreWorkerRequest): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new StoreUnavailableError("store client shut down"));
		}
		return new Promise((resolve, reject) => {
			const op: PendingOp = {
				request,
				resolve,
				reject,
				timer: this.armTimeout(request.id),
				restarts: 0,
			};
			this.pending.set(request.id, op);
			// A failed spawn has already rejected this op via failAllPending.
			const worker = this.ensureWorker();
			if (worker !== undefined) this.sendTo(worker, op);
		});
	}

	private armTimeout(id: string): ReturnType<typeof setTimeout> {
		// The timed-out op is the restart's culprit: only it pays a restart.
		return setTimeout(
			() => this.restart(`op ${id} timed out after ${this.opTimeoutMs} ms`, id),
			this.opTimeoutMs,
		);
	}

	/** Reject every pending op as infrastructure failure and clear its timer. */
	private failAllPending(reason: string): void {
		for (const [id, op] of this.pending) {
			clearTimeout(op.timer);
			this.pending.delete(id);
			op.reject(new StoreUnavailableError(reason));
		}
	}

	/**
	 * Spawn (or reuse) the worker. A throwing spawnFn must not escape into a
	 * timer or promise executor: it rejects everything pending as
	 * StoreUnavailableError and returns undefined instead.
	 */
	private ensureWorker(): StoreWorkerHandle | undefined {
		if (this.worker !== undefined) return this.worker;
		this.generation++;
		const generation = this.generation;
		let worker: StoreWorkerHandle;
		try {
			worker = this.spawnFn();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.failAllPending(`store worker spawn failed: ${message}`);
			return undefined;
		}
		this.worker = worker;
		worker.onLine((line) => this.handleResponseLine(line));
		// A crash without a pending timeout takes the same restart path; the
		// generation check ignores exits we caused ourselves by killing.
		worker.onExit(() => {
			if (generation === this.generation && !this.closed) {
				this.restart("store worker exited");
			}
		});
		return worker;
	}

	private sendTo(worker: StoreWorkerHandle, op: PendingOp): void {
		try {
			worker.send(`${JSON.stringify(op.request)}\n`);
		} catch {
			// A dead pipe surfaces via onExit; the restart path re-issues.
		}
	}

	private handleResponseLine(line: string): void {
		let response: StoreWorkerResponse;
		try {
			response = JSON.parse(line) as StoreWorkerResponse;
		} catch {
			return;
		}
		const op = this.pending.get(response.id);
		if (op === undefined) return;
		clearTimeout(op.timer);
		this.pending.delete(response.id);
		// Normal op errors (unknown value, store full, invalid name) pass
		// through untagged and never restart the worker.
		if (response.ok) op.resolve(response.result);
		else op.reject(new Error(response.error));
	}

	/**
	 * The wedge-recovery contract: SIGKILL the worker (unconditional — thread
	 * termination could not preempt a wedged regex), respawn (resume replays
	 * the journal), and re-issue every in-flight op transparently. Restart
	 * blame is attributed: a timeout names its op as the culprit and only that
	 * op's restart counter increments — innocent concurrent ops re-issue for
	 * free and the culprit re-issues last. A crash/exit restart has no culprit
	 * and charges everyone (genuinely shared fault). Ops that have exhausted
	 * maxRestarts reject infrastructure-tagged instead.
	 */
	private restart(reason: string, culpritId?: string): void {
		if (this.closed) return;
		this.generation++;
		this.worker?.kill();
		this.worker = undefined;
		const inFlight = [...this.pending.values()];
		for (const op of inFlight) clearTimeout(op.timer);
		const survivors: PendingOp[] = [];
		let culprit: PendingOp | undefined;
		for (const op of inFlight) {
			if (culpritId === undefined || op.request.id === culpritId) op.restarts++;
			if (op.restarts > this.maxRestarts) {
				this.pending.delete(op.request.id);
				op.reject(new StoreUnavailableError(`store worker unavailable: ${reason}`));
			} else if (op.request.id === culpritId) {
				culprit = op;
			} else {
				survivors.push(op);
			}
		}
		// Innocents first; the possibly-wedging culprit re-issues last so it
		// cannot stall their re-issue behind another wedge.
		if (culprit !== undefined) survivors.push(culprit);
		if (survivors.length === 0) return;
		const worker = this.ensureWorker();
		if (worker === undefined) return; // spawn failed; failAllPending already rejected
		for (const op of survivors) {
			op.timer = this.armTimeout(op.request.id);
			this.sendTo(worker, op);
		}
	}
}

/** Default spawn: the sprout binary's internal store-worker subcommand. */
function spawnStoreWorkerProcess(init: StoreWorkerClientInit): StoreWorkerHandle {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[STORE_WORKER_JOURNAL_ENV]: init.journalPath,
		[STORE_WORKER_CAS_ENV]: init.casRoot,
		[STORE_WORKER_ROOT_SCOPE_ENV]: init.rootScopeId,
	};
	if (init.options !== undefined) {
		env[STORE_WORKER_OPTIONS_ENV] = JSON.stringify({
			...init.options,
			...(init.options.reservedNames !== undefined
				? { reservedNames: [...init.options.reservedNames] }
				: {}),
		});
	}
	const proc = Bun.spawn(buildInternalSproutCommand("store-worker"), {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	let lineHandler: (line: string) => void = () => {};
	let exitHandler: () => void = () => {};
	// Reassemble stdout into lines for the response handler.
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
