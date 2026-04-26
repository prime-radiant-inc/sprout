import { filterDuplicateDrafts } from "../genome/dedup.ts";
import { extractMemoryDrafts, memoryFromDraft, parseExtractionJson } from "../genome/extraction.ts";
import type { Genome } from "../genome/genome.ts";
import { type DetectedProject, detectProjectFromCwd } from "../genome/projects.ts";
import type { MemorySegment } from "../genome/segments.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { ContentKind, type Message, Msg, messageText } from "../llm/types.ts";

export type CollapseTranscriptRole = "user" | "assistant";

export interface CollapseTranscriptMessage {
	role: CollapseTranscriptRole;
	content: string;
	timestamp: number;
	agent_id: string;
	event_kind: SessionEvent["kind"];
}

export interface BuildCollapseTranscriptOptions {
	includeSubagents?: boolean;
}

export interface CollapseSessionToMemoryInput {
	events: readonly SessionEvent[];
	genome: Genome;
	client: Client;
	model: string;
	provider: string;
	sessionId: string;
	cwd: string;
	explicitProject?: string;
	metadataProject?: string;
	now?: number;
}

export interface SegmentSummaryResult {
	summary: string;
	title: string;
	complexity: number;
}

export interface CollapseSessionToMemoryResult {
	segment: MemorySegment;
	project: DetectedProject;
	extractedMemoryCount: number;
}

export function buildCollapseTranscript(
	events: readonly SessionEvent[],
	options: BuildCollapseTranscriptOptions = {},
): CollapseTranscriptMessage[] {
	return [...events]
		.sort((a, b) => a.timestamp - b.timestamp)
		.flatMap((event) => eventToTranscriptMessage(event, options));
}

export function renderCollapseTranscript(messages: readonly CollapseTranscriptMessage[]): string {
	return messages
		.map((message) => {
			const timestamp = new Date(message.timestamp).toISOString();
			return `<message role="${message.role}" time="${timestamp}" agent="${escapeXml(
				message.agent_id,
			)}" event="${message.event_kind}">
${escapeXml(message.content)}
</message>`;
		})
		.join("\n");
}

export async function collapseSessionToMemory(
	input: CollapseSessionToMemoryInput,
): Promise<CollapseSessionToMemoryResult | "skipped"> {
	const collapsedThrough = latestCollapsedTranscriptTimestamp(
		input.genome.segments.all(),
		input.sessionId,
	);
	const transcript = buildCollapseTranscript(input.events).filter(
		(message) => message.timestamp > collapsedThrough,
	);
	if (transcript.length === 0) return "skipped";

	const now = input.now ?? Date.now();
	const project = await detectProjectFromCwd({
		cwd: input.cwd,
		explicitProject: input.explicitProject,
		metadataProject: input.metadataProject,
	});
	const summary = await summarizeTranscript({
		client: input.client,
		model: input.model,
		provider: input.provider,
		prompts: await input.genome.loadSegmentSummaryPrompts(),
		transcript,
	});
	const segment = buildSegmentRecord({
		sessionId: input.sessionId,
		transcript,
		summary,
		project,
		now,
	});

	const extractionMessages = transcript
		.filter((message) => message.role === "user")
		.map((message) => ({
			role: message.role,
			content: message.content,
			timestamp: message.timestamp,
		}));
	const extractionDrafts =
		extractionMessages.length === 0
			? []
			: await extractMemoryDrafts({
					client: input.client,
					model: input.model,
					provider: input.provider,
					prompts: await input.genome.loadMemoryExtractionPrompts(),
					messages: extractionMessages,
				});
	const filtered =
		extractionDrafts.length === 0
			? []
			: await filterDuplicateDrafts(extractionDrafts, input.genome.memories.all(), {
					embeddingProvider: await input.genome.memoryEmbeddingProvider(),
				});

	const memories = filtered.map((draft, index) => {
		const memory = memoryFromDraft(draft, {
			id: `${segment.id}-mem-${index}`,
			source: `segment:${input.sessionId}`,
			now,
			confidence: 0.82,
			sourceSessionId: input.sessionId,
			sourceSegmentId: segment.id,
		});
		return {
			...memory,
			project_ids:
				project.id === "unknown"
					? memory.project_ids
					: [...new Set([...(memory.project_ids ?? []), project.id])],
		};
	});

	await input.genome.addSegmentWithMemories(segment, memories);

	return {
		segment,
		project,
		extractedMemoryCount: filtered.length,
	};
}

function latestCollapsedTranscriptTimestamp(
	segments: readonly MemorySegment[],
	sessionId: string,
): number {
	let latest = -Infinity;
	for (const segment of segments) {
		if (segment.session_id === sessionId && segment.ended_at > latest) {
			latest = segment.ended_at;
		}
	}
	return latest;
}

async function summarizeTranscript(input: {
	client: Client;
	model: string;
	provider: string;
	prompts: { system: string; user: string };
	transcript: readonly CollapseTranscriptMessage[];
}): Promise<SegmentSummaryResult> {
	const response = await input.client.complete({
		model: input.model,
		provider: input.provider,
		messages: [
			Msg.system(input.prompts.system),
			Msg.user(
				input.prompts.user.replace(
					"{formatted_messages}",
					renderCollapseTranscript(input.transcript),
				),
			),
		],
		temperature: 0.1,
		max_tokens: 1200,
	});
	return normalizeSegmentSummary(parseExtractionJson(messageText(response.message)));
}

export function normalizeSegmentSummary(payload: unknown): SegmentSummaryResult {
	if (!isRecord(payload)) {
		throw new Error("Segment summary response must be a JSON object");
	}
	const summary = stringValue(payload.summary) ?? stringValue(payload.synopsis);
	if (!summary) throw new Error("Segment summary response is missing summary");
	return {
		summary,
		title: stringValue(payload.title) ?? stringValue(payload.display_title) ?? "Session segment",
		complexity: clampComplexity(numberValue(payload.complexity)),
	};
}

function eventToTranscriptMessage(
	event: SessionEvent,
	options: BuildCollapseTranscriptOptions,
): CollapseTranscriptMessage[] {
	if (!options.includeSubagents && event.depth !== 0) return [];

	switch (event.kind) {
		case "perceive":
			return fromText(event, "user", stringValue(event.data.goal));
		case "steering":
			return fromText(event, "user", stringValue(event.data.text));
		case "plan_end":
			return fromText(
				event,
				"assistant",
				stringValue(event.data.text) ?? messageContent(event.data.assistant_message),
			);
		case "act_end":
			return fromText(event, "assistant", actMetadata(event));
		case "primitive_end":
			return fromText(event, "assistant", primitiveMetadata(event));
		case "session_end":
			return fromText(event, "assistant", stringValue(event.data.output));
		default:
			return [];
	}
}

function primitiveMetadata(event: SessionEvent): string | undefined {
	const name = stringValue(event.data.display_name) ?? stringValue(event.data.name) ?? "tool";
	const success = event.data.success === true;
	if (success) return `Tool ${name} completed successfully.`;
	if (event.data.success === false) return `Tool ${name} failed.`;
	return `Tool ${name} completed.`;
}

function actMetadata(event: SessionEvent): string | undefined {
	const name = stringValue(event.data.agent_name) ?? "agent";
	const success = event.data.success === true;
	if (success) return `Delegated agent ${name} completed successfully.`;
	if (event.data.success === false) return `Delegated agent ${name} failed.`;
	return `Delegated agent ${name} completed.`;
}

function fromText(
	event: SessionEvent,
	role: CollapseTranscriptRole,
	content: string | undefined,
): CollapseTranscriptMessage[] {
	const trimmed = content?.trim();
	if (!trimmed) return [];
	return [
		{
			role,
			content: trimmed,
			timestamp: event.timestamp,
			agent_id: event.agent_id,
			event_kind: event.kind,
		},
	];
}

function messageContent(value: unknown): string | undefined {
	if (!isMessage(value)) return undefined;
	const text = messageText(value);
	if (text.trim()) return text;
	const toolParts = value.content
		.filter((part) => part.kind === ContentKind.TOOL_RESULT && part.tool_result)
		.map((part) => {
			const content = part.tool_result?.content;
			return typeof content === "string" ? content : JSON.stringify(content);
		})
		.filter((content) => content.trim());
	return toolParts.length > 0 ? toolParts.join("\n") : undefined;
}

function isMessage(value: unknown): value is Message {
	return (
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		"content" in value &&
		Array.isArray((value as Message).content)
	);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildSegmentRecord(input: {
	sessionId: string;
	transcript: readonly CollapseTranscriptMessage[];
	summary: SegmentSummaryResult;
	project: DetectedProject;
	now: number;
}): MemorySegment {
	const startedAt = input.transcript[0]?.timestamp ?? input.now;
	const endedAt = input.transcript.at(-1)?.timestamp ?? startedAt;
	return {
		id: `segment-${slug(input.sessionId)}-${startedAt}`,
		session_id: input.sessionId,
		summary: input.summary.summary,
		title: input.summary.title,
		started_at: startedAt,
		ended_at: endedAt,
		created_at: input.now,
		message_count: input.transcript.length,
		project_id: input.project.id,
		project_confidence: input.project.confidence,
		complexity: input.summary.complexity,
		source: "session-collapse",
	};
}

function clampComplexity(value: number | undefined): number {
	if (value === undefined) return 1;
	return Math.min(3, Math.max(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "")
			.slice(0, 48) || "session"
	);
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
