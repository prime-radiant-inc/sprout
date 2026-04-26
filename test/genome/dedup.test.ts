import { describe, expect, test } from "bun:test";
import {
	filterDuplicateDrafts,
	findDuplicateMemory,
	trigramDiceSimilarity,
} from "../../src/genome/dedup.ts";
import type { ExtractedMemoryDraft } from "../../src/genome/extraction.ts";
import { normalizeMemory } from "../../src/genome/memory-schema.ts";
import type { Memory } from "../../src/kernel/types.ts";
import type { EmbeddingProvider } from "../../src/llm/embeddings.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return normalizeMemory({
		id: overrides.id ?? "mem-1",
		content: overrides.content ?? "Sprout uses SQLite for memory recall",
		tags: overrides.tags ?? ["memory"],
		source: "test",
		created: 100,
		last_used: 100,
		use_count: 0,
		confidence: 1,
		...overrides,
	});
}

function makeDraft(text: string): ExtractedMemoryDraft {
	return { text, tags: [], entity_links: [] };
}

function vector(slot: number): number[] {
	const values = new Array<number>(768).fill(0);
	values[slot] = 1;
	return values;
}

function slotProvider(slot: number): EmbeddingProvider {
	return {
		provider: "slot",
		model: "slot",
		dimensions: 768,
		embedBatch: async (texts) =>
			texts.map((text) => ({
				text,
				vector: Float32Array.from(vector(slot)),
				provider: "slot",
				model: "slot",
				dimensions: 768,
			})),
	};
}

describe("memory dedup", () => {
	test("detects exact duplicates", async () => {
		const result = await findDuplicateMemory(makeDraft("Sprout uses SQLite for memory recall"), [
			makeMemory({ id: "existing" }),
		]);

		expect(result).toMatchObject({ duplicate: true, reason: "exact", existingId: "existing" });
	});

	test("detects near duplicates with trigram similarity", async () => {
		const result = await findDuplicateMemory(
			makeDraft("Sprout uses SQLite for memory retrieval"),
			[makeMemory({ id: "existing", content: "Sprout uses SQLite for memory recall" })],
			{ fuzzyThreshold: 0.6 },
		);

		expect(result.reason).toBe("fuzzy");
		expect(result.score).toBeGreaterThan(0.6);
		expect(trigramDiceSimilarity("abcde", "abcxy")).toBeGreaterThan(0);
	});

	test("detects vector duplicates when text differs", async () => {
		const result = await findDuplicateMemory(
			makeDraft("Use an embedded local database for recall"),
			[
				makeMemory({
					id: "existing",
					content: "Sprout uses SQLite for memory recall",
					embedding: {
						provider: "slot",
						model: "slot",
						dimensions: 768,
						status: "ready",
						vector: vector(0),
					},
				}),
			],
			{ embeddingProvider: slotProvider(0) },
		);

		expect(result).toMatchObject({ duplicate: true, reason: "vector", existingId: "existing" });
		expect(result.score).toBeCloseTo(1, 5);
	});

	test("keeps distinct operational memories", async () => {
		const result = await findDuplicateMemory(
			makeDraft("Use project metadata to identify memory scope"),
			[
				makeMemory({
					content: "Sprout uses SQLite for memory recall",
					embedding: {
						provider: "slot",
						model: "slot",
						dimensions: 768,
						status: "ready",
						vector: vector(1),
					},
				}),
			],
			{ embeddingProvider: slotProvider(0) },
		);

		expect(result.duplicate).toBe(false);
	});

	test("filters duplicates within a batch and against existing memories", async () => {
		const filtered = await filterDuplicateDrafts(
			[
				makeDraft("Sprout uses SQLite for memory recall"),
				makeDraft("Sprout uses SQLite for memory recall"),
				makeDraft("Local embeddings are required"),
			],
			[makeMemory({ content: "Existing retained memory" })],
		);

		expect(filtered.map((draft) => draft.text)).toEqual([
			"Sprout uses SQLite for memory recall",
			"Local embeddings are required",
		]);
	});

	test("filters vector duplicates within the same extraction batch", async () => {
		const filtered = await filterDuplicateDrafts(
			[
				makeDraft("Use SQLite for durable agent memory"),
				makeDraft("Persist long-term recall in a local relational database"),
			],
			[],
			{ embeddingProvider: slotProvider(0) },
		);

		expect(filtered.map((draft) => draft.text)).toEqual(["Use SQLite for durable agent memory"]);
	});
});
