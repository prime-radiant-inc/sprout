import type { Memory } from "../kernel/types.ts";

export const MEMORY_SCHEMA_VERSION = 2;

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

function stringArrayValue(record: RawRecord, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function recordArrayValue<T>(record: RawRecord, key: string): T[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord) as T[];
}

function recordValue<T>(record: RawRecord, key: string): T | undefined {
	const value = record[key];
	return isRecord(value) ? (value as T) : undefined;
}

export function memoryShortId(id: string): string {
	if (/^mem_[a-zA-Z0-9]{8}$/.test(id)) return id.toLowerCase();
	const normalized = id.trim().toLowerCase();
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalized.length; index++) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `mem_${hash.toString(16).padStart(8, "0")}`;
}

export function normalizeMemory(raw: unknown, options: { now?: number } = {}): Memory {
	if (!isRecord(raw)) {
		throw new Error("Memory record must be an object");
	}

	const now = options.now ?? Date.now();
	const id = stringValue(raw, "id");
	if (!id) {
		throw new Error("Memory record is missing id");
	}

	const text = stringValue(raw, "text") ?? stringValue(raw, "content");
	if (!text) {
		throw new Error(`Memory '${id}' is missing content/text`);
	}

	const created = numberValue(raw, "created") ?? numberValue(raw, "created_at") ?? now;
	const lastUsed = numberValue(raw, "last_used") ?? numberValue(raw, "last_accessed_at") ?? created;
	const useCount = numberValue(raw, "use_count") ?? numberValue(raw, "access_count") ?? 0;
	const confidence = numberValue(raw, "confidence") ?? 1.0;

	return {
		...(raw as Partial<Memory>),
		id,
		content: text,
		text,
		tags: stringArrayValue(raw, "tags"),
		source: stringValue(raw, "source") ?? "unknown",
		created,
		last_used: lastUsed,
		use_count: useCount,
		confidence,
		schema_version: MEMORY_SCHEMA_VERSION,
		short_id: stringValue(raw, "short_id") ?? memoryShortId(id),
		created_at: numberValue(raw, "created_at") ?? created,
		updated_at: numberValue(raw, "updated_at") ?? created,
		last_accessed_at: numberValue(raw, "last_accessed_at") ?? lastUsed,
		access_count: numberValue(raw, "access_count") ?? useCount,
		mention_count: numberValue(raw, "mention_count") ?? 0,
		importance_score: numberValue(raw, "importance_score") ?? confidence,
		effective_importance: numberValue(raw, "effective_importance") ?? confidence,
		embedding: recordValue(raw, "embedding"),
		outbound_links: recordArrayValue(raw, "outbound_links"),
		inbound_links: recordArrayValue(raw, "inbound_links"),
		entity_links: recordArrayValue(raw, "entity_links"),
		annotations: recordArrayValue(raw, "annotations"),
		project_ids: stringArrayValue(raw, "project_ids"),
		source_segment_id: stringValue(raw, "source_segment_id"),
		source_session_id: stringValue(raw, "source_session_id"),
		happens_at: numberValue(raw, "happens_at"),
		expires_at: numberValue(raw, "expires_at"),
		archived_at: numberValue(raw, "archived_at"),
		archived_reason: stringValue(raw, "archived_reason"),
		superseded_by: stringValue(raw, "superseded_by"),
		consolidates_memory_ids: stringArrayValue(raw, "consolidates_memory_ids"),
		consolidation_rejection_count: numberValue(raw, "consolidation_rejection_count") ?? 0,
		activity_days_at_creation: numberValue(raw, "activity_days_at_creation"),
		activity_days_at_last_access: numberValue(raw, "activity_days_at_last_access"),
	};
}
