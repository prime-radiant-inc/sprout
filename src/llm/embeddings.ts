import OpenAI from "openai";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingVector {
	text: string;
	vector: Float32Array;
	provider: string;
	model: string;
	dimensions: number;
}

export interface EmbeddingFailure {
	ok: false;
	provider: string;
	model: string;
	error: string;
}

export interface EmbeddingSuccess {
	ok: true;
	embeddings: EmbeddingVector[];
}

export type EmbeddingBatchResult = EmbeddingSuccess | EmbeddingFailure;

export interface EmbeddingProvider {
	readonly provider: string;
	readonly model: string;
	readonly dimensions: number;
	embedBatch(texts: readonly string[]): Promise<EmbeddingBatchResult>;
}

export interface OpenAIEmbeddingProviderOptions {
	model?: string;
	dimensions?: number;
	baseUrl?: string;
	headers?: Record<string, string>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly provider = "openai";
	readonly model: string;
	readonly dimensions: number;
	private readonly client: OpenAI;

	constructor(apiKey: string, options: OpenAIEmbeddingProviderOptions = {}) {
		this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
		this.dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
		this.client = new OpenAI({
			apiKey,
			baseURL: options.baseUrl,
			defaultHeaders: options.headers,
		});
	}

	async embedBatch(texts: readonly string[]): Promise<EmbeddingBatchResult> {
		if (texts.length === 0) return { ok: true, embeddings: [] };
		try {
			const response = await this.client.embeddings.create({
				model: this.model,
				input: [...texts],
			});
			const embeddings = response.data.map((item, index) => {
				const vector = Float32Array.from(item.embedding);
				return {
					text: texts[index] ?? "",
					vector,
					provider: this.provider,
					model: this.model,
					dimensions: vector.length,
				};
			});
			return { ok: true, embeddings };
		} catch (error: unknown) {
			return {
				ok: false,
				provider: this.provider,
				model: this.model,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly provider = "fake";
	readonly model = "fake-deterministic";

	constructor(readonly dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {}

	async embedBatch(texts: readonly string[]): Promise<EmbeddingBatchResult> {
		return {
			ok: true,
			embeddings: texts.map((text) => ({
				text,
				vector: deterministicEmbedding(text, this.dimensions),
				provider: this.provider,
				model: this.model,
				dimensions: this.dimensions,
			})),
		};
	}
}

export function deterministicEmbedding(text: string, dimensions: number): Float32Array {
	const vector = new Float32Array(dimensions);
	if (dimensions === 0) return vector;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		const slot = index % dimensions;
		vector[slot] = (vector[slot] ?? 0) + (code % 31) / 31;
	}
	return normalizeVector(vector);
}

function normalizeVector(vector: Float32Array): Float32Array {
	let magnitude = 0;
	for (const value of vector) {
		magnitude += value * value;
	}
	if (magnitude === 0) return vector;
	const scale = 1 / Math.sqrt(magnitude);
	for (let index = 0; index < vector.length; index++) {
		vector[index] = vector[index]! * scale;
	}
	return vector;
}
