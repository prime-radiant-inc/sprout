import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyEntityGcDecision,
	discoverEntityGcGroups,
	normalizeEntityGcDecisionPayload,
	projectDueForEntityGc,
} from "../../src/genome/entity-gc.ts";
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

describe("entity GC", () => {
	test("discovers same-type alias groups", () => {
		const groups = discoverEntityGcGroups([
			memory({
				id: "a",
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			}),
			memory({
				id: "b",
				entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
			}),
			memory({
				id: "c",
				entity_links: [{ uuid: "entity_sqlite", type: "TECHNOLOGY", name: "SQLite" }],
			}),
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.type).toBe("PROJECT");
		expect(groups[0]?.candidates.map((candidate) => candidate.uuid).sort()).toEqual([
			"entity_sprout",
			"entity_sprout_alias",
		]);
	});

	test("normalizes LLM merge decisions and defaults aliases from group", () => {
		const group = discoverEntityGcGroups([
			memory({
				id: "a",
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			}),
			memory({
				id: "b",
				entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
			}),
		])[0]!;

		const decision = normalizeEntityGcDecisionPayload(
			group,
			`{"action":"merge","canonical":{"uuid":"entity_sprout","name":"Sprout"},"reasoning":"Only capitalization differs."}`,
		);

		expect(decision.action).toBe("merge");
		expect(decision.aliases).toEqual([{ uuid: "entity_sprout_alias", name: "sprout" }]);
	});

	test("filters canonical entity from explicit merge aliases", () => {
		const group = discoverEntityGcGroups([
			memory({
				id: "a",
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			}),
			memory({
				id: "b",
				entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
			}),
		])[0]!;

		const decision = normalizeEntityGcDecisionPayload(
			group,
			JSON.stringify({
				action: "merge",
				canonical: { uuid: "entity_sprout", name: "Sprout" },
				aliases: [
					{ uuid: "entity_sprout", name: "Sprout" },
					{ uuid: "entity_sprout_alias", name: "sprout" },
				],
				reasoning: "Only capitalization differs.",
			}),
		);

		expect(decision.aliases).toEqual([{ uuid: "entity_sprout_alias", name: "sprout" }]);
		expect(() =>
			normalizeEntityGcDecisionPayload(
				group,
				JSON.stringify({
					action: "merge",
					canonical: { uuid: "entity_sprout", name: "Sprout" },
					aliases: [{ uuid: "entity_sprout", name: "Sprout" }],
					reasoning: "Only capitalization differs.",
				}),
			),
		).toThrow("no aliases");
	});

	test("rejects merge decisions with invented canonical entities", () => {
		const group = discoverEntityGcGroups([
			memory({
				id: "a",
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			}),
			memory({
				id: "b",
				entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
			}),
		])[0]!;

		expect(() =>
			normalizeEntityGcDecisionPayload(
				group,
				JSON.stringify({
					action: "merge",
					canonical: { uuid: "entity_invented", name: "Invented" },
					aliases: [{ uuid: "entity_sprout_alias", name: "sprout" }],
					reasoning: "Only capitalization differs.",
				}),
			),
		).toThrow("canonical is not in the candidate group");
	});

	test("merge rewrites aliases to canonical entity and archives alias metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-entity-gc-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "canonical-memory",
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "alias-memory",
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);
			const group = discoverEntityGcGroups(genome.memories.all())[0]!;

			const result = await applyEntityGcDecision(
				genome,
				group,
				{
					action: "merge",
					canonical: { uuid: "entity_sprout", name: "Sprout" },
					aliases: [{ uuid: "entity_sprout_alias", name: "sprout" }],
					reasoning: "Only capitalization differs.",
				},
				{ now: 3000 },
			);

			expect(result.updated_memory_ids).toEqual(["alias-memory"]);
			const aliasMemory = genome.memories.getById("alias-memory")!;
			expect(aliasMemory.entity_links).toHaveLength(1);
			expect(aliasMemory.entity_links?.[0]).toMatchObject({
				uuid: "entity_sprout",
				name: "Sprout",
				archived_aliases: [
					{
						uuid: "entity_sprout_alias",
						name: "sprout",
						archived_at: 3000,
						reason: "Only capitalization differs.",
					},
				],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reject persists a marker so the same alias group is suppressed", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-entity-gc-reject-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "canonical-memory",
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			);
			await genome.addMemory(
				memory({
					id: "alias-memory",
					entity_links: [{ uuid: "entity_sprout_alias", type: "PROJECT", name: "sprout" }],
				}),
			);
			const group = discoverEntityGcGroups(genome.memories.all())[0]!;

			const result = await applyEntityGcDecision(
				genome,
				group,
				{
					action: "reject",
					reasoning: "These names intentionally refer to separate project contexts.",
				},
				{ now: 4000, source: "memory-maintenance" },
			);

			expect(result.updated_memory_ids.sort()).toEqual(["alias-memory", "canonical-memory"]);
			expect(discoverEntityGcGroups(genome.memories.all())).toEqual([]);
			expect(genome.memories.getById("canonical-memory")?.annotations?.[0]).toMatchObject({
				created_at: 4000,
				source: "memory-maintenance",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("project-active-day schedule controls entity GC cadence", () => {
		expect(
			projectDueForEntityGc({
				id: "sprout",
				name: "Sprout",
				cumulative_active_days: 30,
			}),
		).toBe(true);
		expect(
			projectDueForEntityGc({
				id: "sprout",
				name: "Sprout",
				cumulative_active_days: 40,
				last_entity_gc_active_day: 20,
			}),
		).toBe(false);
	});
});
