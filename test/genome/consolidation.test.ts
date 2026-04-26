import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyConsolidationMerge,
	discoverConsolidationClusters,
	estimateDuplicateRate,
	estimateDuplicateRateAfterConsolidation,
	normalizeConsolidationDecisionPayload,
	projectDueForConsolidation,
	rejectConsolidationCluster,
} from "../../src/genome/consolidation.ts";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import type { Memory } from "../../src/kernel/types.ts";
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

	test("normalizes merge and rejection decisions from JSON", () => {
		const merge = normalizeConsolidationDecisionPayload(`\`\`\`json
{"action":"merge","memory":{"text":"Sprout uses local SQLite memory.","tags":["memory"],"confidence":0.8},"reasoning":"The duplicate facts are identical."}
\`\`\``);
		const reject = normalizeConsolidationDecisionPayload(
			`{"action":"reject","reasoning":"The facts are related but distinct."}`,
		);

		expect(merge.action).toBe("merge");
		expect(merge.memory?.text).toContain("SQLite");
		expect(reject.action).toBe("reject");
	});

	test("merge creates a consolidated memory and archives sources", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-consolidation-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(memory({ id: "old-a", content: "Sprout memory uses SQLite." }));
			await genome.addMemory(memory({ id: "old-b", content: "Sprout memory uses local SQLite." }));
			const cluster = discoverConsolidationClusters(genome.memories.all(), {
				fuzzyThreshold: 0.8,
			})[0]!;

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

	test("rejected clusters increment rejection counters", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-consolidation-reject-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(memory({ id: "candidate-a", content: "Use SQLite memory." }));
			await genome.addMemory(memory({ id: "candidate-b", content: "Use SQLite memory." }));
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
