import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import {
	applyMemoryLinks,
	discoverLinkCandidates,
	discoverLinkCandidatesForNewMemories,
	healMemoryLinks,
	persistMemoryLinks,
	traverseMemoryLinks,
} from "../../src/genome/linking.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import { memoryShortId } from "../../src/genome/memory-schema.ts";
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

	test("discovers only candidates involving newly accepted memories", () => {
		const candidates = discoverLinkCandidatesForNewMemories({
			memories: [
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
					id: "new-detail",
					created: 310,
					content: "MIRA extraction should resolve memory relationships before recall.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [0.99, 0.01, 0],
					},
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
				memory({
					id: "old-sqlite",
					created: 100,
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
					id: "existing-detail",
					created: 200,
					content: "The MIRA port stores memory relationship metadata in SQLite.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [0.98, 0.02, 0],
					},
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			],
			newMemoryIds: new Set(["new-sqlite", "new-detail"]),
			options: { minVectorSimilarity: 0.95, minTfIdfSimilarity: 0.01 },
		});

		const pairs = candidates.map((candidate) => [candidate.source_id, candidate.target_id]);
		expect(pairs).toContainEqual(["new-sqlite", "old-sqlite"]);
		expect(pairs).toContainEqual(["new-detail", "old-sqlite"]);
		expect(pairs).toContainEqual(["new-detail", "new-sqlite"]);
		expect(pairs).not.toContainEqual(["existing-detail", "old-sqlite"]);
		expect(pairs).not.toContainEqual(["old-sqlite", "existing-detail"]);
	});

	test("new-memory discovery ignores inactive memories and dedupe-dropped new ids", () => {
		const candidates = discoverLinkCandidatesForNewMemories({
			memories: [
				memory({
					id: "accepted-new",
					created: 400,
					source_segment_id: "segment-1",
					content: "Sprout MIRA memory stores relationships before recall.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
				}),
				memory({
					id: "dropped-new",
					created: 390,
					source_segment_id: "segment-1",
					content: "Dropped duplicate should not receive links.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
				}),
				memory({
					id: "active-old",
					created: 100,
					content: "Sprout MIRA memory stores relationships before recall.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
				}),
				memory({
					id: "archived-old",
					created: 100,
					content: "Sprout MIRA memory stores relationships before recall.",
					archived_at: 123,
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
				}),
				memory({
					id: "superseded-old",
					created: 100,
					content: "Sprout MIRA memory stores relationships before recall.",
					superseded_by: "replacement",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
				}),
			],
			newMemoryIds: new Set(["accepted-new"]),
			options: { minVectorSimilarity: 0.95, minTfIdfSimilarity: 0.01 },
		});

		const candidateIds = candidates.flatMap((candidate) => [
			candidate.source_id,
			candidate.target_id,
		]);
		expect(candidateIds).toContain("accepted-new");
		expect(candidateIds).toContain("active-old");
		expect(candidateIds).not.toContain("dropped-new");
		expect(candidateIds).not.toContain("archived-old");
		expect(candidateIds).not.toContain("superseded-old");
	});

	test("new-memory discovery preserves explicit references outside heuristic limits", () => {
		const referencedByShortId = memory({
			id: "old-by-short",
			created: 100,
			content: "Prior memory about Streamlinear auth.",
		});
		const referencedByBatch = memory({
			id: "old-by-batch",
			created: 120,
			content: "Prior memory about Streamlinear bearer headers.",
		});
		const candidates = discoverLinkCandidatesForNewMemories({
			memories: [
				memory({
					id: "new-correction",
					created: 500,
					content: `Streamlinear auth correction supersedes ${memoryShortId(
						referencedByShortId.id,
					)}.`,
				}),
				referencedByShortId,
				referencedByBatch,
			],
			newMemoryIds: new Set(["new-correction"]),
			explicitReferencesByNewMemoryId: new Map([["new-correction", ["old-by-batch"]]]),
			options: { limit: 0, minVectorSimilarity: 1, minTfIdfSimilarity: 1 },
		});

		expect(candidates).toHaveLength(2);
		expect(candidates).toContainEqual(
			expect.objectContaining({
				source_id: "new-correction",
				target_id: "old-by-short",
				axes: ["explicit"],
			}),
		);
		expect(candidates).toContainEqual(
			expect.objectContaining({
				source_id: "new-correction",
				target_id: "old-by-batch",
				axes: ["explicit"],
			}),
		);
	});

	test("new-memory discovery keeps a new memory as source when timestamps tie", () => {
		const candidates = discoverLinkCandidatesForNewMemories({
			memories: [
				memory({
					id: "zzz-new",
					created: 100,
					content: "Sprout memory uses SQLite.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
				}),
				memory({
					id: "aaa-existing",
					created: 100,
					content: "Sprout memory uses SQLite.",
					embedding: {
						provider: "test",
						model: "test",
						dimensions: 3,
						status: "ready",
						vector: [1, 0, 0],
					},
				}),
			],
			newMemoryIds: new Set(["zzz-new"]),
			options: { minVectorSimilarity: 0.95, minTfIdfSimilarity: 0.01 },
		});

		expect(candidates).toContainEqual(
			expect.objectContaining({
				source_id: "zzz-new",
				target_id: "aaa-existing",
			}),
		);
	});

	test("new-memory discovery preserves explicit direction between new memories", () => {
		const target = memory({
			id: "aaa-target",
			created: 100,
			content: "The older-looking new memory is the target.",
		});
		const candidates = discoverLinkCandidatesForNewMemories({
			memories: [
				memory({
					id: "zzz-source",
					created: 100,
					content: `This correction explicitly references ${memoryShortId(target.id)}.`,
				}),
				target,
			],
			newMemoryIds: new Set(["zzz-source", "aaa-target"]),
			options: { limit: 0, minVectorSimilarity: 1, minTfIdfSimilarity: 1 },
		});

		expect(candidates).toContainEqual(
			expect.objectContaining({
				source_id: "zzz-source",
				target_id: "aaa-target",
				axes: ["explicit"],
			}),
		);
	});

	test("applies reciprocal refines links in memory", () => {
		const source = memory({ id: "new-memory", created: 200 });
		const target = memory({ id: "old-memory", created: 100 });
		const result = applyMemoryLinks(
			[source, target],
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

		expect(result).toEqual({ added: 1, changed: true });
		expect(source.outbound_links?.[0]).toMatchObject({
			uuid: "old-memory",
			type: "refines",
			created_at: 1234,
		});
		expect(target.inbound_links?.[0]).toMatchObject({
			uuid: "new-memory",
			type: "refines",
			created_at: 1234,
		});
	});

	test("applies conflicts links without deactivating either memory", () => {
		const source = memory({ id: "new-memory", created: 200 });
		const target = memory({ id: "old-memory", created: 100 });
		const result = applyMemoryLinks(
			[source, target],
			[
				{
					source_id: "new-memory",
					target_id: "old-memory",
					relationship_type: "conflicts",
					reasoning: "The newer memory contradicts the older claim.",
				},
			],
			{ now: 1234 },
		);

		expect(result).toEqual({ added: 1, changed: true });
		expect(source.outbound_links?.[0]?.type).toBe("conflicts");
		expect(target.inbound_links?.[0]?.type).toBe("conflicts");
		expect(source.superseded_by).toBeUndefined();
		expect(target.superseded_by).toBeUndefined();
	});

	test("applies supersedes links and deactivates the target memory", () => {
		const source = memory({ id: "new-memory", created: 200 });
		const target = memory({ id: "old-memory", created: 100 });
		const result = applyMemoryLinks(
			[source, target],
			[
				{
					source_id: "new-memory",
					target_id: "old-memory",
					relationship_type: "supersedes",
					reasoning: "The newer memory replaces the older claim.",
				},
			],
			{ now: 1234 },
		);

		expect(result).toEqual({ added: 1, changed: true });
		expect(source.outbound_links?.[0]?.type).toBe("supersedes");
		expect(target.inbound_links?.[0]?.type).toBe("supersedes");
		expect(target.superseded_by).toBe("new-memory");
	});

	test("ignores null links in memory", () => {
		const source = memory({ id: "new-memory", created: 200 });
		const target = memory({ id: "old-memory", created: 100 });
		const result = applyMemoryLinks(
			[source, target],
			[
				{
					source_id: "new-memory",
					target_id: "old-memory",
					relationship_type: "null",
					reasoning: "No meaningful relationship.",
				},
			],
			{ now: 1234 },
		);

		expect(result).toEqual({ added: 0, changed: false });
		expect(source.outbound_links).toBeUndefined();
		expect(target.inbound_links).toBeUndefined();
	});

	test("repairs reciprocal metadata without incrementing added links", () => {
		const source = memory({
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
		});
		const target = memory({ id: "old-memory", created: 100 });
		const result = applyMemoryLinks(
			[source, target],
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

		expect(result).toEqual({ added: 0, changed: true });
		expect(source.outbound_links).toHaveLength(1);
		expect(target.inbound_links?.[0]).toMatchObject({
			uuid: "new-memory",
			type: "supersedes",
		});
		expect(target.superseded_by).toBe("new-memory");
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
