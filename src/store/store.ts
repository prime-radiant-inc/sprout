/**
 * Session store engine for the sap data plane (spec §1). In-process: holds the
 * per-scope name tables, value metadata, and a memory LRU over bodies; every
 * body is durable in CAS, and every bind/scope is journaled. The store worker
 * subprocess wraps this engine in a later slice.
 */

import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";
import { ulid } from "../util/ulid.ts";
import type { ContentStore } from "./cas.ts";
import {
	type GrantRecord,
	INLINE_BODY_LIMIT,
	type JournalBody,
	type SessionJournal,
} from "./journal.ts";
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
	/**
	 * Wall-clock budget for a grep run, checked between chunks (8 s). Kept
	 * comfortably under the client's 10 s wedge timeout so an honest slow grep
	 * fails cleanly inside the worker instead of escalating to SIGKILL.
	 */
	opBudgetMs: number;
	/** Max bytes a slice result may return (256 KB). */
	sliceBudgetBytes: number;
	/** Total matched-text byte cap for one grep; exceeding truncates (256 KB). */
	grepOutputBudgetBytes: number;
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
	opBudgetMs: 8_000,
	sliceBudgetBytes: 262_144,
	grepOutputBudgetBytes: 262_144,
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
	/**
	 * Caller-minted value id. Makes binds idempotent: re-issuing a bind whose
	 * ulid is already bound returns the existing metadata without re-journaling
	 * — the store worker's restart-and-re-issue recovery depends on this.
	 */
	ulid?: string;
}

export interface GrepMatch {
	line: number;
	text: string;
}

/** grep's result: matches, plus whether the output byte cap cut it short. */
export interface GrepResult {
	matches: GrepMatch[];
	truncated: boolean;
}

/** Who bound a name — collision rules (spec §1 Naming #3) key on this. */
interface NameOrigin {
	explicit: boolean;
	agentHandleId: string;
	ulid: string;
	/**
	 * Set when the name arrived via a manifest delivery: the publisher's handle.
	 * A later manifest name from the SAME publisher is a version update (the
	 * alias moves); any other collision suffixes per the auto-bind rule.
	 */
	manifestFrom?: string;
}

/** One value a manifest delivery handed the recipient. */
export interface ManifestDeltaValue {
	/** The alias bound in the recipient's scope (suffixed on collision). */
	name: string;
	/** The child's original chosen name — with `name`, the alias map. */
	sourceName: string;
	ulid: string;
	size: number;
	preview: string;
}

/** deliverManifest's result: the delivered aliases and the advanced cursor. */
export interface ManifestDelta {
	delivered: ManifestDeltaValue[];
	throughSeq: number;
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
	/** Last publish seq per handle, rebuilt from publish records on resume. */
	private readonly publishSeqs = new Map<string, number>();
	/** Publish records per handle, in seq order — manifest deltas read these. */
	private readonly publishRecords = new Map<string, { seq: number; ulids: string[] }[]>();
	/**
	 * Manifest-delivery cursor per publisherHandle×recipientScope: the publish
	 * seq the recipient has been delivered through.
	 */
	private readonly deliveryCursors = new Map<string, number>();
	/**
	 * Pending env grants keyed recipientHandle×alias (spec §3): registered by
	 * the sender before the bus message, consumed by the recipient's claim.
	 */
	private readonly pendingEnvGrants = new Map<string, { ulid: string; sender: string }>();
	/** Memory LRU over bodies: Map insertion order is recency order. */
	private readonly hotBodies = new Map<string, Uint8Array>();
	private hotBytes = 0;
	/** Journal + CAS bytes; initialized from cas.totalBytes() on first bind. */
	private diskBytes: number | undefined;
	/**
	 * Promise-chain mutex serializing every public op. The engine's invariants
	 * are check-then-act across awaits — the per-scope cap, name-collision
	 * checks, diskBytes init, and LRU accounting all read state, await I/O, then
	 * write state — so two interleaved callers could both pass a check that
	 * only admits one. One op at a time makes those sequences atomic.
	 */
	private tail: Promise<void> = Promise.resolve();

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.tail.then(fn);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

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
			} else if (record.kind === "publish") {
				store.publishSeqs.set(
					record.handle,
					Math.max(store.publishSeqs.get(record.handle) ?? 0, record.seq),
				);
				store.recordPublish(record.handle, record.seq, record.ulids);
			} else if (record.kind === "grant") {
				const scope = store.scopes.get(record.recipient);
				if (scope === undefined) {
					throw new Error(`journal grant references unknown scope: ${record.recipient}`);
				}
				// The record says how the alias arrived (via): an env claim is
				// model-named (explicit) and consumes its pending env grant; a
				// manifest alias keeps its publisher for version updates. Neither
				// is a real bind — valueCount stays untouched.
				if (record.via === "env") {
					store.pendingEnvGrants.delete(envGrantKey(record.recipient, record.name));
					scope.names.set(record.name, {
						explicit: true,
						agentHandleId: record.granter,
						ulid: record.ulid,
					});
				} else {
					scope.names.set(record.name, {
						explicit: false,
						agentHandleId: record.granter,
						ulid: record.ulid,
						manifestFrom: record.granter,
					});
				}
			} else if (record.kind === "env_grant") {
				store.pendingEnvGrants.set(envGrantKey(record.recipient, record.alias), {
					ulid: record.ulid,
					sender: record.sender,
				});
			} else if (record.kind === "manifest_delivery") {
				const key = deliveryCursorKey(record.handle, record.recipient);
				store.deliveryCursors.set(
					key,
					Math.max(store.deliveryCursors.get(key) ?? 0, record.throughPublishSeq),
				);
			}
			// cell records are a later slice's state.
		}
		return store;
	}

	/** Create a child scope (journaled) with an empty name table. */
	async createScope(args: {
		scopeId: string;
		ownerHandleId: string;
		parentScopeId: string;
	}): Promise<void> {
		return this.serialize(() => this.createScopeSerialized(args));
	}

	private async createScopeSerialized(args: {
		scopeId: string;
		ownerHandleId: string;
		parentScopeId: string;
	}): Promise<void> {
		if (this.scopes.has(args.scopeId)) {
			throw new Error(`scope already exists: ${args.scopeId}`);
		}
		const record = {
			kind: "scope" as const,
			scopeId: args.scopeId,
			ownerHandleId: args.ownerHandleId,
			parentScopeId: args.parentScopeId,
		};
		await this.journal.append(record);
		await this.chargeJournalBytes([record]);
		this.scopes.set(args.scopeId, { names: new Map(), valueCount: 0 });
	}

	async bind(args: BindArgs): Promise<ValueMetadata> {
		return this.serialize(() => this.bindSerialized(args));
	}

	private async bindSerialized(args: BindArgs): Promise<ValueMetadata> {
		// Idempotent re-issue: a caller-minted ulid that is already bound means
		// this bind already happened (the response was lost across a worker
		// restart) — return what the first issue produced.
		if (args.ulid !== undefined) {
			const existing = this.values.get(args.ulid);
			if (existing !== undefined) return existing.metadata;
		}
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
		// Clamp to the journal's hard inline ceiling: replay rejects inline
		// bodies >= INLINE_BODY_LIMIT, so a larger configured limit would write
		// records that brick resume. Text/json only inlines when the bytes
		// roundtrip utf8 cleanly — lossy decode would corrupt the value on
		// replay, so anything non-utf8 keeps its CAS ref instead.
		const inlineLimit = Math.min(this.options.inlineLimitBytes, INLINE_BODY_LIMIT);
		const body: JournalBody =
			bytes.length < inlineLimit && inlineEncodable(bytes, args.type)
				? { inline: encodeInline(bytes, args.type) }
				: { cas: sha };

		const metadata: ValueMetadata = {
			ulid: args.ulid ?? ulid(),
			name,
			scopeId: args.scopeId,
			type: args.type,
			size: bytes.length,
			provenance: args.provenance,
			// Previews surface in transcripts, journal records, and manifest
			// deltas — secrets in the excerpt are redacted at bind time.
			preview: redactSensitiveTranscriptContent(computePreview(args.content, args.type)),
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

	/**
	 * Mark a bound value for the scope's result manifest (sap spec §2 Publish).
	 * Appends a journal publish record with the next per-handle sequence — a
	 * scope's id IS its handle id. Manifest delivery (cursors, delta fetch) is a
	 * later slice; this is only the durable publish-record path.
	 */
	async publish(scopeId: string, ref: string): Promise<void> {
		return this.serialize(async () => {
			const entry = this.resolve(scopeId, ref);
			// A publisher only publishes values its own scope created — a foreign
			// ulid resolved globally must never enter this handle's manifest.
			if (entry.metadata.scopeId !== scopeId) {
				throw new Error(
					`cannot publish a value from another scope: ${ref} belongs to scope ${entry.metadata.scopeId}`,
				);
			}
			const seq = (this.publishSeqs.get(scopeId) ?? 0) + 1;
			const record = {
				kind: "publish" as const,
				handle: scopeId,
				ulids: [entry.metadata.ulid],
				seq,
			};
			await this.journal.append(record);
			await this.chargeJournalBytes([record]);
			this.publishSeqs.set(scopeId, seq);
			this.recordPublish(scopeId, seq, [entry.metadata.ulid]);
		});
	}

	/**
	 * Deliver the publisher's publish delta to a recipient scope (sap spec §2:
	 * "Manifests are pulled"). Delivered values are ALIASES into the recipient's
	 * name table — no body copy, and (deliberately) no valueCount charge: the
	 * per-scope cap bounds values a scope creates, and an alias references a
	 * value that already exists and is already accounted to its producer.
	 *
	 * Per name: a recipient binding that came from THIS publisher's earlier
	 * manifest is a version update (the alias moves, no suffix); any other
	 * existing binding collides and suffixes per the auto-bind rule. The grant
	 * records and the cursor record land in one atomic journal multi-append, so
	 * the cursor advances exactly when delivery is durable. An empty delta
	 * journals nothing and leaves the cursor unmoved — idempotent by cursor.
	 */
	async deliverManifest(args: {
		publisherHandle: string;
		recipientScopeId: string;
	}): Promise<ManifestDelta> {
		return this.serialize(async () => {
			const scope = this.requireScope(args.recipientScopeId);
			const cursorKey = deliveryCursorKey(args.publisherHandle, args.recipientScopeId);
			const cursor = this.deliveryCursors.get(cursorKey) ?? 0;
			const delta = (this.publishRecords.get(args.publisherHandle) ?? []).filter(
				(record) => record.seq > cursor,
			);
			if (delta.length === 0) return { delivered: [], throughSeq: cursor };

			const delivered: ManifestDeltaValue[] = [];
			const grants: GrantRecord[] = [];
			const aliases: { name: string; ulid: string }[] = [];
			// In-batch bookkeeping: a repeat of the SAME source name is a version
			// update of that staged entry; a DIFFERENT source name colliding with
			// a staged alias suffixes — distinct published values never collapse.
			const stagedBySource = new Map<string, number>();
			const stagedAliases = new Set<string>();
			for (const record of delta) {
				for (const valueUlid of record.ulids) {
					const entry = this.values.get(valueUlid);
					if (entry === undefined) {
						throw new Error(`publish record references unknown value: ${valueUlid}`);
					}
					const name = entry.metadata.name;
					const stagedAt = stagedBySource.get(name);
					if (stagedAt !== undefined) {
						// Same source republished within the batch: the staged entry
						// version-updates in place, keeping its assigned alias.
						const alias = aliases[stagedAt]!.name;
						delivered[stagedAt] = {
							name: alias,
							sourceName: name,
							ulid: valueUlid,
							size: entry.metadata.size,
							preview: entry.metadata.preview,
						};
						grants[stagedAt] = {
							kind: "grant",
							granter: args.publisherHandle,
							recipient: args.recipientScopeId,
							name: alias,
							ulid: valueUlid,
							via: "manifest",
						};
						aliases[stagedAt] = { name: alias, ulid: valueUlid };
						continue;
					}
					const existing = scope.names.get(name);
					let alias: string;
					if (existing?.manifestFrom === args.publisherHandle && !stagedAliases.has(name)) {
						// Same publisher's earlier manifest name: the alias moves.
						alias = name;
					} else if (existing !== undefined || stagedAliases.has(name)) {
						alias = this.suffixName(scope, name, stagedAliases);
					} else {
						alias = name;
					}
					stagedBySource.set(name, delivered.length);
					stagedAliases.add(alias);
					delivered.push({
						name: alias,
						sourceName: name,
						ulid: valueUlid,
						size: entry.metadata.size,
						preview: entry.metadata.preview,
					});
					grants.push({
						kind: "grant",
						granter: args.publisherHandle,
						recipient: args.recipientScopeId,
						name: alias,
						ulid: valueUlid,
						via: "manifest",
					});
					aliases.push({ name: alias, ulid: valueUlid });
				}
			}

			const throughSeq = delta[delta.length - 1]!.seq;
			// One atomic multi-append: grants + cursor durable together.
			const records = [
				...grants,
				{
					kind: "manifest_delivery" as const,
					handle: args.publisherHandle,
					recipient: args.recipientScopeId,
					throughPublishSeq: throughSeq,
				},
			];
			await this.journal.append(records);
			await this.chargeJournalBytes(records);
			for (const alias of aliases) {
				scope.names.set(alias.name, {
					explicit: false,
					agentHandleId: args.publisherHandle,
					ulid: alias.ulid,
					manifestFrom: args.publisherHandle,
				});
			}
			this.deliveryCursors.set(cursorKey, throughSeq);
			return { delivered, throughSeq };
		});
	}

	/**
	 * Register a pending env grant (sap spec §3: "Env grants are registered,
	 * not asserted"). The ref must resolve to a value the SENDER's scope
	 * created — foreign ulids are rejected like publish. Alias collisions fail
	 * loudly here, back to the sender, who can re-alias: an alias already bound
	 * in an EXISTING recipient scope rejects the grant. (A recipient scope that
	 * does not exist yet is fine — delegation spawns register before the
	 * child's scope is created.) Returns the granted value's metadata; the
	 * caller builds the wire env from its ulid.
	 */
	async registerEnvGrant(args: {
		senderScopeId: string;
		recipientHandle: string;
		alias: string;
		ref: string;
	}): Promise<ValueMetadata> {
		return this.serialize(async () => {
			const entry = this.resolve(args.senderScopeId, args.ref);
			if (entry.metadata.scopeId !== args.senderScopeId) {
				throw new Error(
					`cannot grant a value from another scope: ${args.ref} belongs to scope ${entry.metadata.scopeId}`,
				);
			}
			const result = validateValueName(args.alias, this.options.reservedNames);
			if (!result.ok) throw new Error(`invalid value name: ${result.reason}`);
			const recipientScope = this.scopes.get(args.recipientHandle);
			if (recipientScope?.names.has(args.alias)) {
				throw new Error(
					`alias already bound in the recipient's scope: "${args.alias}" — choose another alias`,
				);
			}
			// A different in-flight grant must never be silently overwritten; a
			// re-registration of the SAME value is idempotent-ok.
			const pendingKey = envGrantKey(args.recipientHandle, args.alias);
			const pending = this.pendingEnvGrants.get(pendingKey);
			if (pending !== undefined) {
				if (pending.ulid === entry.metadata.ulid) return entry.metadata;
				throw new Error(
					`an env grant for this alias is already pending with a different value: "${args.alias}"`,
				);
			}
			const record = {
				kind: "env_grant" as const,
				sender: args.senderScopeId,
				recipient: args.recipientHandle,
				alias: args.alias,
				ulid: entry.metadata.ulid,
			};
			await this.journal.append(record);
			await this.chargeJournalBytes([record]);
			this.pendingEnvGrants.set(envGrantKey(args.recipientHandle, args.alias), {
				ulid: entry.metadata.ulid,
				sender: args.senderScopeId,
			});
			return entry.metadata;
		});
	}

	/**
	 * Claim a pending env grant into the recipient's scope. Requires a pending
	 * entry matching (recipient, alias, ulid) — a forged bus `env` finds no
	 * grant and binds nothing. The alias enters the recipient's name table as
	 * an explicit (model-named) entry; like manifest aliases it is not a value
	 * creation, so valueCount stays untouched. An alias the recipient bound
	 * between registration and claim fails loudly. Returns the value's metadata
	 * under the alias, for the recipient's scope announcement.
	 */
	async claimEnvGrant(args: {
		recipientScopeId: string;
		alias: string;
		ulid: string;
	}): Promise<ValueMetadata> {
		return this.serialize(async () => {
			const key = envGrantKey(args.recipientScopeId, args.alias);
			const pending = this.pendingEnvGrants.get(key);
			if (pending === undefined || pending.ulid !== args.ulid) {
				throw new Error(
					`no matching env grant for alias "${args.alias}" in scope ${args.recipientScopeId}`,
				);
			}
			const scope = this.requireScope(args.recipientScopeId);
			if (scope.names.has(args.alias)) {
				throw new Error(`alias collided before claim: "${args.alias}" is already bound`);
			}
			const entry = this.values.get(args.ulid);
			if (entry === undefined) {
				throw new Error(`env grant references unknown value: ${args.ulid}`);
			}
			const record: GrantRecord = {
				kind: "grant",
				granter: pending.sender,
				recipient: args.recipientScopeId,
				name: args.alias,
				ulid: args.ulid,
				via: "env",
			};
			await this.journal.append(record);
			await this.chargeJournalBytes([record]);
			scope.names.set(args.alias, {
				explicit: true,
				agentHandleId: pending.sender,
				ulid: args.ulid,
			});
			this.pendingEnvGrants.delete(key);
			return { ...entry.metadata, name: args.alias };
		});
	}

	/** Append a publish record to the per-handle in-memory list, in seq order. */
	private recordPublish(handle: string, seq: number, ulids: string[]): void {
		const list = this.publishRecords.get(handle);
		if (list === undefined) this.publishRecords.set(handle, [{ seq, ulids }]);
		else list.push({ seq, ulids });
	}

	/** The stored bind-time preview, never re-computed. */
	async peek(scopeId: string, ref: string): Promise<string> {
		return this.serialize(async () => this.resolve(scopeId, ref).metadata.preview);
	}

	async metadata(scopeId: string, ref: string): Promise<ValueMetadata> {
		return this.serialize(async () => this.resolve(scopeId, ref).metadata);
	}

	/** The scope's bound names, sorted — what `⟦name⟧` can refer to there. */
	async names(scopeId: string): Promise<string[]> {
		return this.serialize(async () => [...this.requireScope(scopeId).names.keys()].sort());
	}

	/**
	 * Full body under a caller-supplied budget. Budget enforcement, not
	 * truncation: over-budget reads throw and the caller chooses what to do.
	 */
	async get(scopeId: string, ref: string, options: { maxBytes: number }): Promise<Uint8Array> {
		return this.serialize(() => {
			const entry = this.resolve(scopeId, ref);
			if (entry.metadata.size > options.maxBytes) {
				throw new Error(
					`value exceeds read budget: ${entry.metadata.size} > ${options.maxBytes} bytes`,
				);
			}
			return this.loadBody(entry);
		});
	}

	/**
	 * 1-based line range of a text/json value; a start past EOF is empty. The
	 * result is capped at maxBytes (default sliceBudgetBytes) — over-budget
	 * results throw rather than returning an unbounded string.
	 */
	async slice(
		scopeId: string,
		ref: string,
		options: { startLine: number; lineCount: number; maxBytes?: number },
	): Promise<string> {
		return this.serialize(async () => {
			const entry = this.resolve(scopeId, ref);
			if (entry.metadata.type === "bytes") {
				throw new Error(`cannot slice a bytes value: ${ref}`);
			}
			const lines = splitLines(new TextDecoder().decode(await this.loadBody(entry)));
			const start = Math.max(0, options.startLine - 1);
			const text = lines.slice(start, start + options.lineCount).join("\n");
			const budget = options.maxBytes ?? this.options.sliceBudgetBytes;
			const size = new TextEncoder().encode(text).length;
			if (size > budget) {
				throw new Error(
					`slice budget exceeded: result is ${size} bytes, over the ${budget}-byte budget — request fewer lines`,
				);
			}
			return text;
		});
	}

	/**
	 * Line-matched grep, chunk-at-a-time so model-written patterns stay
	 * interruptible: chunks are line-bounded (a regex never applies across a
	 * chunk seam mid-line) with grepChunkBytes as the fallback split for
	 * pathological single-line values. Between chunks the loop yields a
	 * macrotask (so timers and abort() can actually fire), honors the abort
	 * signal, and enforces the wall-clock budget — an honest-but-slow grep
	 * fails cleanly here instead of escalating to the client's wedge SIGKILL.
	 * Matched output is capped at grepOutputBudgetBytes; exceeding it returns
	 * what was collected with `truncated: true`.
	 */
	async grep(
		scopeId: string,
		ref: string,
		pattern: string,
		options: { maxResults?: number; signal?: AbortSignal; deadlineMs?: number } = {},
	): Promise<GrepResult> {
		return this.serialize(() => this.grepSerialized(scopeId, ref, pattern, options));
	}

	private async grepSerialized(
		scopeId: string,
		ref: string,
		pattern: string,
		options: { maxResults?: number; signal?: AbortSignal; deadlineMs?: number },
	): Promise<GrepResult> {
		const entry = this.resolve(scopeId, ref);
		let regex: RegExp;
		try {
			regex = new RegExp(pattern);
		} catch (err) {
			throw new Error(`invalid grep pattern: ${(err as Error).message}`);
		}
		const maxResults = options.maxResults ?? DEFAULT_GREP_MAX_RESULTS;
		const budgetMs = options.deadlineMs ?? this.options.opBudgetMs;
		const deadline = Date.now() + budgetMs;
		const outputBudget = this.options.grepOutputBudgetBytes;
		const text = new TextDecoder().decode(await this.loadBody(entry));
		const lines = splitLines(text);
		const cap = this.options.grepChunkBytes;
		const results: GrepMatch[] = [];
		let outputBytes = 0;
		let truncated = false;

		// A chunk is a run of whole lines up to `cap` chars; an overlong line
		// becomes its own run of cap-sized fragments (same line number).
		let chunk: GrepMatch[] = [];
		let chunkSize = 0;
		const flush = async (): Promise<boolean> => {
			if (chunk.length === 0) return true;
			for (const candidate of chunk) {
				if (regex.test(candidate.text)) {
					if (outputBytes + candidate.text.length > outputBudget) {
						truncated = true;
						return false;
					}
					results.push(candidate);
					outputBytes += candidate.text.length;
					if (results.length >= maxResults) return false;
				}
			}
			chunk = [];
			chunkSize = 0;
			// Macrotask yield: a microtask would never let timers fire, so
			// neither an abort armed via setTimeout nor anything else could
			// interrupt; setTimeout(0) actually drains the event loop.
			await new Promise((r) => setTimeout(r, 0));
			if (options.signal?.aborted) throw new Error("grep aborted");
			if (Date.now() > deadline) {
				throw new Error(`grep budget exceeded: ran past the ${budgetMs} ms budget`);
			}
			return true;
		};

		if (options.signal?.aborted) throw new Error("grep aborted");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] as string;
			const lineNumber = i + 1;
			if (line.length > cap) {
				if (!(await flush())) return { matches: results, truncated };
				for (let at = 0; at < line.length; at += cap) {
					chunk.push({ line: lineNumber, text: line.slice(at, at + cap) });
					if (!(await flush())) return { matches: results, truncated };
				}
				continue;
			}
			if (chunkSize + line.length > cap && !(await flush())) {
				return { matches: results, truncated };
			}
			chunk.push({ line: lineNumber, text: line });
			chunkSize += line.length;
		}
		await flush();
		return { matches: results, truncated };
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
		// Auto-bind: deterministic numeric suffix.
		return this.suffixName(scope, args.name);
	}

	/**
	 * Deterministic numeric suffix for a colliding auto-bind or manifest name,
	 * base truncated so the suffixed name stays within the 64-char limit.
	 * `alsoTaken` covers names staged but not yet applied (in-batch delivery).
	 */
	private suffixName(scope: ScopeState, name: string, alsoTaken?: ReadonlySet<string>): string {
		for (let n = 2; ; n++) {
			const suffix = `_${n}`;
			const base = name.slice(0, NAME_MAX_LENGTH - suffix.length);
			const candidate = `${base}${suffix}`;
			if (!scope.names.has(candidate) && !alsoTaken?.has(candidate)) return candidate;
		}
	}

	/**
	 * Count journaled records toward the session disk quota — publishes,
	 * grants, scopes, and delivery cursors grow the journal exactly like binds.
	 */
	private async chargeJournalBytes(records: unknown[]): Promise<void> {
		if (this.diskBytes === undefined) {
			this.diskBytes = await this.cas.totalBytes();
		}
		for (const record of records) {
			this.diskBytes += JSON.stringify(record).length + 1;
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
		// Already cached (e.g. two loads of the same value raced before the
		// mutex landed): re-inserting would double-count hotBytes.
		if (this.hotBodies.has(id)) return;
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

/** Pending-env-grant key for one recipientHandle×alias pair. */
function envGrantKey(recipientHandle: string, alias: string): string {
	return `${recipientHandle} ${alias}`;
}

/** Cursor-map key for one publisherHandle×recipientScope pair. */
function deliveryCursorKey(publisherHandle: string, recipientScopeId: string): string {
	return `${publisherHandle} ${recipientScopeId}`;
}

/** Inline journal encoding: utf8 passthrough for text/json, base64 for bytes. */
function encodeInline(bytes: Uint8Array, type: ValueType): string {
	return type === "bytes" ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes);
}

/**
 * Whether inlining is lossless: bytes always are (base64); text/json only when
 * the bytes are valid utf8 — a lossy decode would replace invalid sequences
 * and resume would serve different bytes than were bound.
 */
function inlineEncodable(bytes: Uint8Array, type: ValueType): boolean {
	if (type === "bytes") return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

function decodeInline(inline: string, type: ValueType): Uint8Array {
	return type === "bytes"
		? new Uint8Array(Buffer.from(inline, "base64"))
		: new TextEncoder().encode(inline);
}

/**
 * Split into lines by \n, dropping the empty tail of a trailing newline. CRLF
 * is treated like \n (the trailing \r is stripped per line) so slice/grep line
 * addressing matches value.ts's line counting and `$` anchors behave.
 */
function splitLines(text: string): string[] {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (lines.at(-1) === "") lines.pop();
	return lines;
}
