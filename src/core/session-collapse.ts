import { filterDuplicateDrafts } from "../genome/dedup.ts";
import { extractMemoryDrafts, memoryFromDraft, parseExtractionJson } from "../genome/extraction.ts";
import type { Genome } from "../genome/genome.ts";
import { type DetectedProject, detectProjectFromCwd } from "../genome/projects.ts";
import type { MemorySegment } from "../genome/segments.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { ContentKind, type Message, Msg, messageText } from "../llm/types.ts";

const MAX_COLLAPSE_OUTCOME_CHARS = 2000;

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
	project?: DetectedProject;
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

export function redactSensitiveTranscriptContent(content: string): string {
	return content
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
			"[REDACTED_PRIVATE_KEY]",
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [REDACTED_TOKEN]")
		.replace(/\b(?:sk-ant|sk)-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
		.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
		.replace(
			/\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s]+)/gi,
			(_match, prefix: string, value: string) => redactGenericKeyedSecret(prefix, value),
		)
		.replace(
			/(["']?\b(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token|private[_-]?key)\b["']?\s*[:=]\s*)(["'][^"'\n]*["']|[^\s,}]+)/gi,
			(_match, prefix: string, value: string) => redactGenericKeyedSecret(prefix, value),
		);
}

function redactGenericKeyedSecret(prefix: string, value: string): string {
	return `${prefix}${isRedactionMarkerValue(value) ? value : "[REDACTED_SECRET]"}`;
}

function isRedactionMarkerValue(value: string): boolean {
	const trimmed = value.trim();
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;
	return /^\[REDACTED_[A-Z_]+\]$/.test(unquoted);
}

export async function collapseSessionToMemory(
	input: CollapseSessionToMemoryInput,
): Promise<CollapseSessionToMemoryResult | "skipped"> {
	const collapsedThrough = latestCollapsedTranscriptTimestamp(
		input.genome.segments.all(),
		input.sessionId,
	);
	const transcript = buildCollapseTranscript(input.events)
		.filter((message) => message.timestamp > collapsedThrough)
		.map(redactTranscriptMessage);
	if (transcript.length === 0) return "skipped";

	const now = input.now ?? Date.now();
	const project =
		input.project ??
		(await detectProjectFromCwd({
			cwd: input.cwd,
			explicitProject: input.explicitProject,
			metadataProject: input.metadataProject,
		}));
	const summary = await summarizeTranscript({
		client: input.client,
		model: input.model,
		provider: input.provider,
		prompts: await input.genome.loadSegmentSummaryPrompts(),
		transcript,
		previousSummaries: recentSegmentSummaries(input.genome.segments.all(), {
			project,
			sessionId: input.sessionId,
		}),
	});
	const segment = buildSegmentRecord({
		sessionId: input.sessionId,
		transcript,
		summary,
		project,
		now,
	});

	const extractionMessages = transcript.map((message) => ({
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
					segmentSummary: summary.summary,
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

	const persistedMemories = await input.genome.addSegmentWithMemories(segment, memories);

	return {
		segment,
		project,
		extractedMemoryCount: persistedMemories.length,
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

function redactTranscriptMessage(message: CollapseTranscriptMessage): CollapseTranscriptMessage {
	const content = redactSensitiveTranscriptContent(message.content);
	return content === message.content ? message : { ...message, content };
}

async function summarizeTranscript(input: {
	client: Client;
	model: string;
	provider: string;
	prompts: { system: string; user: string };
	transcript: readonly CollapseTranscriptMessage[];
	previousSummaries: string;
}): Promise<SegmentSummaryResult> {
	const response = await input.client.complete({
		model: input.model,
		provider: input.provider,
		messages: [
			Msg.system(input.prompts.system),
			Msg.user(
				input.prompts.user
					.replace("{formatted_messages}", renderCollapseTranscript(input.transcript))
					.replace("{previous_summaries}", input.previousSummaries),
			),
		],
		temperature: 0.1,
		max_tokens: 1200,
	});
	return normalizeSegmentSummary(parseExtractionJson(messageText(response.message)));
}

function recentSegmentSummaries(
	segments: readonly MemorySegment[],
	context: { project: DetectedProject; sessionId: string },
): string {
	const relevant = segments.filter(
		(segment) =>
			segment.session_id === context.sessionId ||
			(context.project.id !== "unknown" && segment.project_id === context.project.id),
	);
	const recent = relevant.sort((a, b) => a.ended_at - b.ended_at).slice(-5);
	if (recent.length === 0) return "(none)";
	return recent.map((segment) => `- ${escapeXml(segment.summary)}`).join("\n");
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
	const status = success
		? `Tool ${name} completed successfully.`
		: event.data.success === false
			? `Tool ${name} failed.`
			: `Tool ${name} completed.`;
	const outcome = boundedOutcomeText(event);
	return outcome ? `${status}\nOutput: ${outcome}` : status;
}

function actMetadata(event: SessionEvent): string | undefined {
	const name = stringValue(event.data.agent_name) ?? "agent";
	const success = event.data.success === true;
	const status = success
		? `Delegated agent ${name} completed successfully.`
		: event.data.success === false
			? `Delegated agent ${name} failed.`
			: `Delegated agent ${name} completed.`;
	const goal = stringValue(event.data.goal);
	const outcome = boundedOutcomeText(event);
	return [status, goal ? `Goal: ${goal}` : undefined, outcome ? `Output: ${outcome}` : undefined]
		.filter((line) => line !== undefined)
		.join("\n");
}

function boundedOutcomeText(event: SessionEvent): string | undefined {
	const raw =
		messageContent(event.data.tool_result_message) ??
		stringValue(event.data.output) ??
		stringValue(event.data.error);
	if (!raw) return undefined;
	const normalized = raw.trim();
	if (!normalized) return undefined;
	return truncateTranscriptOutcome(redactSensitiveTranscriptContent(normalized));
}

function truncateTranscriptOutcome(value: string): string {
	if (value.length <= MAX_COLLAPSE_OUTCOME_CHARS) return value;
	return `${value.slice(0, MAX_COLLAPSE_OUTCOME_CHARS).trimEnd()}\n[truncated]`;
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
