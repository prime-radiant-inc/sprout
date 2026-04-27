import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { type Genome, git } from "../../src/genome/genome.ts";
import {
	applyMemoryMaintenanceDecisions,
	discoverMemoryMaintenancePlan,
	parseMemoryMaintenanceDecisionFile,
	renderMemoryMaintenancePlan,
	reviewMemoryMaintenancePlanWithSettings,
} from "../../src/genome/maintenance.ts";
import type { Memory } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
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

function recordActiveDays(genome: Genome, projectId = "sprout", count = 30): void {
	for (let index = 0; index < count; index++) {
		genome.projects.recordActiveDay(
			{ id: projectId, name: projectId, confidence: 1, source: "explicit" },
			new Date(Date.UTC(2026, 0, index + 1)),
		);
	}
}

describe("memory maintenance operator flow", () => {
	test("parse rejects consolidation merge confidence outside 0..1", () => {
		for (const confidence of [-1, 999]) {
			expect(() =>
				parseMemoryMaintenanceDecisionFile(
					JSON.stringify({
						consolidations: [
							{
								cluster_id: "cluster-a",
								action: "merge",
								reasoning: "Reviewed duplicate memories.",
								memory: {
									text: "Sprout stores memory in SQLite.",
									confidence,
								},
							},
						],
					}),
				),
			).toThrow("confidence must be between 0 and 1");
		}
	});

	test("dry run renders consolidation and entity GC candidates", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-dry-run-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "memory-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "memory-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
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

	test("configured maintenance models review discovered consolidation and entity GC candidates", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-review-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "memory-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "memory-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);
			const captured: Request[] = [];
			const client = {
				providers: () => ["openrouter"],
				complete: async (request: Request): Promise<Response> => {
					captured.push(request);
					return {
						id: "maintenance-review",
						model: request.model,
						provider: request.provider ?? "openrouter",
						message: Msg.assistant(
							JSON.stringify({
								action: "reject",
								reasoning: "The candidates should remain separate.",
							}),
						),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					};
				},
			} as unknown as Client;

			const decisions = await reviewMemoryMaintenancePlanWithSettings({
				plan: discoverMemoryMaintenancePlan(genome),
				client,
				resolverSettings: createResolverSettings(
					[{ id: "openrouter", enabled: true }],
					{},
					{
						consolidation: {
							providerId: "openrouter",
							modelId: "consolidation-model",
						},
						entityGc: {
							providerId: "openrouter",
							modelId: "entity-gc-model",
						},
					},
				),
				modelsByProvider: new Map([
					[
						"openrouter",
						[
							{ id: "consolidation-model", label: "Consolidation", source: "remote" },
							{ id: "entity-gc-model", label: "Entity GC", source: "remote" },
						],
					],
				]),
				consolidationPrompt: "consolidate",
				entityGcPrompt: "entity gc",
			});

			expect(decisions.consolidations).toHaveLength(1);
			expect(decisions.entity_gc).toHaveLength(1);
			expect(captured.map((request) => request.metadata?.purpose)).toEqual([
				"memory.consolidation",
				"memory.entityGc",
			]);
			expect(captured.map((request) => request.model)).toEqual([
				"consolidation-model",
				"entity-gc-model",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("dry run skips projects before their active-day cadence", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-not-due-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome, "sprout", 13);
			await genome.addMemory(
				memory({
					id: "memory-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "memory-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);

			const plan = discoverMemoryMaintenancePlan(genome);

			expect(plan.consolidationClusters).toHaveLength(0);
			expect(plan.entityGcGroups).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("dry run includes unscoped memories on the global cadence", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-global-dry-run-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(memory({ id: "global-a", content: "Global memory uses SQLite." }));
			await genome.addMemory(memory({ id: "global-b", content: "Global memory uses SQLite." }));

			const plan = discoverMemoryMaintenancePlan(genome, { includeEntityGc: false });

			expect(plan.consolidationClusters).toHaveLength(1);
			expect(plan.consolidationClusters[0]?.project_ids).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply uses reviewed decision files instead of automerging", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-apply-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome, "sprout", 14);
			await genome.addMemory(
				memory({
					id: "old-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
			await genome.addMemory(
				memory({
					id: "old-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
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
			expect(genome.projects.getById("sprout")?.last_consolidated_active_day).toBe(14);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply does not advance entity-GC cadence when consolidation retires the same memories", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-overlap-entity-gc-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "old-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "old-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);
			const plan = discoverMemoryMaintenancePlan(genome);
			const cluster = plan.consolidationClusters[0]!;
			const group = plan.entityGcGroups[0]!;

			const result = await applyMemoryMaintenanceDecisions(genome, plan, {
				consolidations: [
					{
						cluster_id: cluster.id,
						action: "merge",
						memory: {
							text: "Sprout memory uses SQLite.",
							tags: ["memory"],
							entities: [],
							confidence: 0.95,
						},
						reasoning: "Reviewed duplicate memories.",
					},
				],
				entity_gc: [
					{
						group_id: group.id,
						action: "reject",
						reasoning: "Would have reviewed aliases if memories remained active.",
					},
				],
			});

			expect(result.consolidation.merged).toBe(1);
			expect(result.entity_gc.rejected).toBe(0);
			expect(result.entity_gc.updated_memory_ids).toEqual([]);
			expect(genome.projects.getById("sprout")?.last_consolidated_active_day).toBe(30);
			expect(genome.projects.getById("sprout")?.last_entity_gc_active_day).toBeUndefined();
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply validates all decisions before mutating memories", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-prevalidate-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "old-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
			await genome.addMemory(
				memory({
					id: "old-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
			const plan = discoverMemoryMaintenancePlan(genome, { includeEntityGc: false });
			const cluster = plan.consolidationClusters[0]!;
			const head = await git(root, "rev-parse", "HEAD");

			await expect(
				applyMemoryMaintenanceDecisions(genome, plan, {
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
						{
							cluster_id: "missing-cluster",
							action: "reject",
							reasoning: "Invalid later decision.",
						},
					],
				}),
			).rejects.toThrow("Unknown consolidation cluster");

			expect(genome.memories.getById("old-a")?.superseded_by).toBeUndefined();
			expect(genome.memories.getById("old-b")?.superseded_by).toBeUndefined();
			expect(await git(root, "rev-parse", "HEAD")).toBe(head);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply restores all memory edits when cadence save fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-transaction-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome, "sprout", 14);
			await genome.addMemory(
				memory({
					id: "old-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
			await genome.addMemory(
				memory({
					id: "old-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
			const plan = discoverMemoryMaintenancePlan(genome, { includeEntityGc: false });
			const cluster = plan.consolidationClusters[0]!;
			const beforeHead = await git(root, "rev-parse", "HEAD");
			const beforeMemories = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			const originalProjectSave = genome.projects.save.bind(genome.projects);
			genome.projects.save = async () => {
				await originalProjectSave();
				throw new Error("project cadence save failed");
			};

			try {
				await expect(
					applyMemoryMaintenanceDecisions(genome, plan, {
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
				).rejects.toThrow("project cadence save failed");
			} finally {
				genome.projects.save = originalProjectSave;
			}

			expect(genome.memories.getById("old-a")?.superseded_by).toBeUndefined();
			expect(genome.memories.getById("old-b")?.superseded_by).toBeUndefined();
			expect(
				genome.memories.all().some((candidate) => candidate.consolidates_memory_ids?.length),
			).toBe(false);
			expect(await readFile(join(root, "memories", "memories.jsonl"), "utf-8")).toBe(
				beforeMemories,
			);
			expect(await git(root, "rev-parse", "HEAD")).toBe(beforeHead);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply rejects overlapping consolidation merges before mutating memories", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-overlap-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "old-a",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
			await genome.addMemory(
				memory({
					id: "old-b",
					content: "Sprout memory uses SQLite.",
					project_ids: ["sprout"],
				}),
			);
			const plan = discoverMemoryMaintenancePlan(genome, { includeEntityGc: false });
			const cluster = plan.consolidationClusters[0]!;
			const mergeDecision = {
				cluster_id: cluster.id,
				action: "merge" as const,
				memory: {
					text: "Sprout memory uses SQLite.",
					tags: ["memory"],
					confidence: 0.95,
				},
				reasoning: "Reviewed duplicate memories.",
			};
			const head = await git(root, "rev-parse", "HEAD");

			await expect(
				applyMemoryMaintenanceDecisions(genome, plan, {
					consolidations: [mergeDecision, mergeDecision],
				}),
			).rejects.toThrow("multiple consolidation merge decisions");

			expect(genome.memories.getById("old-a")?.superseded_by).toBeUndefined();
			expect(genome.memories.getById("old-b")?.superseded_by).toBeUndefined();
			expect(await git(root, "rev-parse", "HEAD")).toBe(head);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply rejects manual memory consolidation without explicit confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-manual-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "manual-a",
					content: "Sprout memory uses SQLite.",
					source: "manual",
					project_ids: ["sprout"],
				}),
			);
			await genome.addMemory(
				memory({
					id: "manual-b",
					content: "Sprout memory uses SQLite.",
					source: "user",
					project_ids: ["sprout"],
				}),
			);
			const plan = discoverMemoryMaintenancePlan(genome, { includeEntityGc: false });
			const cluster = plan.consolidationClusters[0]!;
			const head = await git(root, "rev-parse", "HEAD");

			await expect(
				applyMemoryMaintenanceDecisions(genome, plan, {
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
			).rejects.toThrow("manual memory");

			expect(genome.memories.getById("manual-a")?.superseded_by).toBeUndefined();
			expect(genome.memories.getById("manual-b")?.superseded_by).toBeUndefined();
			expect(await git(root, "rev-parse", "HEAD")).toBe(head);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply marks project entity-GC cadence after reviewed decisions", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-entity-gc-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "entity-a",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "entity-b",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);
			const plan = discoverMemoryMaintenancePlan(genome, { includeConsolidation: false });
			const group = plan.entityGcGroups[0]!;

			const result = await applyMemoryMaintenanceDecisions(genome, plan, {
				entity_gc: [
					{
						group_id: group.id,
						action: "reject",
						reasoning: "Reviewed as separate project entities.",
					},
				],
			});

			expect(result.entity_gc.rejected).toBe(1);
			expect(genome.projects.getById("sprout")?.last_entity_gc_active_day).toBe(30);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply rejects entity-GC merge UUIDs outside the dry-run group", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-entity-gc-invalid-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(
				memory({
					id: "entity-a",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "entity-b",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);
			const plan = discoverMemoryMaintenancePlan(genome, { includeConsolidation: false });
			const group = plan.entityGcGroups[0]!;
			const head = await git(root, "rev-parse", "HEAD");

			await expect(
				applyMemoryMaintenanceDecisions(genome, plan, {
					entity_gc: [
						{
							group_id: group.id,
							action: "merge",
							canonical: { uuid: "entity_invented", name: "Invented" },
							aliases: [{ uuid: "entity_sprout_alias", name: "sprout" }],
							reasoning: "Only capitalization differs.",
						},
					],
				}),
			).rejects.toThrow("canonical");

			expect(genome.memories.getById("entity-b")?.entity_links?.[0]?.uuid).toBe(
				"entity_sprout_alias",
			);
			expect(await git(root, "rev-parse", "HEAD")).toBe(head);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("apply marks and commits global maintenance cadence for unscoped memories", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-maintenance-global-apply-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await genome.addMemory(memory({ id: "global-a", content: "Global memory uses SQLite." }));
			await genome.addMemory(memory({ id: "global-b", content: "Global memory uses SQLite." }));
			const plan = discoverMemoryMaintenancePlan(genome, { includeEntityGc: false });
			const cluster = plan.consolidationClusters[0]!;

			const result = await applyMemoryMaintenanceDecisions(genome, plan, {
				consolidations: [
					{
						cluster_id: cluster.id,
						action: "reject",
						reasoning: "Reviewed as globally relevant separate memories.",
					},
				],
			});

			const globalProject = genome.projects.getById("__global__");
			expect(result.consolidation.rejected).toBe(1);
			expect(globalProject?.last_consolidated_active_day).toBe(30);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
