/**
 * Store worker subprocess entry (sap spec §1). The store runs in its own OS
 * process so wedge recovery is SIGKILL — unconditional, unlike terminating a
 * thread stuck in uninterruptible model-influenced regex. The worker holds no
 * unjournaled state (SapStore journals every bind/scope), so kill+restart is
 * always safe: resume is the cold start too.
 *
 * Protocol: one JSON request per line on stdin, one JSON response per line on
 * stdout — { id, ok: true, result } | { id, ok: false, error }. Binary content
 * crosses as base64, marked by an `encoding` field on the wire.
 */

import { ContentStore } from "./cas.ts";
import { SessionJournal } from "./journal.ts";
import { type BindArgs, SapStore, type SapStoreOptions } from "./store.ts";
import type { ValueMetadata, ValueProvenance, ValueType } from "./value.ts";

/** How value content crosses the wire: utf8 passthrough or base64 for bytes. */
export type WireEncoding = "utf8" | "base64";

export type StoreWorkerRequest =
	| { id: string; op: "createScope"; scopeId: string; ownerHandleId: string; parentScopeId: string }
	| {
			id: string;
			op: "bind";
			scopeId: string;
			name: string;
			content: string;
			encoding: WireEncoding;
			type: ValueType;
			provenance: ValueProvenance;
			explicit: boolean;
			ulid?: string;
	  }
	| { id: string; op: "peek"; scopeId: string; ref: string }
	| { id: string; op: "metadata"; scopeId: string; ref: string }
	| { id: string; op: "names"; scopeId: string }
	| { id: string; op: "get"; scopeId: string; ref: string; maxBytes: number }
	| {
			id: string;
			op: "slice";
			scopeId: string;
			ref: string;
			startLine: number;
			lineCount: number;
			maxBytes?: number;
	  }
	| { id: string; op: "grep"; scopeId: string; ref: string; pattern: string; maxResults?: number }
	| { id: string; op: "publish"; scopeId: string; ref: string };

export type StoreWorkerResponse =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; error: string };

/** get's wire result: the body plus how it is encoded. */
export interface WireBody {
	content: string;
	encoding: WireEncoding;
}

export function encodeWireContent(bytes: Uint8Array, type: ValueType): WireBody {
	return type === "bytes"
		? { content: Buffer.from(bytes).toString("base64"), encoding: "base64" }
		: { content: new TextDecoder().decode(bytes), encoding: "utf8" };
}

export function decodeWireContent(content: string, encoding: WireEncoding): Uint8Array {
	return encoding === "base64"
		? new Uint8Array(Buffer.from(content, "base64"))
		: new TextEncoder().encode(content);
}

export interface RunStoreWorkerInput {
	/** Raw stdin chunks (or pre-split lines); split on \n internally. */
	lines: AsyncIterable<string | Uint8Array>;
	/** Emit one response line (newline included by the caller's transport). */
	write: (line: string) => void;
	store: SapStore;
}

/**
 * Serve store ops over a line protocol. Separated from real stdio so the
 * protocol is testable in-process. Requests run sequentially — the engine is
 * single-store and ops are cheap or budgeted; ordering keeps the journal sane.
 */
/**
 * Backstop cap on one buffered request line. The only stdin writer is the
 * trusted StoreWorkerClient, so this should never trigger — it exists so a
 * corrupt or malicious pipe cannot grow the buffer without bound. The partial
 * line's id is unrecoverable, so the buffer is simply dropped.
 */
const MAX_REQUEST_LINE_BYTES = 64 * 1024 * 1024;

export async function runStoreWorker(input: RunStoreWorkerInput): Promise<void> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of input.lines) {
		buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		if (buffered.indexOf("\n") === -1 && buffered.length > MAX_REQUEST_LINE_BYTES) {
			buffered = "";
			continue;
		}
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			const response = await handleRequestLine(input.store, line);
			if (response !== undefined) input.write(JSON.stringify(response));
			newline = buffered.indexOf("\n");
		}
	}
}

/**
 * Handle one request line. Malformed lines get an error response when an id is
 * recoverable, otherwise they are dropped — there is nothing to correlate a
 * response to.
 */
async function handleRequestLine(
	store: SapStore,
	line: string,
): Promise<StoreWorkerResponse | undefined> {
	if (line.trim().length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const id = (parsed as { id?: unknown }).id;
	if (typeof id !== "string") return undefined;
	try {
		const result = await dispatch(store, parsed as StoreWorkerRequest);
		return { id, ok: true, result };
	} catch (err) {
		return { id, ok: false, error: (err as Error).message };
	}
}

/**
 * Execute one op against the engine 1:1. Field shapes are the client's job;
 * the engine validates the semantics (names, scopes, budgets) and anything
 * structurally off surfaces as an error response, never a crash.
 */
async function dispatch(store: SapStore, request: StoreWorkerRequest): Promise<unknown> {
	switch (request.op) {
		case "createScope":
			await store.createScope({
				scopeId: request.scopeId,
				ownerHandleId: request.ownerHandleId,
				parentScopeId: request.parentScopeId,
			});
			return null;
		case "bind": {
			if (typeof request.content !== "string") throw new Error("bind content must be a string");
			const args: BindArgs = {
				scopeId: request.scopeId,
				name: request.name,
				content: decodeWireContent(request.content, request.encoding),
				type: request.type,
				provenance: request.provenance,
				explicit: request.explicit,
			};
			if (request.ulid !== undefined) args.ulid = request.ulid;
			return store.bind(args);
		}
		case "peek":
			return store.peek(request.scopeId, request.ref);
		case "metadata":
			return store.metadata(request.scopeId, request.ref);
		case "names":
			return store.names(request.scopeId);
		case "get": {
			const bytes = await store.get(request.scopeId, request.ref, { maxBytes: request.maxBytes });
			const meta: ValueMetadata = await store.metadata(request.scopeId, request.ref);
			return encodeWireContent(bytes, meta.type);
		}
		case "slice":
			return store.slice(request.scopeId, request.ref, {
				startLine: request.startLine,
				lineCount: request.lineCount,
				...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
			});
		case "grep":
			return store.grep(request.scopeId, request.ref, request.pattern, {
				maxResults: request.maxResults,
			});
		case "publish":
			await store.publish(request.scopeId, request.ref);
			return null;
		default:
			throw new Error(`unknown op: ${JSON.stringify((request as { op?: unknown }).op)}`);
	}
}

/** Env config for the subprocess entry (set by StoreWorkerClient at spawn). */
export const STORE_WORKER_JOURNAL_ENV = "SPROUT_STORE_JOURNAL";
export const STORE_WORKER_CAS_ENV = "SPROUT_STORE_CAS";
export const STORE_WORKER_ROOT_SCOPE_ENV = "SPROUT_STORE_ROOT_SCOPE";
export const STORE_WORKER_OPTIONS_ENV = "SPROUT_STORE_OPTIONS";

/**
 * Subprocess entry: build the store from env config (resume doubles as cold
 * start over an empty journal) and serve real stdio.
 */
export async function runStoreWorkerFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const journalPath = env[STORE_WORKER_JOURNAL_ENV];
	const casRoot = env[STORE_WORKER_CAS_ENV];
	const rootScopeId = env[STORE_WORKER_ROOT_SCOPE_ENV];
	if (!journalPath || !casRoot || !rootScopeId) {
		process.stderr.write(
			`store worker requires ${STORE_WORKER_JOURNAL_ENV}, ${STORE_WORKER_CAS_ENV}, and ${STORE_WORKER_ROOT_SCOPE_ENV}\n`,
		);
		return 1;
	}
	const store = await SapStore.resume({
		journal: new SessionJournal(journalPath),
		cas: new ContentStore(casRoot),
		rootScopeId,
		options: parseOptionsEnv(env[STORE_WORKER_OPTIONS_ENV]),
	});
	await runStoreWorker({
		lines: process.stdin,
		write: (line) => process.stdout.write(`${line}\n`),
		store,
	});
	return 0;
}

/**
 * Option overrides as JSON. `reservedNames` crosses as a string array (Sets
 * are not JSON) and is rebuilt here.
 */
function parseOptionsEnv(raw: string | undefined): Partial<SapStoreOptions> | undefined {
	if (!raw) return undefined;
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const options = { ...parsed } as Partial<SapStoreOptions>;
	if (Array.isArray(parsed.reservedNames)) {
		options.reservedNames = new Set(parsed.reservedNames as string[]);
	}
	return options;
}

if (import.meta.main) {
	process.exit(await runStoreWorkerFromEnvironment());
}
