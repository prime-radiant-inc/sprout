export const DEFAULT_EMBEDDING_PROVIDER = "local";
export const DEFAULT_EMBEDDING_MODEL = "MongoDB/mdbr-leaf-ir";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_LOCAL_EMBEDDING_DTYPE = "q4";
export const DEFAULT_LOCAL_DENSE_LAYER_PATH = "2_Dense/model.safetensors";
export const LOCAL_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export type EmbeddingInputKind = "query" | "document";
export type LocalEmbeddingDType = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export interface EmbeddingOptions {
	kind?: EmbeddingInputKind;
}

export interface EmbeddingVector {
	text: string;
	vector: Float32Array;
	provider: string;
	model: string;
	dimensions: number;
}

export interface EmbeddingProvider {
	readonly provider: string;
	readonly model: string;
	readonly dimensions: number;
	embedBatch(texts: readonly string[], options?: EmbeddingOptions): Promise<EmbeddingVector[]>;
}

export interface LocalEmbeddingProviderOptions {
	model?: string;
	dimensions?: number;
	dtype?: LocalEmbeddingDType;
	queryPrefix?: string;
	denseLayerPath?: string | null;
	loader?: LocalEmbeddingModelLoader;
}

interface TensorLike {
	data?: Float32Array | number[];
	dims?: number[];
}

export interface DenseLayer {
	readonly weight: Float32Array;
	readonly bias: Float32Array;
	readonly inputDimensions: number;
	readonly outputDimensions: number;
}

export type LocalFeatureExtractor = (
	texts: string[],
	options: { pooling: "mean"; normalize: boolean },
) => Promise<TensorLike>;

export type LocalEmbeddingModelLoader = (
	model: string,
	options: {
		dtype: LocalEmbeddingDType;
		denseLayerPath: string | null;
	},
) => Promise<{ extractor: LocalFeatureExtractor; denseLayer?: DenseLayer }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly provider = DEFAULT_EMBEDDING_PROVIDER;
	readonly model: string;
	readonly dimensions: number;
	private readonly dtype: LocalEmbeddingDType;
	private readonly queryPrefix: string;
	private readonly denseLayerPath: string | null;
	private readonly loader: LocalEmbeddingModelLoader;
	private loaded?: Promise<{ extractor: LocalFeatureExtractor; denseLayer?: DenseLayer }>;

	constructor(options: LocalEmbeddingProviderOptions = {}) {
		this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
		this.dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
		this.dtype = options.dtype ?? DEFAULT_LOCAL_EMBEDDING_DTYPE;
		this.queryPrefix = options.queryPrefix ?? LOCAL_QUERY_PREFIX;
		this.denseLayerPath = options.denseLayerPath ?? DEFAULT_LOCAL_DENSE_LAYER_PATH;
		this.loader = options.loader ?? loadTransformersModel;
	}

	async embedBatch(
		texts: readonly string[],
		options: EmbeddingOptions = {},
	): Promise<EmbeddingVector[]> {
		if (texts.length === 0) return [];
		const loaded = await this.load();
		const kind = options.kind ?? "document";
		const prepared = texts.map((text) => (kind === "query" ? `${this.queryPrefix}${text}` : text));
		const output = await loaded.extractor(prepared, { pooling: "mean", normalize: true });
		const baseVectors = splitTensor(output, texts.length);
		const denseLayer = loaded.denseLayer;
		const vectors = denseLayer
			? baseVectors.map((vector) => applyDenseLayer(vector, denseLayer))
			: baseVectors;

		return vectors.map((vector, index) => {
			if (vector.length !== this.dimensions) {
				throw new Error(
					`Embedding vector dimensions ${vector.length} do not match expected ${this.dimensions}`,
				);
			}
			return {
				text: texts[index] ?? "",
				vector,
				provider: this.provider,
				model: this.model,
				dimensions: vector.length,
			};
		});
	}

	private load(): Promise<{ extractor: LocalFeatureExtractor; denseLayer?: DenseLayer }> {
		this.loaded ??= this.loader(this.model, {
			dtype: this.dtype,
			denseLayerPath: this.denseLayerPath,
		});
		return this.loaded;
	}
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly provider = "fake";
	readonly model = "fake-deterministic";

	constructor(readonly dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {}

	async embedBatch(
		texts: readonly string[],
		options: EmbeddingOptions = {},
	): Promise<EmbeddingVector[]> {
		const kind = options.kind ?? "document";
		return texts.map((text) => ({
			text,
			vector: deterministicEmbedding(`${kind}:${text}`, this.dimensions),
			provider: this.provider,
			model: this.model,
			dimensions: this.dimensions,
		}));
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

export function applyDenseLayer(vector: Float32Array, layer: DenseLayer): Float32Array {
	if (vector.length !== layer.inputDimensions) {
		throw new Error(
			`Dense layer expected ${layer.inputDimensions} input dimensions, got ${vector.length}`,
		);
	}
	const projected = new Float32Array(layer.outputDimensions);
	for (let outputIndex = 0; outputIndex < layer.outputDimensions; outputIndex++) {
		let sum = layer.bias[outputIndex] ?? 0;
		const weightOffset = outputIndex * layer.inputDimensions;
		for (let inputIndex = 0; inputIndex < layer.inputDimensions; inputIndex++) {
			sum += (layer.weight[weightOffset + inputIndex] ?? 0) * (vector[inputIndex] ?? 0);
		}
		projected[outputIndex] = sum;
	}
	return normalizeVector(projected);
}

export function parseDenseLayerSafetensors(buffer: ArrayBuffer): DenseLayer {
	const dataView = new DataView(buffer);
	if (dataView.byteLength < 8) {
		throw new Error("Safetensors buffer is too short");
	}
	const headerLength = Number(dataView.getBigUint64(0, true));
	const dataStart = 8 + headerLength;
	if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || dataStart > buffer.byteLength) {
		throw new Error("Invalid safetensors header length");
	}

	const headerBytes = new Uint8Array(buffer, 8, headerLength);
	const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<
		string,
		SafetensorEntry | undefined
	>;
	const weightEntry = header["linear.weight"];
	const biasEntry = header["linear.bias"];
	if (!weightEntry || !biasEntry) {
		throw new Error("Dense safetensors file is missing linear.weight or linear.bias");
	}
	validateSafetensorEntry("linear.weight", weightEntry, 2);
	validateSafetensorEntry("linear.bias", biasEntry, 1);

	const outputDimensions = weightEntry.shape[0] ?? 0;
	const inputDimensions = weightEntry.shape[1] ?? 0;
	const biasDimensions = biasEntry.shape[0] ?? 0;
	if (outputDimensions !== biasDimensions) {
		throw new Error(
			`Dense layer bias dimensions ${biasDimensions} do not match output dimensions ${outputDimensions}`,
		);
	}

	return {
		weight: readFloat32Tensor(buffer, dataStart, weightEntry),
		bias: readFloat32Tensor(buffer, dataStart, biasEntry),
		inputDimensions,
		outputDimensions,
	};
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

async function loadTransformersModel(
	model: string,
	options: { dtype: LocalEmbeddingDType; denseLayerPath: string | null },
): Promise<{ extractor: LocalFeatureExtractor; denseLayer?: DenseLayer }> {
	const { pipeline } = await import("@huggingface/transformers");
	const [extractor, denseLayer] = await Promise.all([
		pipeline("feature-extraction", model, { dtype: options.dtype }),
		options.denseLayerPath ? fetchDenseLayer(model, options.denseLayerPath) : undefined,
	]);
	return {
		extractor: extractor as LocalFeatureExtractor,
		...(denseLayer ? { denseLayer } : {}),
	};
}

async function fetchDenseLayer(model: string, denseLayerPath: string): Promise<DenseLayer> {
	const response = await fetch(`https://huggingface.co/${model}/resolve/main/${denseLayerPath}`);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch dense embedding layer ${denseLayerPath}: ${response.status} ${response.statusText}`,
		);
	}
	return parseDenseLayerSafetensors(await response.arrayBuffer());
}

function splitTensor(tensor: TensorLike, batchSize: number): Float32Array[] {
	const raw = tensor.data;
	if (!raw) {
		throw new Error("Local embedding tensor is missing data");
	}
	const data = raw instanceof Float32Array ? raw : Float32Array.from(raw);
	const dimensions = tensor.dims?.at(-1);
	if (!dimensions || dimensions <= 0) {
		throw new Error(`Invalid embedding dimensions: ${dimensions ?? "missing"}`);
	}
	if (data.length !== batchSize * dimensions) {
		throw new Error(
			`Embedding tensor length ${data.length} does not match batch ${batchSize} x ${dimensions}`,
		);
	}

	const vectors: Float32Array[] = [];
	for (let index = 0; index < batchSize; index++) {
		const start = index * dimensions;
		vectors.push(data.slice(start, start + dimensions));
	}
	return vectors;
}

interface SafetensorEntry {
	dtype: string;
	shape: number[];
	data_offsets: [number, number];
}

function validateSafetensorEntry(name: string, entry: SafetensorEntry, rank: number): void {
	if (entry.dtype !== "F32") {
		throw new Error(`${name} must be F32, got ${entry.dtype}`);
	}
	if (entry.shape.length !== rank || entry.shape.some((dimension) => dimension <= 0)) {
		throw new Error(`${name} has invalid shape ${entry.shape.join("x")}`);
	}
	const [start, end] = entry.data_offsets;
	if (start < 0 || end <= start) {
		throw new Error(`${name} has invalid data offsets ${start}:${end}`);
	}
}

function readFloat32Tensor(
	buffer: ArrayBuffer,
	dataStart: number,
	entry: SafetensorEntry,
): Float32Array {
	const [start, end] = entry.data_offsets;
	const byteLength = end - start;
	if (byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
		throw new Error(`F32 tensor byte length ${byteLength} is not divisible by 4`);
	}
	const bytes = buffer.slice(dataStart + start, dataStart + end);
	const tensor = new Float32Array(bytes);
	const expectedLength = entry.shape.reduce((product, dimension) => product * dimension, 1);
	if (tensor.length !== expectedLength) {
		throw new Error(`F32 tensor length ${tensor.length} does not match shape ${expectedLength}`);
	}
	return tensor;
}
