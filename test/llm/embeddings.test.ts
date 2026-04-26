import { describe, expect, test } from "bun:test";
import {
	applyDenseLayer,
	DEFAULT_EMBEDDING_DIMENSIONS,
	DEFAULT_EMBEDDING_MODEL,
	DEFAULT_EMBEDDING_PROVIDER,
	DEFAULT_LOCAL_DENSE_LAYER_PATH,
	DEFAULT_LOCAL_EMBEDDING_DTYPE,
	type DenseLayer,
	deterministicEmbedding,
	FakeEmbeddingProvider,
	LocalEmbeddingProvider,
	OPENAI_EMBEDDING_DIMENSIONS,
	OPENAI_EMBEDDING_MODEL,
	OpenAIEmbeddingProvider,
	parseDenseLayerSafetensors,
} from "../../src/llm/embeddings.ts";

describe("Embedding providers", () => {
	test("local provider defaults to the local mdbr embedding model", () => {
		const provider = new LocalEmbeddingProvider({
			loader: async () => ({
				extractor: async () => ({ data: new Float32Array(), dims: [0, 0] }),
			}),
		});

		expect(provider.provider).toBe(DEFAULT_EMBEDDING_PROVIDER);
		expect(provider.model).toBe(DEFAULT_EMBEDDING_MODEL);
		expect(provider.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
	});

	test("local provider applies query prompt, dense projection, and loader caching", async () => {
		const calls: string[][] = [];
		let loadCount = 0;
		const denseLayer: DenseLayer = {
			weight: Float32Array.from([1, 0, 0, 1, 1, 1]),
			bias: Float32Array.from([0, 0, 0]),
			inputDimensions: 2,
			outputDimensions: 3,
		};
		const provider = new LocalEmbeddingProvider({
			dimensions: 3,
			queryPrefix: "query: ",
			loader: async (model, options) => {
				loadCount++;
				expect(model).toBe(DEFAULT_EMBEDDING_MODEL);
				expect(options).toEqual({
					dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
					denseLayerPath: DEFAULT_LOCAL_DENSE_LAYER_PATH,
				});
				return {
					denseLayer,
					extractor: async (texts) => {
						calls.push(texts);
						return {
							data: Float32Array.from(
								texts.flatMap((text) => (text.startsWith("query: ") ? [1, 0] : [0, 1])),
							),
							dims: [texts.length, 2],
						};
					},
				};
			},
		});

		const queryResult = await provider.embedBatch(["sqlite memory"], { kind: "query" });
		const documentResult = await provider.embedBatch(["sqlite memory"], { kind: "document" });

		expect(queryResult.ok).toBe(true);
		expect(documentResult.ok).toBe(true);
		if (!queryResult.ok || !documentResult.ok) return;
		expect(loadCount).toBe(1);
		expect(calls).toEqual([["query: sqlite memory"], ["sqlite memory"]]);
		expect(queryResult.embeddings[0]!.dimensions).toBe(3);
		expect(documentResult.embeddings[0]!.dimensions).toBe(3);
		expect([...queryResult.embeddings[0]!.vector]).not.toEqual([
			...documentResult.embeddings[0]!.vector,
		]);
		expect(queryResult.embeddings[0]!.vector[0]).toBeCloseTo(Math.SQRT1_2, 5);
		expect(documentResult.embeddings[0]!.vector[1]).toBeCloseTo(Math.SQRT1_2, 5);
	});

	test("local provider reports dimension mismatches as embedding failures", async () => {
		const provider = new LocalEmbeddingProvider({
			dimensions: 3,
			denseLayerPath: null,
			loader: async () => ({
				extractor: async () => ({ data: Float32Array.from([1, 0]), dims: [1, 2] }),
			}),
		});

		const result = await provider.embedBatch(["alpha"]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("do not match expected 3");
	});

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

	test("fake provider separates query and document embeddings", async () => {
		const provider = new FakeEmbeddingProvider(8);

		const query = await provider.embedBatch(["alpha"], { kind: "query" });
		const document = await provider.embedBatch(["alpha"], { kind: "document" });

		expect(query.ok).toBe(true);
		expect(document.ok).toBe(true);
		if (!query.ok || !document.ok) return;
		expect([...query.embeddings[0]!.vector]).not.toEqual([...document.embeddings[0]!.vector]);
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

	test("dense safetensors parser loads and applies the mdbr projection shape", () => {
		const layer = parseDenseLayerSafetensors(
			makeDenseSafetensors({
				bias: Float32Array.from([0, 0, 0]),
				weight: Float32Array.from([1, 0, 0, 1, 1, 1]),
				inputDimensions: 2,
				outputDimensions: 3,
			}),
		);

		const projected = applyDenseLayer(Float32Array.from([1, 0]), layer);

		expect(layer.inputDimensions).toBe(2);
		expect(layer.outputDimensions).toBe(3);
		expect(projected).toHaveLength(3);
		expect(projected[0]).toBeCloseTo(Math.SQRT1_2, 5);
		expect(projected[2]).toBeCloseTo(Math.SQRT1_2, 5);
	});

	test("OpenAI provider is available as an explicit non-default fallback", () => {
		const provider = new OpenAIEmbeddingProvider("test-key");

		expect(provider.provider).toBe("openai");
		expect(provider.model).toBe(OPENAI_EMBEDDING_MODEL);
		expect(provider.dimensions).toBe(OPENAI_EMBEDDING_DIMENSIONS);
	});
});

function makeDenseSafetensors(layer: {
	bias: Float32Array;
	weight: Float32Array;
	inputDimensions: number;
	outputDimensions: number;
}): ArrayBuffer {
	const biasBytes = layer.bias.byteLength;
	const weightBytes = layer.weight.byteLength;
	const headerBytes = new TextEncoder().encode(
		JSON.stringify({
			"linear.bias": {
				dtype: "F32",
				shape: [layer.outputDimensions],
				data_offsets: [0, biasBytes],
			},
			"linear.weight": {
				dtype: "F32",
				shape: [layer.outputDimensions, layer.inputDimensions],
				data_offsets: [biasBytes, biasBytes + weightBytes],
			},
		}),
	);
	const buffer = new ArrayBuffer(8 + headerBytes.byteLength + biasBytes + weightBytes);
	const view = new DataView(buffer);
	view.setBigUint64(0, BigInt(headerBytes.byteLength), true);
	new Uint8Array(buffer, 8, headerBytes.byteLength).set(headerBytes);
	new Uint8Array(buffer, 8 + headerBytes.byteLength, biasBytes).set(
		new Uint8Array(layer.bias.buffer, layer.bias.byteOffset, biasBytes),
	);
	new Uint8Array(buffer, 8 + headerBytes.byteLength + biasBytes, weightBytes).set(
		new Uint8Array(layer.weight.buffer, layer.weight.byteOffset, weightBytes),
	);
	return buffer;
}
