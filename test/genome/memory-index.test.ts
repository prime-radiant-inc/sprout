import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlStore } from "../../src/genome/jsonl-store.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import { normalizeMemory } from "../../src/genome/memory-schema.ts";
import { type MemorySegment, normalizeSegment } from "../../src/genome/segments.ts";
import type { Memory } from "../../src/kernel/types.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return normalizeMemory({
		id: overrides.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		content: overrides.content ?? "default memory content",
		tags: overrides.tags ?? ["default"],
		source: overrides.source ?? "test",
		created: overrides.created ?? Date.now(),
		last_used: overrides.last_used ?? Date.now(),
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1.0,
		...overrides,
	});
}

function embeddingVector(slot: number): number[] {
	const vector = new Array<number>(768).fill(0);
	vector[slot] = 1;
	return vector;
}

function makeEmbedding(slot: number): NonNullable<Memory["embedding"]> {
	return {
		provider: "local",
		model: "MongoDB/mdbr-leaf-ir",
		dimensions: 768,
		status: "ready",
		vector: embeddingVector(slot),
	};
}

function makeSegment(overrides: Partial<MemorySegment> = {}): MemorySegment {
	return normalizeSegment({
		id: overrides.id ?? "seg-1",
		session_id: overrides.session_id ?? "session-1",
		title: overrides.title ?? "Session summary",
		summary: overrides.summary ?? "local memory work",
		started_at: overrides.started_at ?? Date.now(),
		ended_at: overrides.ended_at ?? Date.now(),
		created_at: overrides.created_at ?? Date.now(),
		message_count: overrides.message_count ?? 2,
		project_id: overrides.project_id ?? "sprout",
		project_confidence: overrides.project_confidence ?? 0.9,
		complexity: overrides.complexity ?? 2,
		source: "session-collapse",
		...overrides,
	});
}

describe("MemoryIndex", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-memory-index-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates schema and rebuilds from memory records", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({ id: "idx-1", content: "typescript compiler error" }),
				makeMemory({
					id: "idx-2",
					content: "auth module lives in src/auth",
					entity_links: [{ uuid: "entity-sprout", type: "PROJECT", name: "Sprout" }],
					outbound_links: [
						{
							uuid: "idx-1",
							type: "contextualizes",
							reasoning: "same implementation session",
							created_at: 1700000000000,
						},
					],
				}),
			]);

			expect(index.stats()).toEqual({
				memoryCount: 2,
				segmentCount: 0,
				entityCount: 1,
				linkCount: 1,
				embeddingCount: 0,
				segmentEmbeddingCount: 0,
			});
		} finally {
			index.close();
		}
	});

	test("searches indexed text with FTS5", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({ id: "idx-typescript", content: "typescript compiler error" }),
				makeMemory({ id: "idx-python", content: "python runtime failure" }),
			]);

			expect(index.searchText("compiler", 5)).toEqual(["idx-typescript"]);
		} finally {
			index.close();
		}
	});

	test("searches canonical entities with FTS5", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({
					id: "idx-sprout",
					content: "memory work",
					entity_links: [{ uuid: "entity-sprout", type: "PROJECT", name: "Sprout" }],
				}),
				makeMemory({
					id: "idx-sqlite",
					content: "sqlite work",
					entity_links: [{ uuid: "entity-sqlite", type: "TECHNOLOGY", name: "SQLite" }],
				}),
			]);

			expect(index.searchEntities("sprout", { type: "PROJECT" })).toEqual([
				{
					uuid: "entity-sprout",
					type: "PROJECT",
					name: "Sprout",
					rank: expect.any(Number),
				},
			]);
		} finally {
			index.close();
		}
	});

	test("keeps same-uuid entities separate by type", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({
					id: "idx-project-sprout",
					content: "project memory",
					entity_links: [{ uuid: "entity-sprout", type: "PROJECT", name: "Sprout" }],
				}),
				makeMemory({
					id: "idx-tech-sprout",
					content: "technology memory",
					entity_links: [{ uuid: "entity-sprout", type: "TECHNOLOGY", name: "Sprout" }],
				}),
			]);

			expect(index.searchEntities("sprout", { type: "PROJECT" })).toEqual([
				{
					uuid: "entity-sprout",
					type: "PROJECT",
					name: "Sprout",
					rank: expect.any(Number),
				},
			]);
			expect(index.searchEntities("sprout", { type: "TECHNOLOGY" })).toEqual([
				{
					uuid: "entity-sprout",
					type: "TECHNOLOGY",
					name: "Sprout",
					rank: expect.any(Number),
				},
			]);
		} finally {
			index.close();
		}
	});

	test("rebuilds from JSONL-loaded legacy fixture records", async () => {
		const fixture = new JsonlStore<unknown>(
			join(process.cwd(), "test/fixtures/memory/legacy-memories.jsonl"),
		);
		const records = (await fixture.load()).map((record) => normalizeMemory(record));
		const index = MemoryIndex.open(join(tempDir, "index.db"));
		try {
			index.rebuild(records);

			expect(index.stats().memoryCount).toBe(4);
			expect(index.searchText("typecheck", 5)).toEqual(["legacy-learn"]);
		} finally {
			index.close();
		}
	});

	test("rebuild clears records from previous generations", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([makeMemory({ id: "old", content: "old content" })]);
			index.rebuild([makeMemory({ id: "new", content: "new content" })]);

			expect(index.stats().memoryCount).toBe(1);
			expect(index.stats().embeddingCount).toBe(0);
			expect(index.searchText("old", 5)).toEqual([]);
			expect(index.searchText("new", 5)).toEqual(["new"]);
		} finally {
			index.close();
		}
	});

	test("stores memory embeddings and searches by cosine distance", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({
					id: "idx-vector-a",
					content: "typescript compiler error",
					embedding: makeEmbedding(0),
				}),
				makeMemory({
					id: "idx-vector-b",
					content: "python runtime failure",
					embedding: makeEmbedding(1),
				}),
			]);

			const results = index.searchVector(Float32Array.from(embeddingVector(0)), 2);

			expect(index.stats().embeddingCount).toBe(2);
			expect(results.map((result) => result.id)).toEqual(["idx-vector-a", "idx-vector-b"]);
			expect(results[0]!.distance).toBeCloseTo(0, 5);
		} finally {
			index.close();
		}
	});

	test("indexes collapsed session segments with text and vectors", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild(
				[makeMemory({ id: "idx-memory", content: "memory content" })],
				[
					makeSegment({
						id: "seg-sqlite",
						title: "SQLite memory work",
						summary: "Implemented SQLite segment indexing",
						embedding: makeEmbedding(0),
					}),
				],
			);

			expect(index.stats().segmentCount).toBe(1);
			expect(index.stats().segmentEmbeddingCount).toBe(1);
			expect(index.searchSegmentsText("sqlite", 5)).toEqual(["seg-sqlite"]);
			expect(index.searchSegmentsVector(Float32Array.from(embeddingVector(0)), 1)[0]?.id).toBe(
				"seg-sqlite",
			);
		} finally {
			index.close();
		}
	});

	test("hybrid search can surface vector results without keyword overlap", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({
					id: "idx-semantic",
					content: "use raw sqlite for local memory indexes",
					embedding: makeEmbedding(0),
				}),
				makeMemory({
					id: "idx-keyword",
					content: "database migration command",
					embedding: makeEmbedding(1),
				}),
			]);

			const results = index.searchHybrid("database", Float32Array.from(embeddingVector(0)), 2);
			const semantic = results.find((result) => result.id === "idx-semantic");

			expect(results.map((result) => result.id)).toContain("idx-semantic");
			expect(semantic?.vectorRank).toBe(1);
			expect(semantic?.textRank).toBeUndefined();
		} finally {
			index.close();
		}
	});

	test("hybrid search only ranks eligible candidate ids", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({
					id: "idx-active",
					content: "database migration command",
					embedding: makeEmbedding(1),
				}),
				makeMemory({
					id: "idx-archived-missing-vector",
					content: "database migration command",
					archived_at: 1234,
				}),
			]);

			const results = index.searchHybrid("database", Float32Array.from(embeddingVector(1)), 2, {
				candidateIds: new Set(["idx-active"]),
			});

			expect(results.map((result) => result.id)).toEqual(["idx-active"]);
		} finally {
			index.close();
		}
	});

	test("vector search fails when no embeddings are indexed", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([makeMemory({ id: "idx-no-vector", content: "plain text only" })]);

			expect(() => index.searchVector(Float32Array.from(embeddingVector(0)), 5)).toThrow(
				"no embeddings",
			);
		} finally {
			index.close();
		}
	});

	test("vector search fails when only some memories have embeddings", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({
					id: "idx-vector-present",
					content: "embedded",
					embedding: makeEmbedding(0),
				}),
				makeMemory({ id: "idx-vector-missing", content: "missing embedding" }),
			]);

			expect(() => index.searchVector(Float32Array.from(embeddingVector(0)), 5)).toThrow(
				"embeddings are incomplete",
			);
		} finally {
			index.close();
		}
	});

	test("rebuild fails when ready embedding metadata has no vector", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			expect(() =>
				index.rebuild([
					makeMemory({
						id: "idx-missing-vector",
						content: "bad embedding",
						embedding: {
							provider: "local",
							model: "MongoDB/mdbr-leaf-ir",
							dimensions: 768,
							status: "ready",
						},
					}),
				]),
			).toThrow("without a vector");
		} finally {
			index.close();
		}
	});

	test("rebuild fails when embedding status is not ready", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			expect(() =>
				index.rebuild([
					makeMemory({
						id: "idx-pending-vector",
						content: "pending embedding",
						embedding: {
							provider: "local",
							model: "MongoDB/mdbr-leaf-ir",
							dimensions: 768,
							status: "pending",
						},
					}),
				]),
			).toThrow("is not ready");
		} finally {
			index.close();
		}
	});
});
