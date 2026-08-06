import { describe, expect, test } from "bun:test";
import {
	applyMemoryScores,
	markMemoryAccessActivity,
	projectActivityDaysForMemory,
	scoreMemory,
	stampMemoryActivitySnapshots,
} from "../../src/genome/scoring.ts";
import type { Memory } from "../../src/kernel/types.ts";

const PROJECTS = [
	{ id: "sprout", name: "Sprout", cumulative_active_days: 1 },
	{ id: "harbor", name: "Harbor", cumulative_active_days: 90 },
];

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "memory-score",
		content: overrides.content ?? "Memory scoring fact",
		tags: overrides.tags ?? [],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 0.8,
		...overrides,
	};
}

describe("memory scoring", () => {
	test("uses per-project activity days instead of wall-clock days", () => {
		const dormant = memory({
			project_ids: ["sprout"],
			activity_days_at_creation: 1,
			activity_days_at_last_access: 1,
		});
		const active = memory({
			project_ids: ["harbor"],
			activity_days_at_creation: 1,
			activity_days_at_last_access: 1,
		});

		const dormantScore = scoreMemory(dormant, PROJECTS);
		const activeScore = scoreMemory(active, PROJECTS);

		expect(dormantScore.ageInActivityDays).toBe(0);
		expect(activeScore.ageInActivityDays).toBe(89);
		expect(dormantScore.score).toBeGreaterThan(activeScore.score);
	});

	test("global memories use the sum of project activity clocks", () => {
		expect(projectActivityDaysForMemory(memory(), PROJECTS)).toBe(91);
		expect(projectActivityDaysForMemory(memory({ project_ids: ["sprout"] }), PROJECTS)).toBe(1);
	});

	test("global memories ignore synthetic maintenance project clocks", () => {
		expect(
			projectActivityDaysForMemory(memory(), [
				...PROJECTS,
				{ id: "__global__", name: "Global memories", cumulative_active_days: 91 },
			]),
		).toBe(91);
	});

	test("access, mention, links, and entities boost the score", () => {
		const plain = scoreMemory(memory({ activity_days_at_creation: 10 }), [
			{ id: "sprout", name: "Sprout", cumulative_active_days: 30 },
		]);
		const used = scoreMemory(
			memory({
				activity_days_at_creation: 10,
				activity_days_at_last_access: 29,
				access_count: 8,
				mention_count: 4,
				inbound_links: [
					{ uuid: "other", type: "corroborates", reasoning: "evidence", created_at: 1 },
				],
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			}),
			[{ id: "sprout", name: "Sprout", cumulative_active_days: 30 }],
		);

		expect(used.score).toBeGreaterThan(plain.score);
		expect(used.valueScore).toBeGreaterThan(plain.valueScore);
		expect(used.mentionScore).toBeGreaterThan(plain.mentionScore);
		expect(used.hubScore).toBeGreaterThan(plain.hubScore);
	});

	test("stamps creation and access snapshots from the active project clock", () => {
		const item = memory({ project_ids: ["harbor"] });

		stampMemoryActivitySnapshots(item, PROJECTS);
		markMemoryAccessActivity(item, [{ id: "harbor", name: "Harbor", cumulative_active_days: 93 }]);

		expect(item.activity_days_at_creation).toBe(90);
		expect(item.activity_days_at_last_access).toBe(93);
	});

	test("archives rather than deletes low-importance expired memories", () => {
		const now = Date.parse("2026-04-26T00:00:00Z");
		const item = memory({
			expires_at: now - 6 * 24 * 60 * 60 * 1000,
			activity_days_at_creation: 0,
			activity_days_at_last_access: 0,
		});
		const result = applyMemoryScores([item], [], { now, minImportance: 0.1 });

		expect(result.archived).toEqual(["memory-score"]);
		expect(item.archived_at).toBe(now);
		expect(item.archived_reason).toContain("low importance score");
	});

	test("never auto-archives protected manual/user memories, matching the archivist tool", () => {
		const now = Date.parse("2026-04-26T00:00:00Z");
		const decayed = {
			expires_at: now - 6 * 24 * 60 * 60 * 1000,
			activity_days_at_creation: 0,
			activity_days_at_last_access: 0,
		};
		const userMemory = memory({ id: "memory-user", source: "user", ...decayed });
		const manualMemory = memory({ id: "memory-manual", source: "manual:cli", ...decayed });
		const ordinary = memory({ id: "memory-ordinary", ...decayed });

		const result = applyMemoryScores([userMemory, manualMemory, ordinary], [], {
			now,
			minImportance: 0.1,
		});

		expect(result.archived).toEqual(["memory-ordinary"]);
		expect(userMemory.archived_at).toBeUndefined();
		expect(manualMemory.archived_at).toBeUndefined();
		// Protected memories still get their scores refreshed.
		expect(result.updated).toContain("memory-user");
	});
});
