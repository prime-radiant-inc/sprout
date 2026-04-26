import { describe, expect, test } from "bun:test";
import { discoverEntityHubMemories } from "../../src/genome/hub-discovery.ts";
import { mergeAndRankMemories } from "../../src/genome/recall-pipeline.ts";
import {
	extractMemoryReferences,
	renderMemoryBlock,
} from "../../src/genome/render-memory-block.ts";
import type { Memory } from "../../src/kernel/types.ts";

function memory(overrides: Partial<Memory>): Memory {
	return {
		id: overrides.id ?? "memory-1",
		content: overrides.content ?? "default memory",
		tags: overrides.tags ?? [],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 0.7,
		...overrides,
	};
}

describe("recall pipeline", () => {
	test("discovers hub memories from entity mentions", () => {
		const result = discoverEntityHubMemories(
			[
				memory({
					id: "m-sprout",
					content: "Sprout uses local embeddings",
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
				memory({
					id: "m-other",
					content: "Other project",
					entity_links: [{ uuid: "entity_other", type: "PROJECT", name: "Other" }],
				}),
			],
			"What should Sprout use for memory?",
		);

		expect(result.map((item) => item.memory.id)).toEqual(["m-sprout"]);
		expect(result[0]?.matchedEntities).toEqual(["Sprout"]);
	});

	test("merges similarity and hub pools with debut boost and supersedes penalty", () => {
		const newMemory = memory({ id: "new", content: "new local embedding decision" });
		const superseded = memory({
			id: "old",
			content: "old remote embedding decision",
			confidence: 1,
			superseded_by: "new",
		});
		const merged = mergeAndRankMemories([superseded], [newMemory], 2);

		expect(merged.map((item) => item.id)).toEqual(["new", "old"]);
	});

	test("renders MIRA-style XML memory blocks with stable short ids", () => {
		const rendered = renderMemoryBlock([
			memory({
				id: "12345678-1234",
				content: "Use SQLite for Sprout memory.",
				tags: ["sqlite"],
				entity_links: [{ uuid: "entity_sqlite", type: "TECHNOLOGY", name: "SQLite" }],
			}),
		]);

		expect(rendered).toContain("<memory_context>");
		expect(rendered).toContain("[mem_12345678]");
		expect(rendered).toContain("TECHNOLOGY:SQLite");
		expect(rendered).toContain("</memory_context>");
	});

	test("extracts and deduplicates assistant memory references", () => {
		expect(extractMemoryReferences("See mem_ABCDEF12 and mem_abcdef12 plus mem_12345678")).toEqual([
			"mem_abcdef12",
			"mem_12345678",
		]);
	});
});
