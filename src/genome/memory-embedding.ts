import type { Memory } from "../kernel/types.ts";
import type { EmbeddingProvider } from "../llm/embeddings.ts";
import { normalizeMemory } from "./memory-schema.ts";

export async function attachReadyMemoryEmbedding(
	memory: Memory,
	provider: EmbeddingProvider,
	options: { now?: number } = {},
): Promise<Memory> {
	const now = options.now ?? Date.now();
	const normalized = normalizeMemory(memory, { now });
	const [embedding] = await provider.embedBatch([normalized.content], { kind: "document" });
	if (!embedding) {
		throw new Error(`Embedding provider '${provider.provider}' returned no vector`);
	}
	if (embedding.dimensions !== provider.dimensions) {
		throw new Error(
			`Embedding provider '${provider.provider}' returned dimensions ${embedding.dimensions}, expected ${provider.dimensions}`,
		);
	}
	validateEmbeddingVector(embedding.vector, provider.dimensions);

	return {
		...normalized,
		embedding: {
			provider: embedding.provider,
			model: embedding.model,
			dimensions: embedding.dimensions,
			status: "ready",
			vector: Array.from(embedding.vector),
			embedded_at: now,
		},
	};
}

function validateEmbeddingVector(vector: Float32Array, dimensions: number): void {
	if (vector.length !== dimensions) {
		throw new Error(`Embedding vector dimensions ${vector.length} do not match ${dimensions}`);
	}
	for (const value of vector) {
		if (!Number.isFinite(value)) {
			throw new Error("Embedding vector contains a non-finite value");
		}
	}
}
