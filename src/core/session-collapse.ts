import type { SessionEvent } from "../kernel/types.ts";
import { ContentKind, type Message, messageText } from "../llm/types.ts";

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
		case "primitive_end":
			return fromText(
				event,
				"assistant",
				messageContent(event.data.tool_result_message) ??
					stringValue(event.data.output) ??
					stringValue(event.data.error),
			);
		case "session_end":
			return fromText(event, "assistant", stringValue(event.data.output));
		default:
			return [];
	}
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

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
