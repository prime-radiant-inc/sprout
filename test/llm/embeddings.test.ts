import { describe, expect, test } from "bun:test";
import {
	DEFAULT_EMBEDDING_DIMENSIONS,
	DEFAULT_EMBEDDING_MODEL,
	deterministicEmbedding,
	FakeEmbeddingProvider,
	OpenAIEmbeddingProvider,
} from "../../src/llm/embeddings.ts";

describe("Embedding providers", () => {
	test("fake provider returns deterministic vectors with provider metadata", async () => {
		const provider = new FakeEmbeddingProvider(8);

		const result = await provider.embedBatch(["alpha", "alpha", "beta"]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.embeddings).toHaveLength(3);
		expect(result.embeddings[0]!.provider).toBe("fake");
		expect(result.embeddings[0]!.model).toBe("fake-deterministic");
		expect(result.embeddings[0]!.dimensions).toBe(8);
		expect([...result.embeddings[0]!.vector]).toEqual([...result.embeddings[1]!.vector]);
		expect([...result.embeddings[0]!.vector]).not.toEqual([...result.embeddings[2]!.vector]);
	});

	test("fake provider handles empty batches", async () => {
		const provider = new FakeEmbeddingProvider(8);

		const result = await provider.embedBatch([]);

		expect(result).toEqual({ ok: true, embeddings: [] });
	});

	test("deterministicEmbedding normalizes non-empty vectors", () => {
		const vector = deterministicEmbedding("alpha", 8);
		const magnitude = Math.sqrt([...vector].reduce((sum, value) => sum + value * value, 0));

		expect(magnitude).toBeCloseTo(1, 5);
	});

	test("OpenAI provider defaults to text-embedding-3-small shape", async () => {
		const provider = new OpenAIEmbeddingProvider("test-key");

		expect(provider.provider).toBe("openai");
		expect(provider.model).toBe(DEFAULT_EMBEDDING_MODEL);
		expect(provider.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
	});
});
