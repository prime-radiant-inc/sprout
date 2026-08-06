import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { type Genome, git } from "../../src/genome/genome.ts";
import { runMemoryMaintenanceIfDue } from "../../src/genome/memory-maintenance-auto.ts";
import type { Memory } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import { type EmbeddingProvider, FakeEmbeddingProvider } from "../../src/llm/embeddings.ts";
import type { ProviderModel, Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
import { seedMemories } from "../helpers/genome-seed.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

const START_NOW = Date.UTC(2026, 5, 1);
const HOUR_MS = 60 * 60 * 1000;

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

function stubClient(handler: (request: Request) => string): { client: Client; calls: Request[] } {
	const calls: Request[] = [];
	const client = {
		providers: () => ["openrouter"],
		complete: async (request: Request): Promise<Response> => {
			calls.push(request);
			return {
				id: "memory-maintenance-auto-test",
				model: request.model,
				provider: request.provider ?? "openrouter",
				message: Msg.assistant(handler(request)),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			};
		},
	} as unknown as Client;
	return { client, calls };
}

function stubLogger(): { logger: { warn(message: string): void }; warns: string[] } {
	const warns: string[] = [];
	return { logger: { warn: (message: string) => warns.push(message) }, warns };
}

const PROVIDER_MODELS: [string, ProviderModel[]][] = [
	[
		"openrouter",
		[
			{ id: "consolidation-model", label: "Consolidation", source: "remote" },
			{ id: "entity-gc-model", label: "Entity GC", source: "remote" },
			{ id: "best-model", label: "Best", source: "remote" },
		],
	],
];

function maintenanceOptions(client: Client, overrides: Record<string, unknown> = {}) {
	return {
		client,
		resolverSettings: createResolverSettings(
			[{ id: "openrouter", enabled: true }],
			{ best: { providerId: "openrouter", modelId: "best-model" } },
			{
				consolidation: { providerId: "openrouter", modelId: "consolidation-model" },
				entityGc: { providerId: "openrouter", modelId: "entity-gc-model" },
			},
		),
		modelsByProvider: new Map(PROVIDER_MODELS),
		now: START_NOW,
		...overrides,
	};
}

function rejectReply(): string {
	return JSON.stringify({
		action: "reject",
		reasoning: "The memories should remain separate.",
	});
}

const ZERO_COUNTS = {
	merged: 0,
	rejected: 0,
	skipped: 0,
	entityGcMerged: 0,
	entityGcRejected: 0,
	entityGcSkipped: 0,
};

describe("automatic memory maintenance driver", () => {
	test("first run stamps state with zero counts and a same-window rerun is not due", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-throttle-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			const { client, calls } = stubClient(rejectReply);

			const first = await runMemoryMaintenanceIfDue(genome, maintenanceOptions(client));
			const second = await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(client, { now: START_NOW + HOUR_MS }),
			);
			const third = await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(client, { now: START_NOW + 25 * HOUR_MS }),
			);

			expect(first).toEqual(ZERO_COUNTS);
			expect(second).toEqual({ due: false });
			expect(third).toEqual(ZERO_COUNTS);
			expect(calls).toHaveLength(0);
			const state = JSON.parse(
				await readFile(join(root, ".cache", "memory-maintenance-state.json"), "utf-8"),
			);
			expect(state.lastCheckedAt).toBe(START_NOW + 25 * HOUR_MS);
			expect(state.lastRun).toEqual(ZERO_COUNTS);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ignoreThrottle skips the 24h window but still stamps state (CLI --auto)", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-ignore-throttle-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			const { client, calls } = stubClient(rejectReply);

			const first = await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(client, { ignoreThrottle: true }),
			);
			const second = await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(client, { ignoreThrottle: true, now: START_NOW + HOUR_MS }),
			);

			expect(first).toEqual(ZERO_COUNTS);
			expect(second).toEqual(ZERO_COUNTS);
			expect(calls).toHaveLength(0);
			const state = JSON.parse(
				await readFile(join(root, ".cache", "memory-maintenance-state.json"), "utf-8"),
			);
			expect(state.lastCheckedAt).toBe(START_NOW + HOUR_MS);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("no resolvable models fails before discovery and stays stamped for the window", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-no-models-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({ id: "dup-a", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
				memory({ id: "dup-b", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
			);
			const { client, calls } = stubClient(rejectReply);
			const { logger, warns } = stubLogger();
			const options = maintenanceOptions(client, {
				resolverSettings: createResolverSettings([{ id: "openrouter", enabled: true }], {}, {}),
				logger,
			});

			const first = await runMemoryMaintenanceIfDue(genome, options);
			const second = await runMemoryMaintenanceIfDue(genome, {
				...options,
				now: START_NOW + HOUR_MS,
			});

			expect(first).toEqual({ failed: "no models" });
			expect(second).toEqual({ due: false });
			expect(calls).toHaveLength(0);
			expect(warns.some((warning) => warning.includes("no models"))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("preflight falls back to the global best model when memory models are unresolvable", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-fallback-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({ id: "dup-a", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
				memory({ id: "dup-b", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
			);
			const { client, calls } = stubClient(rejectReply);
			const options = maintenanceOptions(client, {
				resolverSettings: createResolverSettings(
					[{ id: "openrouter", enabled: true }],
					{ best: { providerId: "openrouter", modelId: "best-model" } },
					{},
				),
			});

			const result = await runMemoryMaintenanceIfDue(genome, options);

			expect(result).toEqual({ ...ZERO_COUNTS, rejected: 1 });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.model).toBe("best-model");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("protected and consolidation-generated memories never enter discovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-filters-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({
					id: "protected-pair-normal",
					content: "Alpha caching layer fact stays unique.",
					project_ids: ["sprout"],
				}),
				memory({
					id: "protected-pair-manual",
					content: "Alpha caching layer fact stays unique.",
					source: "manual",
					project_ids: ["sprout"],
				}),
				memory({
					id: "generation-pair-normal",
					content: "Beta routing table fact stays unique.",
					project_ids: ["sprout"],
				}),
				memory({
					id: "generation-pair-consolidated",
					content: "Beta routing table fact stays unique.",
					source: "memory-consolidation",
					project_ids: ["sprout"],
				}),
			);
			const { client, calls } = stubClient(() => {
				throw new Error("the driver must not request decisions for filtered memories");
			});

			const result = await runMemoryMaintenanceIfDue(genome, maintenanceOptions(client));

			expect(result).toEqual(ZERO_COUNTS);
			expect(calls).toHaveLength(0);
			const protectedMemory = genome.memories.getById("protected-pair-manual")!;
			expect(protectedMemory.annotations ?? []).toEqual([]);
			expect(protectedMemory.consolidation_rejection_count ?? 0).toBe(0);
			expect(protectedMemory.archived_at).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an LLM failure skips only that cluster and leaves it discoverable next run", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-skip-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			// The pair contents differ in length so the deterministic fake
			// embeddings do not vector-join the two pairs into one cluster.
			await seedMemories(
				genome,
				memory({
					id: "pair-one-a",
					content: "Pair one scheduler fact.",
					project_ids: ["sprout"],
				}),
				memory({
					id: "pair-one-b",
					content: "Pair one scheduler fact.",
					project_ids: ["sprout"],
				}),
				memory({
					id: "pair-two-a",
					content:
						"Pair two exporter cadence fact recorded for maintenance regression coverage across runs.",
					project_ids: ["sprout"],
				}),
				memory({
					id: "pair-two-b",
					content:
						"Pair two exporter cadence fact recorded for maintenance regression coverage across runs.",
					project_ids: ["sprout"],
				}),
			);
			const failing = stubClient((request) => {
				if (JSON.stringify(request.messages).includes("pair-one-a")) {
					throw new Error("transient provider outage");
				}
				return rejectReply();
			});
			const { logger, warns } = stubLogger();

			const first = await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(failing.client, { logger }),
			);

			expect(first).toEqual({ ...ZERO_COUNTS, rejected: 1, skipped: 1 });
			expect(warns.some((warning) => warning.includes("transient provider outage"))).toBe(true);
			expect(genome.memories.getById("pair-one-a")?.annotations ?? []).toEqual([]);
			expect(genome.memories.getById("pair-one-a")?.consolidation_rejection_count ?? 0).toBe(0);
			expect(genome.memories.getById("pair-two-a")?.consolidation_rejection_count).toBe(1);

			// The first run stamped the consolidation cadence; more active days
			// make the project due again for the next run.
			recordActiveDays(genome, "sprout", 44);
			const rejecting = stubClient(rejectReply);
			const second = await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(rejecting.client, { now: START_NOW + 25 * HOUR_MS }),
			);

			expect(second).toEqual({ ...ZERO_COUNTS, rejected: 2 });
			expect(
				rejecting.calls.some((request) => JSON.stringify(request.messages).includes("pair-one-a")),
			).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reject decisions are persisted with annotations and rejection counters", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-reject-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({ id: "dup-a", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
				memory({ id: "dup-b", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
			);
			const { client } = stubClient(rejectReply);

			const result = await runMemoryMaintenanceIfDue(genome, maintenanceOptions(client));

			expect(result).toEqual({ ...ZERO_COUNTS, rejected: 1 });
			expect(genome.memories.getById("dup-a")?.consolidation_rejection_count).toBe(1);
			expect(genome.memories.getById("dup-a")?.annotations?.[0]?.text).toContain(
				"The memories should remain separate.",
			);
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("merge decisions apply end-to-end with cadence stamps and one commit", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-merge-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({ id: "dup-a", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
				memory({
					id: "dup-b",
					content: "Sprout memory uses local SQLite.",
					project_ids: ["sprout"],
				}),
				memory({
					id: "entity-anchor-one",
					content: "Entity anchor one covers the roadmap overview.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
				memory({
					id: "entity-anchor-two",
					content: "Entity anchor two covers configuration defaults.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
				memory({
					id: "entity-alias-holder",
					content: "Entity alias holder covers release naming.",
					project_ids: ["sprout"],
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);
			const { client, calls } = stubClient((request) => {
				if (request.metadata?.purpose === "memory.consolidation") {
					return JSON.stringify({
						action: "merge",
						memory: { text: "Sprout memory uses local SQLite storage.", tags: ["memory"] },
						reasoning: "The duplicates collapse into one durable fact.",
					});
				}
				return JSON.stringify({
					action: "merge",
					canonical: { uuid: "entity_sprout", name: "Sprout" },
					aliases: [{ uuid: "entity_sprout_alias", name: "sprout" }],
					reasoning: "Only capitalization differs.",
				});
			});
			const commitsBefore = Number(await git(root, "rev-list", "--count", "HEAD"));

			const result = await runMemoryMaintenanceIfDue(genome, maintenanceOptions(client));

			expect(result).toEqual({ ...ZERO_COUNTS, merged: 1, entityGcMerged: 1 });
			const consolidated = genome.memories
				.all()
				.find((candidate) => candidate.consolidates_memory_ids?.length)!;
			expect(consolidated.source).toBe("memory-consolidation");
			expect(consolidated.content).toBe("Sprout memory uses local SQLite storage.");
			expect(consolidated.consolidates_memory_ids?.sort()).toEqual(["dup-a", "dup-b"]);
			expect(consolidated.embedding?.status).toBe("ready");
			expect(genome.memories.getById("dup-a")?.superseded_by).toBe(consolidated.id);
			expect(genome.memories.getById("dup-b")?.archived_at).toBeDefined();
			expect(genome.memories.getById("entity-alias-holder")?.entity_links?.[0]).toMatchObject({
				uuid: "entity_sprout",
				name: "Sprout",
			});
			expect(genome.projects.getById("sprout")?.last_consolidated_active_day).toBe(30);
			expect(genome.projects.getById("sprout")?.last_entity_gc_active_day).toBe(30);
			expect(Number(await git(root, "rev-list", "--count", "HEAD"))).toBe(commitsBefore + 1);
			expect(await git(root, "status", "--porcelain")).toBe("");
			const consolidationCalls = calls.filter(
				(request) => request.metadata?.purpose === "memory.consolidation",
			);
			const entityGcCalls = calls.filter(
				(request) => request.metadata?.purpose === "memory.entityGc",
			);
			expect(consolidationCalls.map((request) => request.model)).toEqual(["consolidation-model"]);
			expect(entityGcCalls.map((request) => request.model)).toEqual(["entity-gc-model"]);
			const state = JSON.parse(
				await readFile(join(root, ".cache", "memory-maintenance-state.json"), "utf-8"),
			);
			expect(state.lastRun).toEqual({ ...ZERO_COUNTS, merged: 1, entityGcMerged: 1 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("accepted merges are embedded once, before apply", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-pre-embed-"));
		try {
			const embeddedTexts: string[] = [];
			const base = new FakeEmbeddingProvider();
			const provider: EmbeddingProvider = {
				provider: base.provider,
				model: base.model,
				dimensions: base.dimensions,
				embedBatch: (texts, options) => {
					embeddedTexts.push(...texts);
					return base.embedBatch(texts, options);
				},
			};
			const genome = createTestGenome(root, undefined, { embeddingProvider: provider });
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({ id: "dup-a", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
				memory({ id: "dup-b", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
			);
			const draftText = "Sprout memory uses local SQLite storage.";
			const { client } = stubClient(() =>
				JSON.stringify({
					action: "merge",
					memory: { text: draftText, tags: ["memory"] },
					reasoning: "The duplicates collapse into one durable fact.",
				}),
			);

			const result = await runMemoryMaintenanceIfDue(genome, maintenanceOptions(client));

			expect(result).toEqual({ ...ZERO_COUNTS, merged: 1 });
			expect(embeddedTexts.filter((text) => text === draftText)).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("three zero-merge runs with decided clusters log a streak warning", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-streak-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({ id: "dup-a", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
				memory({ id: "dup-b", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
			);
			const { client } = stubClient(rejectReply);
			const { logger, warns } = stubLogger();
			const streakWarning = (warning: string) => warning.includes("consecutive");

			// Each apply stamps the consolidation cadence, so every follow-up
			// run needs 14 more active days before the cluster is rediscovered.
			await runMemoryMaintenanceIfDue(genome, maintenanceOptions(client, { logger }));
			recordActiveDays(genome, "sprout", 44);
			await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(client, { logger, now: START_NOW + 25 * HOUR_MS }),
			);
			expect(warns.filter(streakWarning)).toHaveLength(0);

			recordActiveDays(genome, "sprout", 58);
			await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(client, { logger, now: START_NOW + 50 * HOUR_MS }),
			);

			expect(warns.filter(streakWarning)).toHaveLength(1);
			expect(warns.find(streakWarning)).toContain("3");
			const state = JSON.parse(
				await readFile(join(root, ".cache", "memory-maintenance-state.json"), "utf-8"),
			);
			expect(state.zeroMergeStreak).toBe(3);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an apply failure returns failed, warns, and leaves the throttle stamped", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-auto-maintenance-apply-fail-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			recordActiveDays(genome);
			await seedMemories(
				genome,
				memory({ id: "dup-a", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
				memory({ id: "dup-b", content: "Sprout memory uses SQLite.", project_ids: ["sprout"] }),
			);
			const { client } = stubClient(() =>
				JSON.stringify({
					action: "merge",
					memory: { text: "Sprout memory uses local SQLite storage.", tags: ["memory"] },
					reasoning: "The duplicates collapse into one durable fact.",
				}),
			);
			const { logger, warns } = stubLogger();
			const originalProjectSave = genome.projects.save.bind(genome.projects);
			genome.projects.save = async () => {
				await originalProjectSave();
				throw new Error("project cadence save failed");
			};

			let first: unknown;
			try {
				first = await runMemoryMaintenanceIfDue(genome, maintenanceOptions(client, { logger }));
			} finally {
				genome.projects.save = originalProjectSave;
			}
			const second = await runMemoryMaintenanceIfDue(
				genome,
				maintenanceOptions(client, { logger, now: START_NOW + HOUR_MS }),
			);

			expect(first).toEqual({ failed: "project cadence save failed" });
			expect(second).toEqual({ due: false });
			expect(warns.some((warning) => warning.includes("project cadence save failed"))).toBe(true);
			expect(genome.memories.getById("dup-a")?.archived_at).toBeUndefined();
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
