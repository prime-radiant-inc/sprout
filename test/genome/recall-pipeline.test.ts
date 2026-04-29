import { describe, expect, test } from "bun:test";
import { discoverEntityHubMemories } from "../../src/genome/hub-discovery.ts";
import { memoryShortId } from "../../src/genome/memory-schema.ts";
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

	test("entity hints feed hub discovery even when query omits the entity name", () => {
		const result = discoverEntityHubMemories(
			[
				memory({
					id: "m-sprout",
					content: "Sprout uses SQLite for memory",
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			],
			"What database should the memory port use?",
			10,
			["Sprout"],
		);

		expect(result.map((item) => item.memory.id)).toEqual(["m-sprout"]);
	});

	test("entity hub discovery excludes superseded memories from unfiltered pools", () => {
		const result = discoverEntityHubMemories(
			[
				memory({
					id: "m-current",
					content: "Sprout uses local embeddings",
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
				memory({
					id: "m-stale",
					content: "Sprout uses remote embeddings",
					superseded_by: "m-current",
					entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
				}),
			],
			"Sprout embeddings",
		);

		expect(result.map((item) => item.memory.id)).toEqual(["m-current"]);
	});

	test("matches short entity names only on token boundaries or exact hints", () => {
		const memories = [
			memory({
				id: "m-go",
				content: "Go runtime preference",
				entity_links: [{ uuid: "entity_go", type: "TECHNOLOGY", name: "Go" }],
			}),
			memory({
				id: "m-ai",
				content: "AI tooling preference",
				entity_links: [{ uuid: "entity_ai", type: "TECHNOLOGY", name: "AI" }],
			}),
		];

		expect(
			discoverEntityHubMemories(memories, "ongoing migrations and plain artificial text").map(
				(item) => item.memory.id,
			),
		).toEqual([]);
		expect(discoverEntityHubMemories(memories, "Go runtime").map((item) => item.memory.id)).toEqual(
			["m-go"],
		);
		expect(
			discoverEntityHubMemories(memories, "tooling preference", 10, ["AI"]).map(
				(item) => item.memory.id,
			),
		).toEqual(["m-ai"]);
	});

	test("merges similarity and hub pools while excluding superseded memories", () => {
		const newMemory = memory({ id: "new", content: "new local embedding decision" });
		const superseded = memory({
			id: "old",
			content: "old remote embedding decision",
			confidence: 1,
			superseded_by: "new",
		});
		const merged = mergeAndRankMemories([superseded], [newMemory], 2);

		expect(merged.map((item) => item.id)).toEqual(["new"]);
	});

	test("pinned memories are retained ahead of weak recall matches", () => {
		const pinned = memory({ id: "pinned", content: "Pinned prior memory", confidence: 0.4 });
		const weak = memory({ id: "weak", content: "Weak match", confidence: 0.8 });
		const merged = mergeAndRankMemories([weak], [], 1, { pinnedPool: [pinned] });

		expect(merged.map((item) => item.id)).toEqual(["pinned"]);
	});

	test("pinned memories reserve final slots instead of only receiving a score boost", () => {
		const pinned = memory({ id: "pinned", content: "Pinned prior memory", confidence: 0.1 });
		const strongA = memory({ id: "strong-a", content: "Strong match A", confidence: 10 });
		const strongB = memory({ id: "strong-b", content: "Strong match B", confidence: 9 });
		const merged = mergeAndRankMemories([strongA, strongB], [], 2, { pinnedPool: [pinned] });

		expect(merged.map((item) => item.id)).toEqual(["pinned", "strong-a"]);
	});

	test("renders MIRA-style XML memory blocks with stable short ids", () => {
		const shortId = memoryShortId("12345678-1234");
		const rendered = renderMemoryBlock([
			memory({
				id: "12345678-1234",
				content: "Use SQLite for Sprout memory.",
				tags: ["sqlite"],
				entity_links: [{ uuid: "entity_sqlite", type: "TECHNOLOGY", name: "SQLite" }],
			}),
		]);

		expect(rendered).toContain("<memory_context>");
		expect(rendered).toContain(`[${shortId}]`);
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
