import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import {
	applyConsolidationMerge,
	buildConsolidatedMemory,
	discoverConsolidationClusters,
	estimateDuplicateRate,
	estimateDuplicateRateAfterConsolidation,
	normalizeConsolidationDecisionPayload,
	projectDueForConsolidation,
	rejectConsolidationCluster,
	requestConsolidationDecisionWithSettings,
} from "../../src/genome/consolidation.ts";
import { git } from "../../src/genome/genome.ts";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import { attachReadyMemoryEmbedding } from "../../src/genome/memory-embedding.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import type { Memory } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import { FakeEmbeddingProvider } from "../../src/llm/embeddings.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
import { seedMemories } from "../helpers/genome-seed.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "memory-a",
		content: overrides.content ?? "Sprout stores memory in SQLite.",
		tags: overrides.tags ?? ["memory"],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1,
		...overrides,
	};
}

describe("memory consolidation", () => {
	test("synthetic 20 percent duplicate store collapses below five percent", () => {
		const memories: Memory[] = [];
		for (let index = 0; index < 16; index++) {
			memories.push(
				memory({
					id: `unique-${index}`,
					content: `Durable Sprout memory fact ${index} uses local SQLite indexes.`,
					created: index,
				}),
			);
		}
		for (let index = 0; index < 4; index++) {
			memories.push(
				memory({
					id: `duplicate-${index}`,
					content: `Durable Sprout memory fact ${index} uses local SQLite indexes.`,
					created: 100 + index,
				}),
			);
		}

		const clusters = discoverConsolidationClusters(memories, { fuzzyThreshold: 0.99 });

		expect(estimateDuplicateRate(memories, 0.99)).toBe(0.2);
		expect(clusters).toHaveLength(4);
		expect(estimateDuplicateRateAfterConsolidation(memories, clusters, 0.99)).toBeLessThan(0.05);
	});

	test("discovery and duplicate rate ignore inbound-superseded memories", () => {
		const memories = [
			memory({
				id: "active-memory",
				content: "Sprout stores memory in SQLite.",
			}),
			memory({
				id: "retired-memory",
				content: "Sprout stores memory in SQLite.",
				inbound_links: [
					{ uuid: "replacement", type: "supersedes", reasoning: "retired", created_at: 1 },
				],
			}),
		];

		expect(discoverConsolidationClusters(memories, { fuzzyThreshold: 0.99 })).toEqual([]);
		expect(estimateDuplicateRate(memories, 0.99)).toBe(0);
	});

	test("normalizes merge and rejection decisions from JSON", () => {
		const merge = normalizeConsolidationDecisionPayload(`\`\`\`json
{"action":"merge","memory":{"text":"Sprout uses local SQLite memory.","tags":["memory"]},"reasoning":"The duplicate facts are identical."}
\`\`\``);
		const reject = normalizeConsolidationDecisionPayload(
			`{"action":"reject","reasoning":"The facts are related but distinct."}`,
		);

		expect(merge.action).toBe("merge");
		expect(merge.memory?.text).toContain("SQLite");
		expect(merge.memory?.tags).toEqual(["memory"]);
		expect(reject.action).toBe("reject");
	});

	test("normalizer ignores draft entities and confidence for the unattended lane", () => {
		const merge = normalizeConsolidationDecisionPayload(
			JSON.stringify({
				action: "merge",
				memory: {
					text: "Sprout uses local SQLite memory.",
					tags: ["memory"],
					entities: [{ name: "Invented", type: "PROJECT", uuid: "entity_invented" }],
					confidence: 0.1,
				},
				reasoning: "The duplicate facts are identical.",
			}),
		);

		expect(merge.memory).toEqual({ text: "Sprout uses local SQLite memory.", tags: ["memory"] });
	});

	test("normalizer rejects merge drafts over the 2000-character text cap", () => {
		expect(() =>
			normalizeConsolidationDecisionPayload(
				JSON.stringify({
					action: "merge",
					memory: { text: "x".repeat(2001) },
					reasoning: "The duplicate facts are identical.",
				}),
			),
		).toThrow("2000");
	});

	test("settings wrapper resolves the consolidation memory model", async () => {
		let captured: Request | undefined;
		const client = {
			providers: () => ["openrouter"],
			complete: async (request: Request): Promise<Response> => {
				captured = request;
				return {
					id: "consolidation-test",
					model: request.model,
					provider: request.provider ?? "openrouter",
					message: Msg.assistant(
						JSON.stringify({
							action: "reject",
							reasoning: "The memories should remain separate.",
						}),
					),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				};
			},
		} as unknown as Client;

		await requestConsolidationDecisionWithSettings({
			cluster: {
				id: "cluster-a-b",
				memory_ids: ["a", "b"],
				memories: [memory({ id: "a" }), memory({ id: "b" })],
				reasons: ["fuzzy"],
				score: 0.9,
				rejection_count: 0,
				project_ids: [],
			},
			prompt: "consolidate",
			client,
			resolverSettings: createResolverSettings(
				[{ id: "openrouter", enabled: true }],
				{},
				{ consolidation: { providerId: "openrouter", modelId: "consolidation-model" } },
			),
			modelsByProvider: new Map([
				["openrouter", [{ id: "consolidation-model", label: "Consolidation", source: "remote" }]],
			]),
		});

		expect(captured?.provider).toBe("openrouter");
		expect(captured?.model).toBe("consolidation-model");
		expect(captured?.metadata?.purpose).toBe("memory.consolidation");
	});

	test("merge creates a consolidated memory and archives sources", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-consolidation-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await seedMemories(
				genome,
				memory({ id: "old-a", content: "Sprout memory uses SQLite." }),
				memory({ id: "old-b", content: "Sprout memory uses local SQLite." }),
			);
			const cluster = discoverConsolidationClusters(genome.memories.all(), {
				fuzzyThreshold: 0.8,
			})[0]!;
			const commitsBefore = Number(await git(root, "rev-list", "--count", "HEAD"));

			const result = await applyConsolidationMerge(
				genome,
				cluster,
				{
					text: "Sprout memory uses local SQLite.",
					tags: ["memory"],
					confidence: 0.95,
				},
				{ id: "merged-sqlite", now: 1234, reasoning: "safe duplicate consolidation" },
			);

			expect(result.archived_ids.sort()).toEqual(["old-a", "old-b"]);
			expect(genome.memories.getById("old-a")?.archived_reason).toBe(
				"consolidated into merged-sqlite",
			);
			expect(genome.memories.getById("old-b")?.superseded_by).toBe("merged-sqlite");
			expect(result.consolidated.consolidates_memory_ids?.sort()).toEqual(["old-a", "old-b"]);
			expect(result.consolidated.embedding?.status).toBe("ready");
			const commitsAfter = Number(await git(root, "rev-list", "--count", "HEAD"));
			expect(commitsAfter - commitsBefore).toBe(1);

			const content = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			expect(content).toContain('"archived_reason":"consolidated into merged-sqlite"');
			const index = MemoryIndex.open(memoryIndexPath(root));
			try {
				expect(index.stats().memoryCount).toBe(3);
				expect(index.stats().linkCount).toBe(2);
			} finally {
				index.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("merge draft entities use extraction-compatible UUIDs", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-consolidation-entities-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await seedMemories(
				genome,
				memory({ id: "entity-old-a", content: "Sprout memory uses SQLite." }),
				memory({ id: "entity-old-b", content: "Sprout memory uses SQLite." }),
			);
			const cluster = discoverConsolidationClusters(genome.memories.all(), {
				fuzzyThreshold: 0.8,
			})[0]!;

			const result = await applyConsolidationMerge(
				genome,
				cluster,
				{
					text: "Sprout memory uses SQLite.",
					entities: [{ name: "Sprout", type: "PROJECT" }],
				},
				{ id: "merged-entity", now: 1234, reasoning: "safe duplicate consolidation" },
			);

			expect(result.consolidated.entity_links).toEqual([
				{ uuid: "entity_project_sprout", name: "Sprout", type: "PROJECT" },
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("merge stages a pre-embedded memory without re-embedding under apply", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-consolidation-pre-embed-"));
		try {
			const embeddedTexts: string[] = [];
			const base = new FakeEmbeddingProvider();
			const provider = {
				provider: base.provider,
				model: base.model,
				dimensions: base.dimensions,
				embedBatch: (texts: readonly string[], options?: { kind?: "query" | "document" }) => {
					embeddedTexts.push(...texts);
					return base.embedBatch(texts, options);
				},
			};
			const genome = createTestGenome(root, undefined, { embeddingProvider: provider });
			await genome.init();
			await seedMemories(
				genome,
				memory({ id: "old-a", content: "Sprout memory uses SQLite." }),
				memory({ id: "old-b", content: "Sprout memory uses local SQLite." }),
			);
			const cluster = discoverConsolidationClusters(genome.memories.all(), {
				fuzzyThreshold: 0.8,
			})[0]!;
			const draft = { text: "Pre-embedded consolidated Sprout memory.", tags: ["memory"] };
			const built = buildConsolidatedMemory(cluster.memories, draft, {
				id: "merged-pre-embedded",
				now: 1234,
				reasoning: "safe duplicate consolidation",
			});
			const embedded = await attachReadyMemoryEmbedding(built, provider, { now: 1234 });

			const result = await applyConsolidationMerge(genome, cluster, draft, {
				id: "merged-pre-embedded",
				now: 1234,
				reasoning: "safe duplicate consolidation",
				preEmbedded: embedded,
			});

			expect(result.consolidated.id).toBe("merged-pre-embedded");
			expect(result.consolidated.embedding?.status).toBe("ready");
			expect(result.archived_ids.sort()).toEqual(["old-a", "old-b"]);
			expect(genome.memories.getById("old-a")?.superseded_by).toBe("merged-pre-embedded");
			expect(embeddedTexts.filter((text) => text === draft.text)).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejected clusters increment rejection counters", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-consolidation-reject-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await seedMemories(
				genome,
				memory({ id: "candidate-a", content: "Use SQLite memory." }),
				memory({ id: "candidate-b", content: "Use SQLite memory." }),
			);
			const cluster = discoverConsolidationClusters(genome.memories.all())[0]!;

			const updated = await rejectConsolidationCluster(
				genome,
				cluster,
				"Distinct provenance matters.",
				{
					now: 2000,
				},
			);

			expect(updated.sort()).toEqual(["candidate-a", "candidate-b"]);
			expect(genome.memories.getById("candidate-a")?.consolidation_rejection_count).toBe(1);
			expect(genome.memories.getById("candidate-b")?.annotations?.[0]?.text).toContain(
				"Distinct provenance matters",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejected clusters are idempotent for the same cluster and reason", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-consolidation-reject-idempotent-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await seedMemories(
				genome,
				memory({ id: "candidate-a", content: "Use SQLite memory." }),
				memory({ id: "candidate-b", content: "Use SQLite memory." }),
			);
			const cluster = discoverConsolidationClusters(genome.memories.all())[0]!;
			await rejectConsolidationCluster(genome, cluster, "Distinct provenance matters.", {
				now: 2000,
			});
			const head = await git(root, "rev-parse", "HEAD");

			const updated = await rejectConsolidationCluster(
				genome,
				cluster,
				"Distinct provenance matters.",
				{
					now: 3000,
				},
			);

			expect(updated).toEqual([]);
			expect(genome.memories.getById("candidate-a")?.consolidation_rejection_count).toBe(1);
			expect(genome.memories.getById("candidate-a")?.annotations).toHaveLength(1);
			expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("project-active-day schedule controls consolidation cadence", () => {
		expect(
			projectDueForConsolidation({
				id: "sprout",
				name: "Sprout",
				cumulative_active_days: 14,
			}),
		).toBe(true);
		expect(
			projectDueForConsolidation({
				id: "sprout",
				name: "Sprout",
				cumulative_active_days: 20,
				last_consolidated_active_day: 10,
			}),
		).toBe(false);
	});
});
