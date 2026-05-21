import { describe, expect, test } from "bun:test";
import type { EventKind, SessionEvent } from "../../src/kernel/types.ts";
import {
	requiresSessionIdAfterClear,
	shouldTagAgentEventWithSessionId,
} from "../../src/shared/session-event-scope.ts";

function event(
	kind: SessionEvent["kind"],
	agentId = "root",
	data: Record<string, unknown> = {},
): SessionEvent {
	return {
		kind,
		timestamp: 1,
		agent_id: agentId,
		depth: 0,
		data,
	};
}

describe("session event scope", () => {
	test("requires session ids for run-scoped events after a clear", () => {
		for (const kind of [
			"plan_start",
			"llm_start",
			"primitive_start",
			"task_update",
			"warning",
		] as EventKind[]) {
			expect(requiresSessionIdAfterClear(event(kind))).toBe(true);
			expect(shouldTagAgentEventWithSessionId(kind)).toBe(true);
		}
	});

	test("leaves session-local frontend events unscoped", () => {
		for (const kind of ["session_clear", "exit_hint"] as EventKind[]) {
			expect(requiresSessionIdAfterClear(event(kind))).toBe(false);
			expect(shouldTagAgentEventWithSessionId(kind)).toBe(false);
		}
	});

	test("allows cli and session warning events without session ids", () => {
		expect(requiresSessionIdAfterClear(event("warning", "cli"))).toBe(false);
		expect(requiresSessionIdAfterClear(event("warning", "session"))).toBe(false);
		expect(shouldTagAgentEventWithSessionId("warning")).toBe(true);
	});
});
