import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import {
	discoverLinkCandidates,
	healMemoryLinks,
	persistMemoryLinks,
	traverseMemoryLinks,
} from "../../src/genome/linking.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import type { Memory } from "../../src/kernel/types.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "memory-a",
		content: overrides.content ?? "Sprout memory uses local SQLite.",
		tags: overrides.tags ?? ["memory"],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1,
		...overrides,
	};
}

describe("memory link graph", () => {
	test("discovers candidates across vector, entity, and tfidf axes", () => {
		const candidates = discoverLinkCandidates(
			[
				memory({
					id: "new-sqlite",
					created: 300,
					content: "Sprout MIRA memory uses SQLite and local embeddings.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
				memory({
					id: "old-sqlite",
					created: 200,
					content: "The MIRA port stores long-term memory in SQLite.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [0.98, 0.02, 0],
					},
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
				memory({
					id: "unrelated",
					created: 100,
					content: "Verifier agents run tests and report evidence.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [0, 1, 0],
					},
				}),
			],
			{ minVectorSimilarity: 0.95, minTfIdfSimilarity: 0.01 },
		);

		const sqlitePair = candidates.find((candidate) => candidate.target_id === "old-sqlite");
		expect(sqlitePair).toMatchObject({
			source_id: "new-sqlite",
			target_id: "old-sqlite",
		});
		expect(sqlitePair?.axes).toContain("vector");
		expect(sqlitePair?.axes).toContain("entity");
		expect(sqlitePair?.axes).toContain("tfidf");
	});

	test("discovery and traversal ignore superseded memories", () => {
		const active = memory({
			id: "active",
			created: 300,
			content: "Sprout memory uses SQLite and local embeddings.",
			embedding: {
				provider: "test",
				model: "test",
				dimensions: 3,
				status: "ready",
				vector: [1, 0, 0],
			},
			entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			outbound_links: [
				{ uuid: "detail", type: "refines", reasoning: "active detail", created_at: 1 },
				{ uuid: "stale-field", type: "refines", reasoning: "retired", created_at: 1 },
				{ uuid: "stale-inbound", type: "refines", reasoning: "retired", created_at: 1 },
			],
		});
		const detail = memory({
			id: "detail",
			created: 200,
			content: "The MIRA port stores long-term memory in SQLite.",
			embedding: {
				provider: "test",
				model: "test",
				dimensions: 3,
				status: "ready",
				vector: [0.98, 0.02, 0],
			},
			entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
		});
		const staleField = memory({
			id: "stale-field",
			created: 100,
			content: "Sprout memory uses SQLite and local embeddings.",
			superseded_by: "replacement",
			embedding: {
				provider: "test",
				model: "test",
				dimensions: 3,
				status: "ready",
				vector: [1, 0, 0],
			},
			entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
		});
		const staleInbound = memory({
			id: "stale-inbound",
			created: 90,
			content: "Sprout memory uses SQLite and local embeddings.",
			inbound_links: [
				{ uuid: "replacement", type: "supersedes", reasoning: "retired", created_at: 1 },
			],
			embedding: {
				provider: "test",
				model: "test",
				dimensions: 3,
				status: "ready",
				vector: [1, 0, 0],
			},
			entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
		});

		const candidates = discoverLinkCandidates([active, detail, staleField, staleInbound], {
			minVectorSimilarity: 0.95,
			minTfIdfSimilarity: 0.01,
		});
		const candidateIds = candidates.flatMap((candidate) => [
			candidate.source_id,
			candidate.target_id,
		]);
		expect(candidateIds).not.toContain("stale-field");
		expect(candidateIds).not.toContain("stale-inbound");

		const traversed = traverseMemoryLinks([active, detail, staleField, staleInbound], "active");
		expect(traversed.map((result) => result.memory.id)).toEqual(["detail"]);
	});

	test("persists classified relationships to JSONL and the SQLite index", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-linking-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(memory({ id: "new-memory", created: 200 }));
			await genome.addMemory(memory({ id: "old-memory", created: 100 }));

			const added = await persistMemoryLinks(
				genome,
				[
					{
						source_id: "new-memory",
						target_id: "old-memory",
						relationship_type: "refines",
						reasoning: "The newer memory adds implementation detail.",
					},
				],
				{ now: 1234 },
			);

			expect(added).toBe(1);
			expect(genome.memories.getById("new-memory")?.outbound_links?.[0]).toMatchObject({
				uuid: "old-memory",
				type: "refines",
			});
			expect(genome.memories.getById("old-memory")?.inbound_links?.[0]).toMatchObject({
				uuid: "new-memory",
				type: "refines",
			});
			const content = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			expect(content).toContain('"outbound_links"');

			const index = MemoryIndex.open(memoryIndexPath(root));
			try {
				expect(index.stats().linkCount).toBe(1);
			} finally {
				index.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("persists reciprocal and superseded repairs when outbound link already exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-link-repair-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(memory({ id: "old-memory", created: 100 }));
			await genome.addMemory(
				memory({
					id: "new-memory",
					created: 200,
					outbound_links: [
						{
							uuid: "old-memory",
							type: "supersedes",
							reasoning: "existing outbound",
							created_at: 1,
						},
					],
				}),
			);

			const added = await persistMemoryLinks(
				genome,
				[
					{
						source_id: "new-memory",
						target_id: "old-memory",
						relationship_type: "supersedes",
						reasoning: "existing outbound",
					},
				],
				{ now: 1234 },
			);

			expect(added).toBe(0);
			const reloaded = createTestGenome(root);
			await reloaded.loadFromDisk();
			expect(reloaded.memories.getById("old-memory")?.superseded_by).toBe("new-memory");
			expect(reloaded.memories.getById("old-memory")?.inbound_links?.[0]).toMatchObject({
				uuid: "new-memory",
				type: "supersedes",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("traverses linked memories by relationship weight and ignores dead refs", () => {
		const start = memory({
			id: "start",
			outbound_links: [
				{ uuid: "conflict", type: "conflicts", reasoning: "different value", created_at: 1 },
				{ uuid: "detail", type: "refines", reasoning: "adds details", created_at: 1 },
				{ uuid: "missing", type: "corroborates", reasoning: "dead", created_at: 1 },
			],
		});
		const results = traverseMemoryLinks(
			[
				start,
				memory({ id: "detail", confidence: 0.7 }),
				memory({ id: "conflict", confidence: 0.7 }),
			],
			"start",
		);

		expect(results.map((result) => result.memory.id)).toEqual(["conflict", "detail"]);
		expect(results[0]?.type).toBe("conflicts");
	});

	test("heals dead JSONL link references and commits the mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-link-heal-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "alive",
					outbound_links: [{ uuid: "missing", type: "refines", reasoning: "dead", created_at: 1 }],
				}),
			);

			const removed = await healMemoryLinks(genome);

			expect(removed).toBe(1);
			expect(genome.memories.getById("alive")?.outbound_links).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
