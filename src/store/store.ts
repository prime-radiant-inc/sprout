/**
 * Session store engine for the sap data plane (spec §1). In-process: holds the
 * per-scope name tables, value metadata, and a memory LRU over bodies; every
 * body is durable in CAS, and every bind/scope is journaled. The store worker
 * subprocess wraps this engine in a later slice.
 */

import { ulid } from "../util/ulid.ts";
import type { ContentStore } from "./cas.ts";
import { INLINE_BODY_LIMIT, type JournalBody, type SessionJournal } from "./journal.ts";
import {
	computePreview,
	type ValueMetadata,
	type ValueProvenance,
	type ValueType,
	validateValueName,
} from "./value.ts";

export interface SapStoreOptions {
	/** Hot-body memory budget; over-budget inserts evict LRU (default 512 MB). */
	memoryBudgetBytes: number;
	/** Session disk quota, journal + CAS combined (default 4 GB). */
	diskQuotaBytes: number;
	/** Max values bound per scope (default 10,000). */
	perScopeValueCap: number;
	/** Max size of a single value (default 256 MB). */
	maxValueBytes: number;
	/** Bodies under this size are inlined in the journal bind record (64 KB). */
	inlineLimitBytes: number;
	/** Line-bounded grep chunk cap; the fallback for single-line values (1 MB). */
	grepChunkBytes: number;
	/** Names rejected by validation (ambient API, kernel primitives, ...). */
	reservedNames: ReadonlySet<string>;
}

const DEFAULT_OPTIONS: SapStoreOptions = {
	memoryBudgetBytes: 512 * 1024 * 1024,
	diskQuotaBytes: 4 * 1024 * 1024 * 1024,
	perScopeValueCap: 10_000,
	maxValueBytes: 256 * 1024 * 1024,
	inlineLimitBytes: INLINE_BODY_LIMIT,
	grepChunkBytes: 1024 * 1024,
	reservedNames: new Set(),
};

const NAME_MAX_LENGTH = 64;
const DEFAULT_GREP_MAX_RESULTS = 1000;

export interface SapStoreInit {
	journal: SessionJournal;
	cas: ContentStore;
	/** The implicit root scope's id — exists at construction, never journaled. */
	rootScopeId: string;
	options?: Partial<SapStoreOptions>;
}

export interface BindArgs {
	scopeId: string;
	name: string;
	content: Uint8Array | string;
	type: ValueType;
	provenance: ValueProvenance;
	/** Model-named bind (true) vs provenance-derived auto-bind (false). */
	explicit: boolean;
}

export interface GrepMatch {
	line: number;
	text: string;
}

/** Who bound a name — collision rules (spec §1 Naming #3) key on this. */
interface NameOrigin {
	explicit: boolean;
	agentHandleId: string;
	ulid: string;
}

/** Where a body can be reloaded from when it is not in the memory LRU. */
type BodySource = { cas: string } | { inline: string };

interface ValueEntry {
	metadata: ValueMetadata;
	source: BodySource;
}

interface ScopeState {
	names: Map<string, NameOrigin>;
	/** Values bound in this scope (versions count toward the per-scope cap). */
	valueCount: number;
}

export class SapStore {
	private readonly journal: SessionJournal;
	private readonly cas: ContentStore;
	private readonly options: SapStoreOptions;
	private readonly scopes = new Map<string, ScopeState>();
	private readonly values = new Map<string, ValueEntry>();
	/** Memory LRU over bodies: Map insertion order is recency order. */
	private readonly hotBodies = new Map<string, Uint8Array>();
	private hotBytes = 0;
	/** Journal + CAS bytes; initialized from cas.totalBytes() on first bind. */
	private diskBytes: number | undefined;

	constructor(init: SapStoreInit) {
		this.journal = init.journal;
		this.cas = init.cas;
		this.options = { ...DEFAULT_OPTIONS, ...init.options };
		this.scopes.set(init.rootScopeId, { names: new Map(), valueCount: 0 });
	}

	/**
	 * Rebuild a store from its journal: scopes, name tables (later bind of the
	 * same name wins), and body sources. Bodies lazy-load on read — inline
	 * journal bodies serve small values without touching CAS, but are never
	 * preloaded into memory.
	 */
	static async resume(init: SapStoreInit): Promise<SapStore> {
		const store = new SapStore(init);
		for (const record of await init.journal.replay()) {
			if (record.kind === "scope") {
				store.scopes.set(record.scopeId, { names: new Map(), valueCount: 0 });
			} else if (record.kind === "bind") {
				const metadata: ValueMetadata = {
					ulid: record.ulid,
					name: record.name,
					scopeId: record.scope,
					type: record.type,
					size: record.size,
					provenance: record.provenance,
					preview: record.preview,
					createdAt: record.createdAt,
				};
				store.values.set(record.ulid, { metadata, source: record.body });
				const scope = store.scopes.get(record.scope);
				if (scope === undefined) {
					throw new Error(`journal bind references unknown scope: ${record.scope}`);
				}
				scope.names.set(record.name, {
					explicit: record.explicit,
					agentHandleId: record.provenance.agentHandleId,
					ulid: record.ulid,
				});
				scope.valueCount++;
			}
			// publish/manifest_delivery/grant/cell records are later slices' state.
		}
		return store;
	}

	/** Create a child scope (journaled) with an empty name table. */
	async createScope(args: {
		scopeId: string;
		ownerHandleId: string;
		parentScopeId: string;
	}): Promise<void> {
		if (this.scopes.has(args.scopeId)) {
			throw new Error(`scope already exists: ${args.scopeId}`);
		}
		await this.journal.append({
			kind: "scope",
			scopeId: args.scopeId,
			ownerHandleId: args.ownerHandleId,
			parentScopeId: args.parentScopeId,
		});
		this.scopes.set(args.scopeId, { names: new Map(), valueCount: 0 });
	}

	async bind(args: BindArgs): Promise<ValueMetadata> {
		const scope = this.requireScope(args.scopeId);
		const name = this.resolveBindName(scope, args);
		const bytes =
			typeof args.content === "string" ? new TextEncoder().encode(args.content) : args.content;

		if (bytes.length > this.options.maxValueBytes) {
			throw new Error(
				`value exceeds max value size: ${bytes.length} > ${this.options.maxValueBytes} bytes`,
			);
		}
		if (scope.valueCount >= this.options.perScopeValueCap) {
			throw new Error(
				`store full: scope ${args.scopeId} is at its value cap (${this.options.perScopeValueCap})`,
			);
		}
		if (this.diskBytes === undefined) {
			this.diskBytes = await this.cas.totalBytes();
		}
		if (this.diskBytes + bytes.length > this.options.diskQuotaBytes) {
			throw new Error(
				`store full: disk quota exceeded (${this.diskBytes + bytes.length} > ${this.options.diskQuotaBytes} bytes)`,
			);
		}

		// Every body goes to CAS (dedup makes this cheap); small bodies are
		// additionally inlined in the journal record.
		const sha = await this.cas.put(bytes);
		const body: JournalBody =
			bytes.length < this.options.inlineLimitBytes
				? { inline: encodeInline(bytes, args.type) }
				: { cas: sha };

		const metadata: ValueMetadata = {
			ulid: ulid(),
			name,
			scopeId: args.scopeId,
			type: args.type,
			size: bytes.length,
			provenance: args.provenance,
			preview: computePreview(args.content, args.type),
			createdAt: Date.now(),
		};
		const record = {
			kind: "bind" as const,
			ulid: metadata.ulid,
			name,
			scope: args.scopeId,
			type: args.type,
			size: bytes.length,
			provenance: args.provenance,
			preview: metadata.preview,
			explicit: args.explicit,
			createdAt: metadata.createdAt as number,
			body,
		};
		await this.journal.append(record);
		// A cheap overestimate: dedup'd CAS writes count again, which only errs
		// toward hitting the quota early, never past it.
		this.diskBytes += bytes.length + JSON.stringify(record).length + 1;

		this.values.set(metadata.ulid, { metadata, source: { cas: sha } });
		scope.names.set(name, {
			explicit: args.explicit,
			agentHandleId: args.provenance.agentHandleId,
			ulid: metadata.ulid,
		});
		scope.valueCount++;
		this.cacheBody(metadata.ulid, bytes);
		return metadata;
	}

	/** The stored bind-time preview, never re-computed. */
	async peek(scopeId: string, ref: string): Promise<string> {
		return this.resolve(scopeId, ref).metadata.preview;
	}

	async metadata(scopeId: string, ref: string): Promise<ValueMetadata> {
		return this.resolve(scopeId, ref).metadata;
	}

	/**
	 * Full body under a caller-supplied budget. Budget enforcement, not
	 * truncation: over-budget reads throw and the caller chooses what to do.
	 */
	async get(scopeId: string, ref: string, options: { maxBytes: number }): Promise<Uint8Array> {
		const entry = this.resolve(scopeId, ref);
		if (entry.metadata.size > options.maxBytes) {
			throw new Error(
				`value exceeds read budget: ${entry.metadata.size} > ${options.maxBytes} bytes`,
			);
		}
		return this.loadBody(entry);
	}

	/** 1-based line range of a text/json value; a start past EOF is empty. */
	async slice(
		scopeId: string,
		ref: string,
		options: { startLine: number; lineCount: number },
	): Promise<string> {
		const entry = this.resolve(scopeId, ref);
		if (entry.metadata.type === "bytes") {
			throw new Error(`cannot slice a bytes value: ${ref}`);
		}
		const lines = splitLines(new TextDecoder().decode(await this.loadBody(entry)));
		const start = Math.max(0, options.startLine - 1);
		return lines.slice(start, start + options.lineCount).join("\n");
	}

	/**
	 * Line-matched grep, chunk-at-a-time so model-written patterns stay
	 * interruptible: chunks are line-bounded (a regex never applies across a
	 * chunk seam mid-line) with grepChunkBytes as the fallback split for
	 * pathological single-line values, and the abort signal is checked between
	 * chunks.
	 */
	async grep(
		scopeId: string,
		ref: string,
		pattern: string,
		options: { maxResults?: number; signal?: AbortSignal } = {},
	): Promise<GrepMatch[]> {
		const entry = this.resolve(scopeId, ref);
		let regex: RegExp;
		try {
			regex = new RegExp(pattern);
		} catch (err) {
			throw new Error(`invalid grep pattern: ${(err as Error).message}`);
		}
		const maxResults = options.maxResults ?? DEFAULT_GREP_MAX_RESULTS;
		const text = new TextDecoder().decode(await this.loadBody(entry));
		const lines = splitLines(text);
		const cap = this.options.grepChunkBytes;
		const results: GrepMatch[] = [];

		// A chunk is a run of whole lines up to `cap` chars; an overlong line
		// becomes its own run of cap-sized fragments (same line number).
		let chunk: GrepMatch[] = [];
		let chunkSize = 0;
		const flush = async (): Promise<boolean> => {
			if (chunk.length === 0) return true;
			for (const candidate of chunk) {
				if (regex.test(candidate.text)) {
					results.push(candidate);
					if (results.length >= maxResults) return false;
				}
			}
			chunk = [];
			chunkSize = 0;
			// Yield so an external abort() can land, then honor it.
			await Promise.resolve();
			if (options.signal?.aborted) throw new Error("grep aborted");
			return true;
		};

		if (options.signal?.aborted) throw new Error("grep aborted");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] as string;
			const lineNumber = i + 1;
			if (line.length > cap) {
				if (!(await flush())) return results;
				for (let at = 0; at < line.length; at += cap) {
					chunk.push({ line: lineNumber, text: line.slice(at, at + cap) });
					if (!(await flush())) return results;
				}
				continue;
			}
			if (chunkSize + line.length > cap && !(await flush())) return results;
			chunk.push({ line: lineNumber, text: line });
			chunkSize += line.length;
		}
		await flush();
		return results;
	}

	private requireScope(scopeId: string): ScopeState {
		const scope = this.scopes.get(scopeId);
		if (scope === undefined) throw new Error(`unknown scope: ${scopeId}`);
		return scope;
	}

	/**
	 * Validate the requested name and apply the collision rules (spec §1
	 * Naming #3): explicit self-rebind versions, explicit cross-origin
	 * collision fails loudly, auto-bind collisions take a numeric suffix.
	 */
	private resolveBindName(scope: ScopeState, args: BindArgs): string {
		const result = validateValueName(args.name, this.options.reservedNames);
		if (!result.ok) throw new Error(`invalid value name: ${result.reason}`);

		const existing = scope.names.get(args.name);
		if (existing === undefined) return args.name;
		if (args.explicit) {
			if (existing.explicit && existing.agentHandleId === args.provenance.agentHandleId) {
				// Same agent explicitly rebinding its own name: a new version.
				return args.name;
			}
			throw new Error(
				`name collision: "${args.name}" is already bound by a different origin in this scope`,
			);
		}
		// Auto-bind: deterministic numeric suffix, base truncated so the
		// suffixed name stays within the 64-char limit.
		for (let n = 2; ; n++) {
			const suffix = `_${n}`;
			const base = args.name.slice(0, NAME_MAX_LENGTH - suffix.length);
			const candidate = `${base}${suffix}`;
			if (!scope.names.has(candidate)) return candidate;
		}
	}

	private resolve(scopeId: string, ref: string): ValueEntry {
		const scope = this.requireScope(scopeId);
		// Scope-local name first, then ulid — ulids are globally readable here.
		const named = scope.names.get(ref);
		if (named !== undefined) {
			const entry = this.values.get(named.ulid);
			if (entry !== undefined) return entry;
		}
		const byUlid = this.values.get(ref);
		if (byUlid !== undefined) return byUlid;
		throw new Error(`unknown value: ${ref} in scope ${scopeId}`);
	}

	/** Body via the LRU, reloading from the value's source on a miss. */
	private async loadBody(entry: ValueEntry): Promise<Uint8Array> {
		const cached = this.hotBodies.get(entry.metadata.ulid);
		if (cached !== undefined) {
			// Touch: re-insert so Map order tracks recency.
			this.hotBodies.delete(entry.metadata.ulid);
			this.hotBodies.set(entry.metadata.ulid, cached);
			return cached;
		}
		const bytes =
			"cas" in entry.source
				? await this.cas.get(entry.source.cas)
				: decodeInline(entry.source.inline, entry.metadata.type);
		this.cacheBody(entry.metadata.ulid, bytes);
		return bytes;
	}

	/**
	 * Insert into the memory LRU, evicting least-recently-used bodies until it
	 * fits. A single body larger than the whole budget is never cached — it is
	 * served straight from CAS. Values are immutable, so eviction is safe.
	 */
	private cacheBody(id: string, bytes: Uint8Array): void {
		if (bytes.length > this.options.memoryBudgetBytes) return;
		while (this.hotBytes + bytes.length > this.options.memoryBudgetBytes) {
			const oldest = this.hotBodies.keys().next().value as string;
			const evicted = this.hotBodies.get(oldest) as Uint8Array;
			this.hotBodies.delete(oldest);
			this.hotBytes -= evicted.length;
		}
		this.hotBodies.set(id, bytes);
		this.hotBytes += bytes.length;
	}
}

/** Inline journal encoding: utf8 passthrough for text/json, base64 for bytes. */
function encodeInline(bytes: Uint8Array, type: ValueType): string {
	return type === "bytes" ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes);
}

function decodeInline(inline: string, type: ValueType): Uint8Array {
	return type === "bytes"
		? new Uint8Array(Buffer.from(inline, "base64"))
		: new TextEncoder().encode(inline);
}

/** Split into lines by \n, dropping the empty tail of a trailing newline. */
function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}
