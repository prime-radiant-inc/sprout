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

/**
 * Cosine similarity over embedding vectors. Zero-magnitude vectors score 0
 * (no similarity signal). Iterates `a`'s length: callers that need a
 * dimension-mismatch guard check lengths themselves.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0;
	let magnitudeA = 0;
	let magnitudeB = 0;
	for (let index = 0; index < a.length; index++) {
		const valueA = a[index] ?? 0;
		const valueB = b[index] ?? 0;
		dot += valueA * valueB;
		magnitudeA += valueA * valueA;
		magnitudeB += valueB * valueB;
	}
	if (magnitudeA === 0 || magnitudeB === 0) return 0;
	return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
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
