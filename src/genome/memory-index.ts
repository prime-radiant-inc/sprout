import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Memory } from "../kernel/types.ts";
import { MEMORY_SCHEMA_VERSION, normalizeMemory } from "./memory-schema.ts";

const INDEX_SCHEMA_VERSION = 2;
const VECTOR_DIMENSIONS = 768;
const RRF_K = 60;

export interface MemoryIndexStats {
	memoryCount: number;
	entityCount: number;
	linkCount: number;
	embeddingCount: number;
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

	close(): void {
		this.db.close();
	}

	ensureSchema(): void {
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
				archived_at INTEGER
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
			CREATE TABLE IF NOT EXISTS entities (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				entity_type TEXT NOT NULL,
				link_count INTEGER NOT NULL DEFAULT 0,
				last_linked_at INTEGER,
				created_at INTEGER NOT NULL
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_entities (
				memory_id TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				entity_type TEXT NOT NULL,
				name TEXT NOT NULL,
				PRIMARY KEY (memory_id, entity_id)
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
		this.db.run(`
			CREATE TABLE IF NOT EXISTS annotations (
				memory_id TEXT NOT NULL,
				text TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				cumulative_active_days INTEGER NOT NULL DEFAULT 0,
				last_active_date TEXT
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

	rebuild(memories: readonly Memory[]): void {
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
				archived_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		const insertMemoryEntity = this.db.prepare(
			`INSERT OR REPLACE INTO memory_entities (
				memory_id,
				entity_id,
				entity_type,
				name
			) VALUES (?, ?, ?, ?)`,
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
		const insertAnnotation = this.db.prepare(
			"INSERT INTO annotations (memory_id, text, source, created_at) VALUES (?, ?, ?, ?)",
		);

		const run = this.db.transaction((records: readonly Memory[]) => {
			this.clear();
			for (const record of records) {
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
				for (const annotation of memory.annotations ?? []) {
					insertAnnotation.run(
						memory.id,
						annotation.text,
						annotation.source,
						annotation.created_at,
					);
				}
			}
		});

		run(memories);
	}

	searchText(query: string, limit: number): string[] {
		const normalized = toFtsQuery(query);
		if (!normalized) return [];
		const rows = this.db
			.query<MemorySearchRow, [string, number]>(
				`SELECT id, bm25(memories_fts) AS rank
				 FROM memories_fts
				 WHERE memories_fts MATCH ?
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(normalized, limit);
		return rows.map((row) => row.id);
	}

	searchVector(queryEmbedding: Float32Array, limit: number): VectorSearchResult[] {
		validateVector(queryEmbedding, "query embedding");
		const rows = this.db
			.query<MemoryEmbeddingRow, []>(
				"SELECT memory_id, embedding FROM memory_embeddings WHERE dimensions = 768",
			)
			.all();
		if (rows.length === 0) {
			throw new Error("Memory index has no embeddings; memory writes must create ready vectors");
		}
		const memoryCount = this.count("memories");
		if (rows.length !== memoryCount) {
			throw new Error(
				`Memory index embeddings are incomplete: ${rows.length}/${memoryCount} memories have vectors`,
			);
		}
		return rows
			.map((row) => ({
				id: row.memory_id,
				distance: cosineDistance(queryEmbedding, decodeVector(row.embedding)),
			}))
			.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
			.slice(0, limit)
			.map((result, index) => ({ ...result, rank: index + 1 }));
	}

	searchHybrid(query: string, queryEmbedding: Float32Array, limit: number): HybridSearchResult[] {
		if (limit <= 0) return [];
		const laneLimit = Math.max(limit * 2, limit);
		const textIds = this.searchText(query, laneLimit);
		const vectorResults = this.searchVector(queryEmbedding, laneLimit);
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
			entityCount: this.count("memory_entities"),
			linkCount: this.count("memory_links"),
			embeddingCount: this.count("memory_embeddings"),
		};
	}

	private clear(): void {
		this.db.run("DELETE FROM memories");
		this.db.run("DELETE FROM memories_fts");
		this.db.run("DELETE FROM memory_embeddings");
		this.db.run("DELETE FROM memory_entities");
		this.db.run("DELETE FROM memory_links");
		this.db.run("DELETE FROM annotations");
	}

	private count(table: string): number {
		const row = this.db.query<CountRow, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
		return row?.count ?? 0;
	}
}

function memoryEmbeddingVector(memory: Memory): Float32Array | undefined {
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
