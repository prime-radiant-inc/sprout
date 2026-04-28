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
	segmentSummary?: string;
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

type CodeFenceBlock = {
	language: string;
	body: string;
	start: number;
	end: number;
};

type JsonCandidate = {
	text: string;
	priority: number;
	order: number;
	start: number;
	end: number;
};

export async function extractMemoryDrafts(
	request: ExtractionRequest,
): Promise<ExtractedMemoryDraft[]> {
	const response = await request.client.complete({
		model: request.model,
		provider: request.provider,
		messages: [
			Msg.system(request.prompts.system),
			Msg.user(
				renderExtractionUserPrompt(
					request.prompts.user,
					request.messages,
					request.segmentSummary === undefined
						? undefined
						: { segmentSummary: request.segmentSummary },
				),
			),
		],
		temperature: 0.1,
		max_tokens: request.maxTokens ?? 2048,
		metadata: { purpose: "memory.extraction" },
	});

	return normalizeExtractionPayload(parseExtractionJson(messageText(response.message)));
}

export function renderExtractionUserPrompt(
	template: string,
	messages: readonly ExtractionMessage[],
	options: { segmentSummary?: string } = {},
): string {
	return template
		.replace("{formatted_messages}", formatExtractionMessages(messages))
		.replace("{segment_summary}", formattedSegmentSummary(options.segmentSummary));
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
	const trimmed = text.trim();
	const direct = tryParseJson(trimmed);
	if (direct.ok) return direct.value;

	const parsedCandidates = jsonExtractionCandidates(trimmed).flatMap((candidate) => {
		const parsed = tryParseJson(candidate.text);
		return parsed.ok
			? [
					{
						value: parsed.value,
						rank: candidate.priority + jsonPayloadScore(parsed.value),
						order: candidate.order,
						start: candidate.start,
						end: candidate.end,
					},
				]
			: [];
	});
	const best = parsedCandidates.reduce<
		{ value: unknown; rank: number; order: number; start: number; end: number } | undefined
	>((currentBest, candidate) => {
		if (!currentBest) return candidate;
		if (candidate.rank > currentBest.rank) return candidate;
		if (candidate.rank < currentBest.rank) return currentBest;
		if (containsRange(candidate, currentBest)) return candidate;
		if (containsRange(currentBest, candidate)) return currentBest;
		if (candidate.order > currentBest.order) return candidate;
		return currentBest;
	}, undefined);
	if (best) return best.value;
	throw direct.error;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		try {
			return { ok: true, value: JSON.parse(repairJson(text)) };
		} catch {
			return { ok: false, error };
		}
	}
}

function formattedSegmentSummary(summary: string | undefined): string {
	const trimmed = summary?.trim();
	return trimmed ? escapeXml(trimmed) : "(none)";
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

function jsonExtractionCandidates(text: string): JsonCandidate[] {
	const candidates: JsonCandidate[] = [];
	const seen = new Set<string>();
	let order = 0;
	const add = (candidateText: string, priority: number, start: number, end: number) => {
		const trimmed = candidateText.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		candidates.push({ text: trimmed, priority, start, end, order: order++ });
	};
	const blocks = codeFenceBlocks(text);
	for (const block of blocks) {
		if (block.language === "json") {
			add(block.body, 300, block.start, block.end);
		} else if (block.language === "" && startsLikeJson(block.body)) {
			add(block.body, 250, block.start, block.end);
		}
	}
	const outsideFences = removeRanges(text, blocks);
	for (const span of balancedJsonSpans(outsideFences)) {
		add(span.text, 100, span.start, span.end);
	}
	return candidates;
}

function codeFenceBlocks(text: string): CodeFenceBlock[] {
	const blocks: CodeFenceBlock[] = [];
	const fencePattern = /```([\s\S]*?)```/g;
	let lastClosedFenceEnd = 0;
	for (const match of text.matchAll(fencePattern)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		blocks.push({ ...splitFenceContent(match[1] ?? ""), start, end });
		lastClosedFenceEnd = end;
	}
	const trailing = text.slice(lastClosedFenceEnd);
	const unterminated = trailing.match(/(?:^|\n)[ \t]*```([\s\S]*)$/);
	if (unterminated) {
		const matchOffset = unterminated.index ?? 0;
		const fenceOffset = unterminated[0]?.indexOf("```") ?? 0;
		const start = lastClosedFenceEnd + matchOffset + fenceOffset;
		blocks.push({ ...splitFenceContent(unterminated[1] ?? ""), start, end: text.length });
	}
	return blocks;
}

function splitFenceContent(rawContent: string): { language: string; body: string } {
	const content = rawContent.trim();
	if (startsLikeJson(content)) return { language: "", body: content };

	const newline = content.match(/\r?\n/);
	if (newline?.index !== undefined) {
		const info = content.slice(0, newline.index).trim();
		const body = content.slice(newline.index + newline[0].length).trim();
		return { language: fenceLanguage(info), body };
	}

	const match = content.match(/^([A-Za-z0-9_-]+)[ \t]+([\s\S]*)$/);
	if (!match) return { language: "", body: content };
	return { language: match[1]!.toLowerCase(), body: match[2]!.trim() };
}

function fenceLanguage(info: string): string {
	return (info.split(/\s+/)[0] ?? "").toLowerCase();
}

function startsLikeJson(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function removeRanges(
	text: string,
	ranges: readonly Pick<CodeFenceBlock, "start" | "end">[],
): string {
	let result = "";
	let cursor = 0;
	for (const range of ranges) {
		result += text.slice(cursor, range.start);
		result += " ".repeat(range.end - range.start);
		cursor = range.end;
	}
	return result + text.slice(cursor);
}

function balancedJsonSpans(text: string): Array<{ text: string; start: number; end: number }> {
	const spans: Array<{ text: string; start: number; end: number }> = [];
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char !== "{" && char !== "[") continue;
		const span = balancedJsonSpanAt(text, index);
		if (!span) continue;
		spans.push({ text: span.text, start: index, end: span.end });
	}
	return spans;
}

function balancedJsonSpanAt(
	text: string,
	start: number,
): { text: string; end: number } | undefined {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			stack.push("}");
			continue;
		}
		if (char === "[") {
			stack.push("]");
			continue;
		}
		if (char !== "}" && char !== "]") continue;
		const expected = stack.pop();
		if (expected !== char) return undefined;
		if (stack.length === 0) return { text: text.slice(start, index + 1), end: index + 1 };
	}
	return undefined;
}

function jsonPayloadScore(value: unknown): number {
	if (Array.isArray(value)) {
		return value.some(hasMemoryText) ? 100 : 60;
	}
	if (!isRecord(value)) return 0;
	if (Array.isArray(value.memories)) return 100;
	if (typeof value.summary === "string" || typeof value.title === "string") return 95;
	if (hasMemoryText(value)) return 90;
	return 50;
}

function hasMemoryText(value: unknown): boolean {
	return isRecord(value) && (typeof value.text === "string" || typeof value.content === "string");
}

function containsRange(
	outer: Pick<JsonCandidate, "start" | "end">,
	inner: Pick<JsonCandidate, "start" | "end">,
): boolean {
	return (
		outer.start <= inner.start &&
		outer.end >= inner.end &&
		outer.end - outer.start > inner.end - inner.start
	);
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
