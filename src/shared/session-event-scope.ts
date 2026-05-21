import type { EventKind, SessionEvent } from "../kernel/types.ts";

const SESSION_LOCAL_EVENT_KINDS = new Set<EventKind>(["session_clear", "exit_hint"]);

export function shouldTagAgentEventWithSessionId(kind: EventKind): boolean {
	return !SESSION_LOCAL_EVENT_KINDS.has(kind);
}

export function requiresSessionIdAfterClear(event: SessionEvent): boolean {
	if (!shouldTagAgentEventWithSessionId(event.kind)) return false;
	if (
		(event.kind === "warning" || event.kind === "error") &&
		(event.agent_id === "cli" || event.agent_id === "session")
	) {
		return false;
	}
	return true;
}
