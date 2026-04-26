import type { EntityLinkEntry, Memory } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { Msg, messageText } from "../llm/types.ts";
import type { PromptSet } from "./prompts.ts";

export type ExtractionRole = "user" | "assistant";

export interface ExtractionMessage {
	role: ExtractionRole;
	content: string;
	timestamp?: number;
}

export interface ExtractionRequest {
	messages: readonly ExtractionMessage[];
	prompts: PromptSet;
	client: Client;
	model: string;
	provider: string;
	now?: number;
	maxTokens?: number;
}

export interface ExtractedMemoryDraft {
	text: string;
	tags: string[];
	entity_links: EntityLinkEntry[];
	happens_at?: number;
	expires_at?: number;
}

type RawExtractionEntity = {
	name?: unknown;
	type?: unknown;
};

type RawExtractionMemory = {
	text?: unknown;
	content?: unknown;
	tags?: unknown;
	entities?: unknown;
	entity_links?: unknown;
	happens_at?: unknown;
	expires_at?: unknown;
};

const ENTITY_TYPES = new Set<EntityLinkEntry["type"]>([
	"PROJECT",
	"LIBRARY",
	"FILE_PATH",
	"COMMAND",
	"ERROR_TYPE",
	"TECHNOLOGY",
	"PERSON",
]);

export async function extractMemoryDrafts(
	request: ExtractionRequest,
): Promise<ExtractedMemoryDraft[]> {
	const response = await request.client.complete({
		model: request.model,
		provider: request.provider,
		messages: [
			Msg.system(request.prompts.system),
			Msg.user(renderExtractionUserPrompt(request.prompts.user, request.messages)),
		],
		temperature: 0.1,
		max_tokens: request.maxTokens ?? 2048,
	});

	return normalizeExtractionPayload(parseExtractionJson(messageText(response.message)));
}

export function renderExtractionUserPrompt(
	template: string,
	messages: readonly ExtractionMessage[],
): string {
	return template.replace("{formatted_messages}", formatExtractionMessages(messages));
}

export function formatExtractionMessages(messages: readonly ExtractionMessage[]): string {
	return messages
		.map((message) => {
			const timestamp =
				message.timestamp !== undefined
					? ` time="${new Date(message.timestamp).toISOString()}"`
					: "";
			return `<message role="${message.role}"${timestamp}>\n${escapeXml(message.content)}\n</message>`;
		})
		.join("\n");
}

export function parseExtractionJson(text: string): unknown {
	const stripped = stripCodeFence(text.trim());
	try {
		return JSON.parse(stripped);
	} catch {
		return JSON.parse(repairJson(stripped));
	}
}

export function normalizeExtractionPayload(payload: unknown): ExtractedMemoryDraft[] {
	const rawItems = extractionItems(payload);
	return rawItems.flatMap((item) => {
		if (!isRecord(item)) return [];
		const raw = item as RawExtractionMemory;
		const text = stringValue(raw.text) ?? stringValue(raw.content);
		if (!text) return [];
		return [
			{
				text,
				tags: stringArray(raw.tags),
				entity_links: normalizeEntities(raw.entities ?? raw.entity_links),
				...(timestampValue(raw.happens_at) !== undefined
					? { happens_at: timestampValue(raw.happens_at) }
					: {}),
				...(timestampValue(raw.expires_at) !== undefined
					? { expires_at: timestampValue(raw.expires_at) }
					: {}),
			},
		];
	});
}

export function memoryFromDraft(
	draft: ExtractedMemoryDraft,
	options: {
		id: string;
		source: string;
		now?: number;
		confidence?: number;
		sourceSessionId?: string;
		sourceSegmentId?: string;
	},
): Memory {
	const now = options.now ?? Date.now();
	return {
		id: options.id,
		content: draft.text,
		text: draft.text,
		tags: draft.tags,
		source: options.source,
		created: now,
		created_at: now,
		updated_at: now,
		last_used: now,
		last_accessed_at: now,
		use_count: 0,
		access_count: 0,
		confidence: options.confidence ?? 0.8,
		entity_links: draft.entity_links,
		...(draft.happens_at !== undefined ? { happens_at: draft.happens_at } : {}),
		...(draft.expires_at !== undefined ? { expires_at: draft.expires_at } : {}),
		...(options.sourceSessionId ? { source_session_id: options.sourceSessionId } : {}),
		...(options.sourceSegmentId ? { source_segment_id: options.sourceSegmentId } : {}),
	};
}

function extractionItems(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];
	if (Array.isArray(payload.memories)) return payload.memories;
	return [payload];
}

function normalizeEntities(value: unknown): EntityLinkEntry[] {
	if (!Array.isArray(value)) return [];
	const entities = new Map<string, EntityLinkEntry>();
	for (const entity of value) {
		if (!isRecord(entity)) continue;
		const raw = entity as RawExtractionEntity;
		const name = stringValue(raw.name);
		const type = normalizeEntityType(raw.type);
		if (!name || !type) continue;
		const uuid = `entity_${type.toLowerCase()}_${slug(name)}`;
		const key = `${type}:${uuid}`;
		if (!entities.has(key)) {
			entities.set(key, { uuid, name, type });
		}
	}
	return [...entities.values()];
}

function normalizeEntityType(value: unknown): EntityLinkEntry["type"] | undefined {
	if (typeof value !== "string") return undefined;
	const upper = value.toUpperCase();
	return ENTITY_TYPES.has(upper as EntityLinkEntry["type"])
		? (upper as EntityLinkEntry["type"])
		: undefined;
}

function timestampValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function stripCodeFence(text: string): string {
	const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	return match?.[1]?.trim() ?? text;
}

function repairJson(text: string): string {
	return text
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/,\s*([}\]])/g, "$1");
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
	const slugged = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slugged || "entity";
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
