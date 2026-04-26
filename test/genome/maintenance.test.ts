import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyMemoryMaintenanceDecisions,
	discoverMemoryMaintenancePlan,
	parseMemoryMaintenanceDecisionFile,
	renderMemoryMaintenancePlan,
} from "../../src/genome/maintenance.ts";
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

describe("memory maintenance operator flow", () => {
	test("dry run renders consolidation and entity GC candidates", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-dry-run-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "memory-a",
					content: "Sprout memory uses SQLite.",
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "memory-b",
					content: "Sprout memory uses SQLite.",
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);

			const plan = discoverMemoryMaintenancePlan(genome);
			const rendered = renderMemoryMaintenancePlan(plan);

			expect(plan.consolidationClusters).toHaveLength(1);
			expect(plan.entityGcGroups).toHaveLength(1);
			expect(rendered).toContain("Consolidation clusters: 1");
			expect(rendered).toContain("Entity GC groups: 1");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply uses reviewed decision files instead of automerging", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-apply-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(memory({ id: "old-a", content: "Sprout memory uses SQLite." }));
			await genome.addMemory(memory({ id: "old-b", content: "Sprout memory uses SQLite." }));
			const plan = discoverMemoryMaintenancePlan(genome, { includeEntityGc: false });
			const cluster = plan.consolidationClusters[0]!;
			const decisions = parseMemoryMaintenanceDecisionFile(
				JSON.stringify({
					consolidations: [
						{
							cluster_id: cluster.id,
							action: "merge",
							memory: {
								text: "Sprout memory uses SQLite.",
								tags: ["memory"],
								confidence: 0.95,
							},
							reasoning: "Reviewed duplicate memories.",
						},
					],
				}),
			);

			const result = await applyMemoryMaintenanceDecisions(genome, plan, decisions);

			expect(result.consolidation.merged).toBe(1);
			expect(result.consolidation.archived_memory_ids).toEqual(["old-a", "old-b"]);
			expect(genome.memories.getById("old-a")?.superseded_by).toBeDefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
