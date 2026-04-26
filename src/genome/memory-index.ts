import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Memory } from "../kernel/types.ts";
import { MEMORY_SCHEMA_VERSION, normalizeMemory } from "./memory-schema.ts";

const INDEX_SCHEMA_VERSION = 1;

export interface MemoryIndexStats {
	memoryCount: number;
	entityCount: number;
	linkCount: number;
}

interface CountRow {
	count: number;
}

interface MemorySearchRow {
	id: string;
	rank: number;
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
		this.db.run(`
			CREATE TABLE IF NOT EXISTS pending_embeddings (
				memory_id TEXT PRIMARY KEY,
				provider TEXT,
				model TEXT,
				reason TEXT NOT NULL,
				created_at INTEGER NOT NULL
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

	stats(): MemoryIndexStats {
		return {
			memoryCount: this.count("memories"),
			entityCount: this.count("memory_entities"),
			linkCount: this.count("memory_links"),
		};
	}

	private clear(): void {
		this.db.run("DELETE FROM memories");
		this.db.run("DELETE FROM memories_fts");
		this.db.run("DELETE FROM memory_entities");
		this.db.run("DELETE FROM memory_links");
		this.db.run("DELETE FROM annotations");
		this.db.run("DELETE FROM pending_embeddings");
	}

	private count(table: string): number {
		const row = this.db.query<CountRow, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
		return row?.count ?? 0;
	}
}

function toFtsQuery(query: string): string {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.replace(/[^a-z0-9_]/g, ""))
		.filter((token) => token.length > 0)
		.join(" OR ");
}
