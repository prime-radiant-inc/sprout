import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Memory } from "../kernel/types.ts";
import { isActiveMemoryForRecall } from "./memory-lifecycle.ts";
import { MEMORY_SCHEMA_VERSION, normalizeMemory } from "./memory-schema.ts";
import type { MemorySegment } from "./segments.ts";
import { normalizeSegment } from "./segments.ts";

// v4: dropped the write-only annotations/projects tables (never read).
const INDEX_SCHEMA_VERSION = 4;
const VECTOR_DIMENSIONS = 768;
const DEFAULT_MIN_VECTOR_SIMILARITY = 0.42;
const RRF_K = 60;

export interface MemoryIndexStats {
	memoryCount: number;
	segmentCount: number;
	entityCount: number;
	linkCount: number;
	embeddingCount: number;
	segmentEmbeddingCount: number;
}

export interface VectorSearchResult {
	id: string;
	distance: number;
	rank: number;
}

export interface HybridSearchResult {
	id: string;
	score: number;
	textRank?: number;
	vectorRank?: number;
	vectorDistance?: number;
}

interface CandidateFilter {
	candidateIds?: ReadonlySet<string>;
	allowPartialEmbeddings?: boolean;
}

interface HybridSearchOptions extends CandidateFilter {
	minVectorSimilarity?: number;
}

interface CountRow {
	count: number;
}

interface MemorySearchRow {
	id: string;
	rank: number;
}

interface MemoryEmbeddingRow {
	memory_id: string;
	embedding: Uint8Array;
}

interface MemoryIdRow {
	id: string;
}

interface SegmentEmbeddingRow {
	segment_id: string;
	embedding: Uint8Array;
}

export interface EntitySearchResult {
	uuid: string;
	type: EntitySearchType;
	name: string;
	rank: number;
}

type EntitySearchType = NonNullable<Memory["entity_links"]>[number]["type"];

interface EntitySearchRow {
	uuid: string;
	type: EntitySearchType;
	name: string;
	rank: number;
}

interface EntityIndexRow {
	id: string;
	name: string;
	type: EntitySearchType;
	linkCount: number;
	createdAt: number;
	lastLinkedAt: number;
}

export class MemoryIndex {
	private constructor(private readonly db: Database) {}

	static open(path = ":memory:"): MemoryIndex {
		if (path !== ":memory:" && path !== "") {
			mkdirSync(dirname(path), { recursive: true });
		}
		const index = new MemoryIndex(new Database(path, { create: true, readwrite: true }));
		index.ensureSchema();
		return index;
	}

	/**
	 * Open a scratch index whose file needs no crash durability: writes skip fsync
	 * entirely, so builds run at memory speed. Use for temp files that are
	 * discarded on failure and atomically renamed into place on success — a
	 * torn file after a power loss is caught by index stale detection and rebuilt.
	 */
	static openScratch(path: string): MemoryIndex {
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path, { create: true, readwrite: true });
		db.run("PRAGMA synchronous = OFF");
		const index = new MemoryIndex(db);
		index.ensureSchema();
		return index;
	}

	static openReadOnly(path: string): MemoryIndex {
		return new MemoryIndex(new Database(path, { readonly: true, create: false }));
	}

	static currentSchemaVersion(): number {
		return INDEX_SCHEMA_VERSION;
	}

	static readSchemaVersion(path: string): number | undefined {
		const value = MemoryIndex.readMeta(path, "schema_version");
		if (value === undefined) return undefined;
		const version = Number(value);
		return Number.isInteger(version) ? version : undefined;
	}

	static readMeta(path: string, key: string): string | undefined {
		let db: Database | undefined;
		try {
			db = new Database(path, { readonly: true, create: false });
			const row = db
				.query<{ value: string }, [string]>("SELECT value FROM memory_index_meta WHERE key = ?")
				.get(key);
			return row?.value;
		} catch {
			return undefined;
		} finally {
			db?.close();
		}
	}

	close(): void {
		this.db.close();
	}

	ensureSchema(): void {
		// One transaction so the schema commits with a single fsync; statement-at-a-time
		// DDL pays a journal commit per statement, which dominates index open time.
		this.db.transaction(() => this.applySchema())();
	}

	private applySchema(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_index_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				short_id TEXT NOT NULL,
				content TEXT NOT NULL,
				tags_json TEXT NOT NULL,
				source TEXT NOT NULL,
				created INTEGER NOT NULL,
				last_used INTEGER NOT NULL,
				use_count INTEGER NOT NULL,
				confidence REAL NOT NULL,
					schema_version INTEGER NOT NULL,
					importance_score REAL,
					archived_at INTEGER,
					superseded_by TEXT
				)
			`);
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
				id UNINDEXED,
				content,
				tags
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_embeddings (
				memory_id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				dimensions INTEGER NOT NULL,
				embedding BLOB NOT NULL
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_segments (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				title TEXT NOT NULL,
				summary TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER NOT NULL,
				message_count INTEGER NOT NULL,
				project_id TEXT NOT NULL,
				project_confidence REAL NOT NULL,
				complexity REAL NOT NULL
			)
		`);
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_segments_fts USING fts5(
				id UNINDEXED,
				title,
				summary,
				project_id
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_segment_embeddings (
				segment_id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				dimensions INTEGER NOT NULL,
				embedding BLOB NOT NULL
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS entities (
				id TEXT NOT NULL,
				name TEXT NOT NULL,
				entity_type TEXT NOT NULL,
				link_count INTEGER NOT NULL DEFAULT 0,
				last_linked_at INTEGER,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (id, entity_type)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_entities (
				memory_id TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				entity_type TEXT NOT NULL,
				name TEXT NOT NULL,
				PRIMARY KEY (memory_id, entity_id, entity_type)
			)
		`);
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
				entity_id UNINDEXED,
				name,
				entity_type
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_links (
				source_id TEXT NOT NULL,
				target_id TEXT NOT NULL,
				type TEXT NOT NULL,
				reasoning TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (source_id, target_id, type)
			)
		`);
		this.db.run(
			"INSERT OR REPLACE INTO memory_index_meta (key, value) VALUES ('schema_version', ?)",
			[String(INDEX_SCHEMA_VERSION)],
		);
		this.db.run(
			"INSERT OR REPLACE INTO memory_index_meta (key, value) VALUES ('memory_schema_version', ?)",
			[String(MEMORY_SCHEMA_VERSION)],
		);
	}

	setMeta(key: string, value: string): void {
		this.db.run("INSERT OR REPLACE INTO memory_index_meta (key, value) VALUES (?, ?)", [
			key,
			value,
		]);
	}

	rebuild(memories: readonly Memory[], segments: readonly MemorySegment[] = []): void {
		const insertMemory = this.db.prepare(
			`INSERT INTO memories (
				id,
				short_id,
				content,
				tags_json,
				source,
				created,
				last_used,
				use_count,
				confidence,
					schema_version,
					importance_score,
					archived_at,
					superseded_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertFts = this.db.prepare(
			"INSERT INTO memories_fts (id, content, tags) VALUES (?, ?, ?)",
		);
		const insertEmbedding = this.db.prepare(
			`INSERT INTO memory_embeddings (
				memory_id,
				provider,
				model,
				dimensions,
				embedding
			) VALUES (?, ?, ?, ?, ?)`,
		);
		const insertSegment = this.db.prepare(
			`INSERT INTO memory_segments (
				id,
				session_id,
				title,
				summary,
				started_at,
				ended_at,
				message_count,
				project_id,
				project_confidence,
				complexity
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertSegmentFts = this.db.prepare(
			"INSERT INTO memory_segments_fts (id, title, summary, project_id) VALUES (?, ?, ?, ?)",
		);
		const insertSegmentEmbedding = this.db.prepare(
			`INSERT INTO memory_segment_embeddings (
				segment_id,
				provider,
				model,
				dimensions,
				embedding
			) VALUES (?, ?, ?, ?, ?)`,
		);
		const insertMemoryEntity = this.db.prepare(
			`INSERT OR REPLACE INTO memory_entities (
				memory_id,
				entity_id,
				entity_type,
				name
			) VALUES (?, ?, ?, ?)`,
		);
		const insertEntity = this.db.prepare(
			`INSERT OR REPLACE INTO entities (
				id,
				name,
				entity_type,
				link_count,
				last_linked_at,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const insertEntityFts = this.db.prepare(
			"INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)",
		);
		const insertLink = this.db.prepare(
			`INSERT OR REPLACE INTO memory_links (
				source_id,
				target_id,
				type,
				reasoning,
				created_at
			) VALUES (?, ?, ?, ?, ?)`,
		);

		const run = this.db.transaction(
			(input: { memories: readonly Memory[]; segments: readonly MemorySegment[] }) => {
				this.clear();
				const entityRows = entityIndexRows(input.memories);
				for (const record of input.memories) {
					const memory = normalizeMemory(record);
					insertMemory.run(
						memory.id,
						memory.short_id ?? memory.id,
						memory.content,
						JSON.stringify(memory.tags),
						memory.source,
						memory.created,
						memory.last_used,
						memory.use_count,
						memory.confidence,
						memory.schema_version ?? MEMORY_SCHEMA_VERSION,
						memory.importance_score ?? null,
						memory.archived_at ?? null,
						memory.superseded_by ?? null,
					);
					insertFts.run(memory.id, memory.content, memory.tags.join(" "));
					const embedding = memoryEmbeddingVector(memory);
					if (embedding) {
						insertEmbedding.run(
							memory.id,
							memory.embedding?.provider ?? "unknown",
							memory.embedding?.model ?? "unknown",
							embedding.length,
							encodeVector(embedding),
						);
					}
					for (const entity of memory.entity_links ?? []) {
						insertMemoryEntity.run(memory.id, entity.uuid, entity.type, entity.name);
					}
					for (const link of memory.outbound_links ?? []) {
						insertLink.run(memory.id, link.uuid, link.type, link.reasoning, link.created_at);
					}
					for (const link of memory.inbound_links ?? []) {
						insertLink.run(link.uuid, memory.id, link.type, link.reasoning, link.created_at);
					}
				}
				for (const entity of entityRows) {
					insertEntity.run(
						entity.id,
						entity.name,
						entity.type,
						entity.linkCount,
						entity.lastLinkedAt,
						entity.createdAt,
					);
					insertEntityFts.run(entity.id, entity.name, entity.type);
				}
				for (const record of input.segments) {
					const segment = normalizeSegment(record);
					insertSegment.run(
						segment.id,
						segment.session_id,
						segment.title,
						segment.summary,
						segment.started_at,
						segment.ended_at,
						segment.message_count,
						segment.project_id,
						segment.project_confidence,
						segment.complexity,
					);
					insertSegmentFts.run(segment.id, segment.title, segment.summary, segment.project_id);
					const embedding = segmentEmbeddingVector(segment);
					if (embedding) {
						insertSegmentEmbedding.run(
							segment.id,
							segment.embedding?.provider ?? "unknown",
							segment.embedding?.model ?? "unknown",
							embedding.length,
							encodeVector(embedding),
						);
					}
				}
			},
		);

		run({ memories, segments });
	}

	searchText(query: string, limit: number, options: CandidateFilter = {}): string[] {
		const normalized = toFtsQuery(query);
		if (!normalized) return [];
		const candidateIds = options.candidateIds;
		if (candidateIds?.size === 0) return [];
		const activeIds = this.activeMemoryIds();
		if (activeIds.size === 0) return [];
		const rows = this.db
			.query<MemorySearchRow, [string]>(
				`SELECT id, bm25(memories_fts) AS rank
					 FROM memories_fts
					 WHERE memories_fts MATCH ?
					 ORDER BY rank`,
			)
			.all(normalized);
		return rows
			.map((row) => row.id)
			.filter((id) => activeIds.has(id) && (!candidateIds || candidateIds.has(id)))
			.slice(0, limit);
	}

	searchEntities(
		query: string,
		options: { type?: EntitySearchType; limit?: number } = {},
	): EntitySearchResult[] {
		const normalized = toFtsQuery(query);
		if (!normalized) return [];
		const limit = options.limit ?? 20;
		if (options.type) {
			return this.db
				.query<EntitySearchRow, [string, EntitySearchType, number]>(
					`SELECT entity_id AS uuid, entity_type AS type, name, bm25(entities_fts) AS rank
					 FROM entities_fts
					 WHERE entities_fts MATCH ? AND entity_type = ?
					 ORDER BY rank
					 LIMIT ?`,
				)
				.all(normalized, options.type, limit);
		}
		return this.db
			.query<EntitySearchRow, [string, number]>(
				`SELECT entity_id AS uuid, entity_type AS type, name, bm25(entities_fts) AS rank
				 FROM entities_fts
				 WHERE entities_fts MATCH ?
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(normalized, limit);
	}

	searchVector(
		queryEmbedding: Float32Array,
		limit: number,
		options: CandidateFilter = {},
	): VectorSearchResult[] {
		validateVector(queryEmbedding, "query embedding");
		const candidateIds = options.candidateIds;
		if (candidateIds?.size === 0) return [];
		const rows = this.db
			.query<MemoryEmbeddingRow, []>(
				"SELECT memory_id, embedding FROM memory_embeddings WHERE dimensions = 768",
			)
			.all();
		const activeIds = this.activeMemoryIds();
		const eligibleRows = candidateIds
			? rows.filter((row) => candidateIds.has(row.memory_id) && activeIds.has(row.memory_id))
			: rows.filter((row) => activeIds.has(row.memory_id));
		const expectedCount = candidateIds
			? [...candidateIds].filter((id) => activeIds.has(id)).length
			: activeIds.size;
		if (expectedCount === 0) return [];
		if (eligibleRows.length === 0) {
			if (options.allowPartialEmbeddings) return [];
			throw new Error("Memory index has no embeddings; memory writes must create ready vectors");
		}
		if (!options.allowPartialEmbeddings && eligibleRows.length !== expectedCount) {
			throw new Error(
				`Memory index embeddings are incomplete: ${eligibleRows.length}/${expectedCount} memories have vectors`,
			);
		}
		return eligibleRows
			.map((row) => ({
				id: row.memory_id,
				distance: cosineDistance(queryEmbedding, decodeVector(row.embedding)),
			}))
			.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
			.slice(0, limit)
			.map((result, index) => ({ ...result, rank: index + 1 }));
	}

	searchSegmentsText(query: string, limit: number): string[] {
		const normalized = toFtsQuery(query);
		if (!normalized) return [];
		const rows = this.db
			.query<MemorySearchRow, [string, number]>(
				`SELECT id, bm25(memory_segments_fts) AS rank
				 FROM memory_segments_fts
				 WHERE memory_segments_fts MATCH ?
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(normalized, limit);
		return rows.map((row) => row.id);
	}

	searchSegmentsVector(queryEmbedding: Float32Array, limit: number): VectorSearchResult[] {
		validateVector(queryEmbedding, "query embedding");
		const rows = this.db
			.query<SegmentEmbeddingRow, []>(
				"SELECT segment_id, embedding FROM memory_segment_embeddings WHERE dimensions = 768",
			)
			.all();
		if (rows.length === 0) {
			throw new Error("Memory index has no segment embeddings");
		}
		const segmentCount = this.count("memory_segments");
		if (rows.length !== segmentCount) {
			throw new Error(
				`Memory index segment embeddings are incomplete: ${rows.length}/${segmentCount} segments have vectors`,
			);
		}
		return rows
			.map((row) => ({
				id: row.segment_id,
				distance: cosineDistance(queryEmbedding, decodeVector(row.embedding)),
			}))
			.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
			.slice(0, limit)
			.map((result, index) => ({ ...result, rank: index + 1 }));
	}

	searchHybrid(
		query: string,
		queryEmbedding: Float32Array,
		limit: number,
		options: HybridSearchOptions = {},
	): HybridSearchResult[] {
		if (limit <= 0) return [];
		const minVectorSimilarity = options.minVectorSimilarity ?? DEFAULT_MIN_VECTOR_SIMILARITY;
		const laneLimit = Math.max(limit * 2, limit);
		const candidateFilter = options.candidateIds ? { candidateIds: options.candidateIds } : {};
		const textIds = this.searchText(query, laneLimit, candidateFilter);
		const vectorResults = this.searchVector(queryEmbedding, laneLimit, {
			...candidateFilter,
			allowPartialEmbeddings: true,
		}).filter((result) => 1 - result.distance >= minVectorSimilarity);
		const fused = new Map<string, HybridSearchResult>();

		for (const [index, id] of textIds.entries()) {
			const rank = index + 1;
			const existing = fused.get(id) ?? { id, score: 0 };
			existing.textRank = rank;
			existing.score += reciprocalRank(rank);
			fused.set(id, existing);
		}
		for (const result of vectorResults) {
			const existing = fused.get(result.id) ?? { id: result.id, score: 0 };
			existing.vectorRank = result.rank;
			existing.vectorDistance = result.distance;
			existing.score += reciprocalRank(result.rank);
			fused.set(result.id, existing);
		}

		return [...fused.values()]
			.sort(
				(a, b) =>
					b.score - a.score ||
					(a.vectorDistance ?? Number.POSITIVE_INFINITY) -
						(b.vectorDistance ?? Number.POSITIVE_INFINITY) ||
					a.id.localeCompare(b.id),
			)
			.slice(0, limit);
	}

	stats(): MemoryIndexStats {
		return {
			memoryCount: this.count("memories"),
			segmentCount: this.count("memory_segments"),
			entityCount: this.count("memory_entities"),
			linkCount: this.count("memory_links"),
			embeddingCount: this.count("memory_embeddings"),
			segmentEmbeddingCount: this.count("memory_segment_embeddings"),
		};
	}

	private clear(): void {
		this.db.run("DELETE FROM memories");
		this.db.run("DELETE FROM memories_fts");
		this.db.run("DELETE FROM memory_embeddings");
		this.db.run("DELETE FROM memory_segments");
		this.db.run("DELETE FROM memory_segments_fts");
		this.db.run("DELETE FROM memory_segment_embeddings");
		this.db.run("DELETE FROM entities");
		this.db.run("DELETE FROM entities_fts");
		this.db.run("DELETE FROM memory_entities");
		this.db.run("DELETE FROM memory_links");
	}

	private count(table: string): number {
		const row = this.db.query<CountRow, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
		return row?.count ?? 0;
	}

	private activeMemoryIds(): Set<string> {
		const rows = this.db
			.query<MemoryIdRow, []>(
				`SELECT memories.id
				 FROM memories
				 WHERE memories.archived_at IS NULL
				   AND memories.superseded_by IS NULL
				   AND NOT EXISTS (
					 SELECT 1
					 FROM memory_links
					 WHERE memory_links.target_id = memories.id
					   AND memory_links.type = 'supersedes'
				   )`,
			)
			.all();
		return new Set(rows.map((row) => row.id));
	}
}

function entityIndexRows(memories: readonly Memory[]): EntityIndexRow[] {
	const byId = new Map<string, EntityIndexRow>();
	for (const memory of memories.filter(isActiveMemoryForRecall)) {
		for (const entity of memory.entity_links ?? []) {
			const id = entity.uuid;
			const key = `${entity.type}:${id}`;
			const existing = byId.get(key);
			if (existing) {
				existing.linkCount++;
				existing.lastLinkedAt = Math.max(
					existing.lastLinkedAt,
					memory.updated_at ?? memory.created,
				);
				continue;
			}
			byId.set(key, {
				id,
				name: entity.name,
				type: entity.type,
				linkCount: 1,
				createdAt: memory.created,
				lastLinkedAt: memory.updated_at ?? memory.created,
			});
		}
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function memoryEmbeddingVector(memory: Memory): Float32Array | undefined {
	if (!isActiveMemoryForRecall(memory)) return undefined;
	const embedding = memory.embedding;
	if (!embedding) return undefined;
	if (embedding.status !== "ready") {
		throw new Error(`Memory '${memory.id}' embedding status '${embedding.status}' is not ready`);
	}
	if (!embedding.vector) {
		throw new Error(`Memory '${memory.id}' has ready embedding metadata without a vector`);
	}
	if (embedding.dimensions !== VECTOR_DIMENSIONS) {
		throw new Error(
			`Memory '${memory.id}' embedding dimensions ${embedding.dimensions} do not match ${VECTOR_DIMENSIONS}`,
		);
	}
	const vector = Float32Array.from(embedding.vector);
	validateVector(vector, `memory '${memory.id}' embedding`);
	return vector;
}

function segmentEmbeddingVector(segment: MemorySegment): Float32Array | undefined {
	const embedding = segment.embedding;
	if (!embedding) return undefined;
	if (embedding.status !== "ready") {
		throw new Error(`Segment '${segment.id}' embedding status '${embedding.status}' is not ready`);
	}
	if (!embedding.vector) {
		throw new Error(`Segment '${segment.id}' has ready embedding metadata without a vector`);
	}
	if (embedding.dimensions !== VECTOR_DIMENSIONS) {
		throw new Error(
			`Segment '${segment.id}' embedding dimensions ${embedding.dimensions} do not match ${VECTOR_DIMENSIONS}`,
		);
	}
	const vector = Float32Array.from(embedding.vector);
	validateVector(vector, `segment '${segment.id}' embedding`);
	return vector;
}

function validateVector(vector: Float32Array, label: string): void {
	if (vector.length !== VECTOR_DIMENSIONS) {
		throw new Error(`${label} dimensions ${vector.length} do not match ${VECTOR_DIMENSIONS}`);
	}
	for (const value of vector) {
		if (!Number.isFinite(value)) {
			throw new Error(`${label} contains a non-finite value`);
		}
	}
}

function encodeVector(vector: Float32Array): Uint8Array {
	const bytes = new Uint8Array(vector.byteLength);
	bytes.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
	return bytes;
}

function decodeVector(bytes: Uint8Array): Float32Array {
	if (bytes.byteLength !== VECTOR_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) {
		throw new Error(
			`Stored embedding byte length ${bytes.byteLength} does not match ${VECTOR_DIMENSIONS} dimensions`,
		);
	}
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return new Float32Array(buffer);
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let magnitudeA = 0;
	let magnitudeB = 0;
	for (let index = 0; index < a.length; index++) {
		const valueA = a[index] ?? 0;
		const valueB = b[index] ?? 0;
		dot += valueA * valueB;
		magnitudeA += valueA * valueA;
		magnitudeB += valueB * valueB;
	}
	if (magnitudeA === 0 || magnitudeB === 0) {
		throw new Error("Cannot compute cosine distance for a zero-magnitude embedding");
	}
	return 1 - dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

function reciprocalRank(rank: number): number {
	return 1 / (RRF_K + rank);
}

function toFtsQuery(query: string): string {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.replace(/[^a-z0-9_]/g, ""))
		.filter((token) => token.length > 0)
		.join(" OR ");
}
