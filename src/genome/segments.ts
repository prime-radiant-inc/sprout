import type { MemoryEmbeddingRef } from "../kernel/types.ts";
import type { EmbeddingProvider } from "../llm/embeddings.ts";
import { JsonlStore } from "./jsonl-store.ts";

export interface MemorySegment {
	id: string;
	session_id: string;
	summary: string;
	title: string;
	started_at: number;
	ended_at: number;
	created_at: number;
	message_count: number;
	project_id: string;
	project_confidence: number;
	complexity: number;
	source: "session-collapse";
	embedding?: MemoryEmbeddingRef;
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: RawRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberValue(record: RawRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function embeddingValue(record: RawRecord): MemoryEmbeddingRef | undefined {
	const value = record.embedding;
	return isRecord(value) ? (value as unknown as MemoryEmbeddingRef) : undefined;
}

export function normalizeSegment(raw: unknown, options: { now?: number } = {}): MemorySegment {
	if (!isRecord(raw)) {
		throw new Error("Memory segment record must be an object");
	}
	const id = stringValue(raw, "id");
	if (!id) throw new Error("Memory segment is missing id");
	const sessionId = stringValue(raw, "session_id");
	if (!sessionId) throw new Error(`Memory segment '${id}' is missing session_id`);
	const summary = stringValue(raw, "summary");
	if (!summary) throw new Error(`Memory segment '${id}' is missing summary`);
	const now = options.now ?? Date.now();
	const startedAt = numberValue(raw, "started_at") ?? numberValue(raw, "created_at") ?? now;
	const endedAt = numberValue(raw, "ended_at") ?? startedAt;
	const projectId = stringValue(raw, "project_id") ?? "unknown";

	return {
		...(raw as Partial<MemorySegment>),
		id,
		session_id: sessionId,
		summary,
		title: stringValue(raw, "title") ?? "Session segment",
		started_at: startedAt,
		ended_at: endedAt,
		created_at: numberValue(raw, "created_at") ?? now,
		message_count: numberValue(raw, "message_count") ?? 0,
		project_id: projectId,
		project_confidence: numberValue(raw, "project_confidence") ?? 0,
		complexity: numberValue(raw, "complexity") ?? 1,
		source: "session-collapse",
		embedding: embeddingValue(raw),
	};
}

export async function attachReadySegmentEmbedding(
	segment: MemorySegment,
	provider: EmbeddingProvider,
	options: { now?: number } = {},
): Promise<MemorySegment> {
	const now = options.now ?? Date.now();
	const normalized = normalizeSegment(segment, { now });
	const [embedding] = await provider.embedBatch([normalized.summary], { kind: "document" });
	if (!embedding) {
		throw new Error(`Embedding provider '${provider.provider}' returned no segment vector`);
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

export class SegmentStore {
	private entries: MemorySegment[] = [];
	private readonly jsonl: JsonlStore<unknown>;

	constructor(jsonlPath: string) {
		this.jsonl = new JsonlStore(jsonlPath);
	}

	async load(): Promise<void> {
		this.entries = (await this.jsonl.load()).map((record) => normalizeSegment(record));
	}

	async add(segment: MemorySegment): Promise<void> {
		const normalized = normalizeSegment(segment);
		if (this.entries.some((entry) => entry.id === normalized.id)) {
			throw new Error(`Memory segment with id '${normalized.id}' already exists`);
		}
		this.entries.push(normalized);
		await this.jsonl.append(normalized);
	}

	async save(): Promise<void> {
		await this.jsonl.rewrite(this.entries);
	}

	all(): MemorySegment[] {
		return [...this.entries];
	}

	getById(id: string): MemorySegment | undefined {
		return this.entries.find((segment) => segment.id === id);
	}
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
