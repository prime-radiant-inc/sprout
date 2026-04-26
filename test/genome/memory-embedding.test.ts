import { describe, expect, test } from "bun:test";
import { attachReadyMemoryEmbedding } from "../../src/genome/memory-embedding.ts";
import type { Memory } from "../../src/kernel/types.ts";
import { type EmbeddingProvider, FakeEmbeddingProvider } from "../../src/llm/embeddings.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "mem-1",
		content: overrides.content ?? "store this fact",
		tags: overrides.tags ?? ["test"],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1,
	};
}

describe("attachReadyMemoryEmbedding", () => {
	test("attaches ready document embedding metadata and vector", async () => {
		const embedded = await attachReadyMemoryEmbedding(makeMemory(), new FakeEmbeddingProvider(), {
			now: 123,
		});

		expect(embedded.embedding?.status).toBe("ready");
		expect(embedded.embedding?.provider).toBe("fake");
		expect(embedded.embedding?.model).toBe("fake-deterministic");
		expect(embedded.embedding?.dimensions).toBe(768);
		expect(embedded.embedding?.embedded_at).toBe(123);
		expect(embedded.embedding?.vector).toHaveLength(768);
	});

	test("throws when provider returns the wrong dimensions", async () => {
		const provider: EmbeddingProvider = {
			provider: "bad",
			model: "bad",
			dimensions: 768,
			embedBatch: async () => [
				{
					text: "store this fact",
					vector: new Float32Array(2),
					provider: "bad",
					model: "bad",
					dimensions: 2,
				},
			],
		};

		await expect(attachReadyMemoryEmbedding(makeMemory(), provider)).rejects.toThrow(
			"returned dimensions 2, expected 768",
		);
	});
});
