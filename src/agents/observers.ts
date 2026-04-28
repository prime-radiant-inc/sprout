import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";
import type {
	AgentModelPurpose,
	EventKind,
	ObserverCommentPolicyConfig,
	SessionEvent,
} from "../kernel/types.ts";

export interface ObserverAttachmentConfig {
	agentName: string;
	target: "root" | "session" | "caller_delegates";
	events: EventKind[];
	trigger: { every: number; event: EventKind };
	maxEvents: number;
	maxChars: number;
	handleId?: string;
	agentId?: string;
	modelPurpose?: AgentModelPurpose;
	description?: string;
	callerAgentId?: string;
	callerDepth?: number;
	comments?: ObserverCommentPolicyConfig;
}

export interface ObserverFrame {
	sessionId: string;
	events: ObserverFrameEvent[];
	truncated: boolean;
}

export interface ObserverFrameEvent {
	index: number;
	kind: EventKind;
	timestamp: number;
	agentId: string;
	depth: number;
	summary: string;
	quote?: string;
}

export interface BuildObserverFrameInput {
	sessionId: string;
	events: SessionEvent[];
	includeKinds: readonly EventKind[];
	maxEvents: number;
	maxChars: number;
	commentPolicy?: ObserverCommentPolicyConfig;
}

const DEFAULT_QUOTE_MAX_CHARS = 600;

export function buildObserverFrame(input: BuildObserverFrameInput): ObserverFrame {
	if (!Number.isInteger(input.maxEvents) || input.maxEvents <= 0) {
		throw new Error(`maxEvents must be a positive integer, got ${input.maxEvents}`);
	}
	if (!Number.isInteger(input.maxChars) || input.maxChars <= 0) {
		throw new Error(`maxChars must be a positive integer, got ${input.maxChars}`);
	}

	const includeKinds = new Set(input.includeKinds);
	const selected = input.events.filter((event) => includeKinds.has(event.kind));
	let truncated = selected.length > input.maxEvents;
	let frameEvents = selected
		.slice(-input.maxEvents)
		.map((event, index) => buildFrameEvent(event, index + 1));

	while (frameEvents.length > 0) {
		const frame = { sessionId: input.sessionId, events: frameEvents, truncated };
		if (renderObserverFrame(frame, input.commentPolicy).length <= input.maxChars) {
			return frame;
		}
		truncated = true;
		frameEvents = frameEvents.slice(1).map((event, index) => ({ ...event, index: index + 1 }));
	}

	return { sessionId: input.sessionId, events: [], truncated };
}

export function renderObserverFrame(
	frame: ObserverFrame,
	commentPolicy?: ObserverCommentPolicyConfig,
): string {
	const lines = [
		"<sprout:observer-frame>",
		`Session: ${escapeXml(frame.sessionId)}`,
		`Truncated: ${frame.truncated ? "yes" : "no"}`,
	];
	const commentPolicyLines = renderCommentPolicy(commentPolicy);
	if (commentPolicyLines.length > 0) {
		lines.push(...commentPolicyLines);
	}

	for (const event of frame.events) {
		lines.push(
			`[${event.index}] ${escapeXml(event.agentId)} ${event.kind} depth=${event.depth}`,
			`Summary: ${escapeXml(event.summary)}`,
		);
		if (event.quote) {
			lines.push(`Quote: "${escapeXml(event.quote)}"`);
		}
	}

	lines.push("</sprout:observer-frame>");
	return lines.join("\n");
}

function renderCommentPolicy(commentPolicy: ObserverCommentPolicyConfig | undefined): string[] {
	if (!commentPolicy) return [];
	const configuredRecipients = [
		...new Set(
			commentPolicy.can_message ??
				(commentPolicy.default_recipient ? [commentPolicy.default_recipient] : []),
		),
	];
	const canMessage = configuredRecipients.filter((recipient) => recipient !== "target");
	const unsupportedRecipients = configuredRecipients.filter((recipient) => recipient === "target");
	const lines = [
		"<sprout:observer-comment-policy>",
		`Can message: ${canMessage.length > 0 ? canMessage.map(escapeXml).join(", ") : "none"}`,
	];
	if (commentPolicy.default_recipient && commentPolicy.default_recipient !== "target") {
		lines.push(`Default recipient: ${escapeXml(commentPolicy.default_recipient)}`);
	}
	if (canMessage.includes("root")) {
		lines.push('For root comments, call message_agent with handle "root" and blocking false.');
	}
	if (canMessage.includes("caller")) {
		lines.push('For caller comments in this subscription, call message_agent with handle "root" and blocking false.');
	}
	if (unsupportedRecipients.length > 0) {
		lines.push(
			`Unsupported recipients omitted: ${unsupportedRecipients.map(escapeXml).join(", ")}.`,
		);
	}
	lines.push("Only comment when the observed evidence makes a short intervention useful.");
	lines.push("</sprout:observer-comment-policy>");
	return lines;
}

function buildFrameEvent(event: SessionEvent, index: number): ObserverFrameEvent {
	const quote = extractQuote(event);
	return {
		index,
		kind: event.kind,
		timestamp: event.timestamp,
		agentId: event.agent_id,
		depth: event.depth,
		summary: summarizeEvent(event, quote),
		...(quote ? { quote } : {}),
	};
}

function summarizeEvent(event: SessionEvent, quote: string | undefined): string {
	switch (event.kind) {
		case "plan_end": {
			const finishReason = stringData(event, "finish_reason");
			return finishReason
				? `Planning turn ended with finish reason '${finishReason}'.`
				: "Planning turn ended.";
		}
		case "primitive_end": {
			const tool = stringData(event, "tool") ?? stringData(event, "name") ?? "primitive";
			const success = booleanData(event, "success");
			if (success === false) return `${tool} failed.`;
			if (success === true) return `${tool} completed.`;
			return `${tool} ended.`;
		}
		case "act_end": {
			const agentName = stringData(event, "agent_name") ?? "agent";
			const success = booleanData(event, "success");
			if (success === false) return `${agentName} delegation failed.`;
			if (success === true) return `${agentName} delegation completed.`;
			return `${agentName} delegation ended.`;
		}
		case "warning":
			return "Warning emitted.";
		case "error":
			return "Error emitted.";
		case "compaction":
			return "Context compaction occurred.";
		case "interrupted":
			return "Agent was interrupted.";
		default:
			return quote
				? `${event.kind} event emitted.`
				: `${event.kind} event emitted without quoted text.`;
	}
}

function extractQuote(event: SessionEvent): string | undefined {
	const candidates = [
		stringData(event, "text"),
		stringData(event, "message"),
		stringData(event, "error"),
		stringData(event, "output"),
		stringData(event, "result"),
		toolResultMessageContent(event.data.tool_result_message),
	];
	const raw = candidates.find((value) => value !== undefined && value.trim().length > 0);
	if (!raw) return undefined;
	return truncate(redactSensitiveTranscriptContent(raw.trim()), DEFAULT_QUOTE_MAX_CHARS);
}

function toolResultMessageContent(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const content = value.content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (!isRecord(part) || part.kind !== "tool_result" || !isRecord(part.tool_result)) {
			continue;
		}
		const toolContent = part.tool_result.content;
		if (typeof toolContent === "string") return toolContent;
		if (toolContent !== undefined) return safeStringify(toolContent);
	}
	return undefined;
}

function safeStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringData(event: SessionEvent, key: string): string | undefined {
	const value = event.data[key];
	return typeof value === "string" ? value : undefined;
}

function booleanData(event: SessionEvent, key: string): boolean | undefined {
	const value = event.data[key];
	return typeof value === "boolean" ? value : undefined;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
