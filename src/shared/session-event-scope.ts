import type { EventKind, SessionEvent } from "../kernel/types.ts";

const SESSION_LOCAL_EVENT_KINDS = new Set<EventKind>(["session_clear", "exit_hint"]);

export function shouldTagAgentEventWithSessionId(kind: EventKind): boolean {
	return !SESSION_LOCAL_EVENT_KINDS.has(kind);
}

/**
 * True when a session-scoped event belongs to the given session. Events
 * without a session id apply everywhere unless `requireSessionId` says a
 * cleared session must only accept explicitly-tagged events.
 */
export function sessionScopedEventApplies(
	event: SessionEvent,
	currentSessionId: string | undefined,
	requireSessionId = false,
): boolean {
	const raw = event.data.session_id;
	const eventSessionId = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
	if (requireSessionId && !eventSessionId) return false;
	return !eventSessionId || !currentSessionId || eventSessionId === currentSessionId;
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
