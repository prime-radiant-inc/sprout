import type { SessionEvent } from "./types.ts";

/** Collect runtime observer ids from lifecycle events across the full session. */
export function collectObserverAgentIds(events: readonly SessionEvent[]): Set<string> {
	const ids = new Set<string>();
	for (const event of events) {
		const data = eventData(event);
		if (event.kind !== "act_start" || data.observer !== true) continue;
		addString(ids, data.child_id);
		addString(ids, data.handle_id);
	}
	return ids;
}

/** Observer telemetry is process guidance, not durable memory evidence. */
export function isObserverTelemetryEvent(
	event: SessionEvent,
	observerAgentIds: ReadonlySet<string>,
): boolean {
	const data = eventData(event);
	if (data.observer === true) return true;
	if (observerAgentIds.has(event.agent_id)) return true;
	if (stringInSet(data.child_id, observerAgentIds)) return true;
	if (stringInSet(data.handle_id, observerAgentIds)) return true;
	if (event.kind === "agent_message") {
		return isObserverAddress(data.from) || isObserverAddress(data.to);
	}
	return false;
}

function isObserverAddress(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.role === "observer";
}

function addString(ids: Set<string>, value: unknown): void {
	if (typeof value === "string" && value.length > 0) {
		ids.add(value);
	}
}

function stringInSet(value: unknown, ids: ReadonlySet<string>): boolean {
	return typeof value === "string" && ids.has(value);
}

function eventData(event: SessionEvent): Record<string, unknown> {
	return isRecord(event.data) ? event.data : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
