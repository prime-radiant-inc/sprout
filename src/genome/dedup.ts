import type { Memory } from "../kernel/types.ts";
import type { EmbeddingProvider } from "../llm/embeddings.ts";
import type { ExtractedMemoryDraft } from "./extraction.ts";

export const FUZZY_DUPLICATE_THRESHOLD = 0.86;
export const VECTOR_DUPLICATE_THRESHOLD = 0.92;

export type DuplicateReason = "exact" | "fuzzy" | "vector";

export interface DuplicateCheckResult {
	duplicate: boolean;
	reason?: DuplicateReason;
	existingId?: string;
	score?: number;
}

export interface DedupOptions {
	fuzzyThreshold?: number;
	vectorThreshold?: number;
	embeddingProvider?: EmbeddingProvider;
}

export async function findDuplicateMemory(
	draft: Pick<ExtractedMemoryDraft, "text">,
	existing: readonly Memory[],
	options: DedupOptions = {},
): Promise<DuplicateCheckResult> {
	const normalizedDraft = normalizeText(draft.text);
	for (const memory of existing) {
		if (normalizeText(memory.content) === normalizedDraft) {
			return { duplicate: true, reason: "exact", existingId: memory.id, score: 1 };
		}
	}

	const fuzzyThreshold = options.fuzzyThreshold ?? FUZZY_DUPLICATE_THRESHOLD;
	for (const memory of existing) {
		const score = trigramDiceSimilarity(draft.text, memory.content);
		if (score >= fuzzyThreshold) {
			return { duplicate: true, reason: "fuzzy", existingId: memory.id, score };
		}
	}

	if (options.embeddingProvider) {
		const vectorThreshold = options.vectorThreshold ?? VECTOR_DUPLICATE_THRESHOLD;
		const embedding = await embedDraft(draft.text, options.embeddingProvider);
		return findVectorDuplicate(embedding.vector, existing, vectorThreshold);
	}

	return { duplicate: false };
}

export async function filterDuplicateDrafts(
	drafts: readonly ExtractedMemoryDraft[],
	existing: readonly Memory[],
	options: DedupOptions = {},
): Promise<ExtractedMemoryDraft[]> {
	const accepted: ExtractedMemoryDraft[] = [];
	const acceptedVectors: Array<{ id: string; vector: Float32Array }> = [];
	for (const draft of drafts) {
		const textDuplicate = await findDuplicateMemory(
			draft,
			[...existing, ...acceptedAsMemories(accepted)],
			{ ...options, embeddingProvider: undefined },
		);
		if (textDuplicate.duplicate) continue;

		if (options.embeddingProvider) {
			const vectorThreshold = options.vectorThreshold ?? VECTOR_DUPLICATE_THRESHOLD;
			const embedding = await embedDraft(draft.text, options.embeddingProvider);
			const existingDuplicate = findVectorDuplicate(embedding.vector, existing, vectorThreshold);
			if (existingDuplicate.duplicate) continue;

			const batchDuplicate = findAcceptedVectorDuplicate(
				embedding.vector,
				acceptedVectors,
				vectorThreshold,
			);
			if (batchDuplicate.duplicate) continue;

			acceptedVectors.push({ id: `accepted-${accepted.length}`, vector: embedding.vector });
		}

		accepted.push(draft);
	}
	return accepted;
}

export function trigramDiceSimilarity(left: string, right: string): number {
	const a = trigrams(normalizeText(left));
	const b = trigrams(normalizeText(right));
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let overlap = 0;
	for (const item of a) {
		if (b.has(item)) overlap++;
	}
	return (2 * overlap) / (a.size + b.size);
}

function acceptedAsMemories(drafts: readonly ExtractedMemoryDraft[]): Memory[] {
	return drafts.map((draft, index) => ({
		id: `accepted-${index}`,
		content: draft.text,
		tags: draft.tags,
		source: "dedup",
		created: 0,
		last_used: 0,
		use_count: 0,
		confidence: 1,
	}));
}

async function embedDraft(text: string, embeddingProvider: EmbeddingProvider) {
	const [embedding] = await embeddingProvider.embedBatch([text], { kind: "document" });
	if (!embedding) {
		throw new Error(`Embedding provider '${embeddingProvider.provider}' returned no dedup vector`);
	}
	return embedding;
}

function findVectorDuplicate(
	vector: Float32Array,
	existing: readonly Memory[],
	vectorThreshold: number,
): DuplicateCheckResult {
	for (const memory of existing) {
		const score = cosineSimilarity(vector, readyMemoryVector(memory));
		if (score >= vectorThreshold) {
			return { duplicate: true, reason: "vector", existingId: memory.id, score };
		}
	}
	return { duplicate: false };
}

function findAcceptedVectorDuplicate(
	vector: Float32Array,
	acceptedVectors: readonly { id: string; vector: Float32Array }[],
	vectorThreshold: number,
): DuplicateCheckResult {
	for (const accepted of acceptedVectors) {
		const score = cosineSimilarity(vector, accepted.vector);
		if (score >= vectorThreshold) {
			return { duplicate: true, reason: "vector", existingId: accepted.id, score };
		}
	}
	return { duplicate: false };
}

function readyMemoryVector(memory: Memory): Float32Array {
	if (!memory.embedding) {
		throw new Error(`Memory '${memory.id}' is missing an embedding for vector dedup`);
	}
	if (memory.embedding.status !== "ready") {
		throw new Error(
			`Memory '${memory.id}' embedding status '${memory.embedding.status}' is not ready`,
		);
	}
	if (!memory.embedding.vector) {
		throw new Error(`Memory '${memory.id}' has ready embedding metadata without a vector`);
	}
	return Float32Array.from(memory.embedding.vector);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error(`Vector dimensions ${a.length} and ${b.length} do not match`);
	}
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

function trigrams(value: string): Set<string> {
	if (value.length <= 3) return new Set(value ? [value] : []);
	const items = new Set<string>();
	for (let index = 0; index <= value.length - 3; index++) {
		items.add(value.slice(index, index + 3));
	}
	return items;
}

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}
