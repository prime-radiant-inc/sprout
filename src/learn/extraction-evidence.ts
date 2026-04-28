import type { ExtractionMessage } from "../genome/extraction.ts";
import { collectObserverAgentIds, isObserverTelemetryEvent } from "../kernel/observer-telemetry.ts";
import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";
import type { LearnSignal, SessionEvent } from "../kernel/types.ts";
import { ContentKind, type Message, messageText } from "../llm/types.ts";

const EVIDENCE_WINDOW_BEFORE_MS = 5 * 60 * 1000;
const EVIDENCE_WINDOW_AFTER_MS = 30 * 1000;
const MAX_EVIDENCE_EVENTS = 40;
const MAX_EVENT_FIELD_CHARS = 2000;

export interface LearnSignalExtractionInput {
	signal: LearnSignal;
	events: readonly SessionEvent[];
}

export function learnSignalExtractionMessages(
	input: LearnSignalExtractionInput,
): ExtractionMessage[] {
	const events = learnSignalEvidenceWindow(input);
	if (events.length === 0) return [];

	return [
		{
			role: "user",
			content: [
				"The following is a learn-pipeline observation.",
				`Signal kind: ${input.signal.kind}`,
				`Signal agent: ${signalField(input.signal.agent_name)}`,
				`Signal goal: ${signalField(input.signal.goal)}`,
				`Signal output: ${signalField(input.signal.details.output)}`,
				`Signal success: ${input.signal.details.success}`,
				`Signal stumbles: ${input.signal.details.stumbles}`,
				`Signal turns: ${input.signal.details.turns}`,
				`Signal timed_out: ${input.signal.details.timed_out}`,
				"Relevant event window:",
				renderLearnEvidenceEvents(events),
			].join("\n"),
			timestamp: input.signal.timestamp,
		},
	];
}

export function learnSignalEvidenceWindow(input: LearnSignalExtractionInput): SessionEvent[] {
	const sessionEvents = eventsForSession(input.events, input.signal.session_id);
	const observerAgentIds = collectObserverAgentIds(sessionEvents);
	const start = input.signal.timestamp - EVIDENCE_WINDOW_BEFORE_MS;
	const end = input.signal.timestamp + EVIDENCE_WINDOW_AFTER_MS;
	return sessionEvents
		.filter((event) => event.timestamp >= start && event.timestamp <= end)
		.filter((event) => isLearnEvidenceEvent(event, observerAgentIds))
		.sort((a, b) => a.timestamp - b.timestamp)
		.slice(-MAX_EVIDENCE_EVENTS);
}

export function renderLearnEvidenceEvents(events: readonly SessionEvent[]): string {
	return events.map(renderLearnEvidenceEvent).join("\n");
}

function eventsForSession(events: readonly SessionEvent[], sessionId: string): SessionEvent[] {
	const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
	const sessionEvents: SessionEvent[] = [];
	let activeCount = 0;

	for (const event of sorted) {
		const data = eventData(event);
		if (event.kind === "session_start" && stringValue(data.session_id) === sessionId) {
			activeCount++;
		}
		if (activeCount > 0) sessionEvents.push(event);
		if (
			event.kind === "session_end" &&
			stringValue(data.session_id) === sessionId &&
			activeCount > 0
		) {
			activeCount--;
		}
	}

	if (sessionEvents.length > 0) return sessionEvents;
	return sorted.filter((event) => stringValue(eventData(event).session_id) === sessionId);
}

function isLearnEvidenceEvent(event: SessionEvent, observerAgentIds: ReadonlySet<string>): boolean {
	if (isObserverTelemetryEvent(event, observerAgentIds)) return false;
	return (
		event.kind === "session_start" ||
		event.kind === "session_end" ||
		event.kind === "perceive" ||
		event.kind === "steering" ||
		event.kind === "primitive_start" ||
		event.kind === "primitive_end" ||
		event.kind === "act_start" ||
		event.kind === "act_end" ||
		event.kind === "verify" ||
		event.kind === "learn_signal" ||
		event.kind === "warning" ||
		event.kind === "error"
	);
}

function renderLearnEvidenceEvent(event: SessionEvent): string {
	const timestamp = new Date(event.timestamp).toISOString();
	return `<event kind="${event.kind}" time="${timestamp}" agent="${escapeXml(event.agent_id)}" depth="${event.depth}">
${renderEventLines(event)}
</event>`;
}

function renderEventLines(event: SessionEvent): string {
	const lines: string[] = [];
	const data = eventData(event);
	addLine(lines, "session_id", stringValue(data.session_id));
	addLine(lines, "goal", stringValue(data.goal));
	addLine(lines, "text", stringValue(data.text));
	addLine(lines, "agent_name", stringValue(data.agent_name));
	addLine(lines, "primitive", stringValue(data.name));
	addLine(lines, "display_name", stringValue(data.display_name));
	addLine(lines, "description", stringValue(data.description));
	addLine(lines, "success", primitiveValue(data.success));
	addLine(lines, "stumbled", primitiveValue(data.stumbled));
	addLine(lines, "stumbles", primitiveValue(data.stumbles));
	addLine(lines, "turns", primitiveValue(data.turns));
	addLine(lines, "timed_out", primitiveValue(data.timed_out));
	addLine(lines, "output", stringValue(data.output));
	addLine(lines, "error", stringValue(data.error));
	addLine(lines, "message", stringValue(data.message));
	addLine(lines, "tool_result", messageContent(data.tool_result_message));
	addLine(lines, "signal", signalSummary(data.signal));
	addLine(lines, "args", jsonValue(data.args));
	return lines.length > 0 ? lines.join("\n") : "(no selected fields)";
}

function addLine(lines: string[], label: string, value: string | undefined): void {
	const normalized = value?.trim();
	if (!normalized) return;
	lines.push(`${label}: ${escapeXml(truncate(redactSensitiveTranscriptContent(normalized)))}`);
}

function signalField(value: string): string {
	return escapeXml(truncate(redactSensitiveTranscriptContent(value)));
}

function signalSummary(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const kind = stringValue(value.kind);
	const agent = stringValue(value.agent_name);
	const goal = stringValue(value.goal);
	const details = isRecord(value.details) ? value.details : undefined;
	const output = details ? stringValue(details.output) : undefined;
	return [
		kind ? `kind=${kind}` : undefined,
		agent ? `agent=${agent}` : undefined,
		goal ? `goal=${goal}` : undefined,
		output ? `output=${output}` : undefined,
	]
		.filter((part) => part !== undefined)
		.join("; ");
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

function jsonValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function primitiveValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventData(event: SessionEvent): Record<string, unknown> {
	return isRecord(event.data) ? event.data : {};
}

function truncate(value: string): string {
	if (value.length <= MAX_EVENT_FIELD_CHARS) return value;
	return `${value.slice(0, MAX_EVENT_FIELD_CHARS).trimEnd()}\n[truncated]`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
