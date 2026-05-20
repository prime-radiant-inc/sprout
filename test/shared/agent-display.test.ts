import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/kernel/types.ts";
import {
	deriveActiveAgentWork,
	formatActiveAgentWork,
	formatAgentDisplayName,
} from "../../src/shared/agent-display.ts";

function event(
	kind: SessionEvent["kind"],
	data: Record<string, unknown>,
	overrides: Partial<SessionEvent> = {},
): SessionEvent {
	return {
		kind,
		timestamp: overrides.timestamp ?? Date.now(),
		agent_id: overrides.agent_id ?? "root",
		depth: overrides.depth ?? 0,
		data,
	};
}

describe("formatAgentDisplayName", () => {
	test("uses mnemonic as the primary name and role as secondary text", () => {
		expect(formatAgentDisplayName({ agentName: "architect", mnemonicName: "Brunelleschi" })).toBe(
			"Brunelleschi · architect",
		);
	});

	test("falls back to agent name when there is no mnemonic", () => {
		expect(formatAgentDisplayName({ agentName: "architect" })).toBe("architect");
	});

	test("uses target agent name for agent-command events", () => {
		expect(
			formatAgentDisplayName({
				agentName: "message_agent",
				targetAgentName: "architect",
				mnemonicName: "Brunelleschi",
			}),
		).toBe("Brunelleschi · architect");
	});
});

describe("deriveActiveAgentWork", () => {
	test("reports an in-flight delegation by mnemonic and role", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit" }, { timestamp: 1 }),
				event(
					"act_start",
					{
						agent_name: "architect",
						goal: "audit design",
						description: "Audit design",
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 2 },
				),
			],
			"running",
		);

		expect(work).toEqual({
			kind: "agent",
			agent: {
				agentName: "architect",
				mnemonicName: "Brunelleschi",
				childId: "C1",
				handleId: "H1",
			},
		});
		expect(work ? formatActiveAgentWork(work) : null).toBe("Waiting on Brunelleschi · architect");
	});

	test("reports a shared child that starts a later session after its original delegation ended", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit" }, { timestamp: 1 }),
				event(
					"act_start",
					{
						agent_name: "architect",
						goal: "audit design",
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 2 },
				),
				event(
					"act_end",
					{
						agent_name: "architect",
						success: true,
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 3 },
				),
				event("session_start", { goal: "follow up" }, { timestamp: 4, agent_id: "C1", depth: 1 }),
			],
			"running",
		);

		expect(work ? formatActiveAgentWork(work) : null).toBe("Waiting on Brunelleschi · architect");
	});

	test("ignores stale root terminal events from a previous session", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "old task", session_id: "old-session" }, { timestamp: 1 }),
				event("session_clear", { new_session_id: "new-session" }, { timestamp: 2 }),
				event("session_start", { goal: "new task", session_id: "new-session" }, { timestamp: 3 }),
				event(
					"act_start",
					{
						agent_name: "architect",
						goal: "new task",
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 4 },
				),
				event(
					"session_end",
					{ turns: 1, stumbles: 0, session_id: "old-session" },
					{ timestamp: 5 },
				),
			],
			"running",
			"new-session",
		);

		expect(work ? formatActiveAgentWork(work) : null).toBe("Waiting on Brunelleschi · architect");
	});

	test("reports a pending blocking message_agent command before the child emits session_start", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit" }, { timestamp: 1 }),
				event(
					"act_start",
					{
						agent_name: "architect",
						goal: "audit design",
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 2 },
				),
				event(
					"act_end",
					{
						agent_name: "architect",
						success: true,
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 3 },
				),
				event(
					"plan_end",
					{
						assistant_message: {
							role: "assistant",
							content: [
								{
									kind: "tool_call",
									tool_call: {
										id: "call-1",
										name: "message_agent",
										arguments: { handle: "H1", message: "continue", blocking: true },
									},
								},
							],
						},
					},
					{ timestamp: 4 },
				),
			],
			"running",
		);

		expect(work ? formatActiveAgentWork(work) : null).toBe("Waiting on Brunelleschi · architect");
	});

	test("clears a pending agent command when its act_end arrives", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit" }, { timestamp: 1 }),
				event(
					"act_start",
					{
						agent_name: "architect",
						goal: "audit design",
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 2 },
				),
				event(
					"act_end",
					{
						agent_name: "architect",
						success: true,
						handle_id: "H1",
						child_id: "C1",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 3 },
				),
				event(
					"plan_end",
					{
						assistant_message: {
							role: "assistant",
							content: [
								{
									kind: "tool_call",
									tool_call: {
										id: "call-1",
										name: "message_agent",
										arguments: { handle: "H1", message: "continue" },
									},
								},
							],
						},
					},
					{ timestamp: 4 },
				),
				event(
					"act_end",
					{
						agent_name: "message_agent",
						success: true,
						child_id: "C1",
						target_agent_name: "architect",
						mnemonic_name: "Brunelleschi",
					},
					{ timestamp: 5 },
				),
			],
			"running",
		);

		expect(work).toBeNull();
	});

	test("clears a pending agent command when failure act_end has only the tool call id", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit" }, { timestamp: 1 }),
				event(
					"plan_end",
					{
						assistant_message: {
							role: "assistant",
							content: [
								{
									kind: "tool_call",
									tool_call: {
										id: "call-unknown",
										name: "message_agent",
										arguments: { handle: "missing", message: "continue" },
									},
								},
							],
						},
					},
					{ timestamp: 2 },
				),
				event(
					"act_end",
					{
						agent_name: "message_agent",
						success: false,
						tool_result_message: {
							role: "tool",
							tool_call_id: "call-unknown",
							content: [
								{
									kind: "tool_result",
									tool_result: {
										tool_call_id: "call-unknown",
										content: "unknown handle",
										is_error: true,
									},
								},
							],
						},
					},
					{ timestamp: 3 },
				),
			],
			"running",
		);

		expect(work).toBeNull();
	});

	test("reports memory saving after explicit memory collapse start", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit" }, { timestamp: 1 }),
				event("session_end", { turns: 1, stumbles: 0 }, { timestamp: 2 }),
				event("context_update", { memory_collapse: "started" }, { timestamp: 3 }),
			],
			"running",
		);

		expect(work ? formatActiveAgentWork(work) : null).toBe("Saving memory");
	});

	test("does not report memory saving from session_end without explicit memory collapse start", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit" }, { timestamp: 1 }),
				event("session_end", { turns: 1, stumbles: 0 }, { timestamp: 2 }),
			],
			"running",
		);

		expect(work).toBeNull();
	});

	test("clears memory saving when memory collapse reaches a terminal state", () => {
		for (const memory_collapse of ["completed", "skipped", "failed"]) {
			const work = deriveActiveAgentWork(
				[
					event("session_start", { goal: "audit" }, { timestamp: 1 }),
					event("session_end", { turns: 1, stumbles: 0 }, { timestamp: 2 }),
					event("context_update", { memory_collapse: "started" }, { timestamp: 3 }),
					event("context_update", { memory_collapse }, { timestamp: 4 }),
				],
				"running",
			);

			expect(work).toBeNull();
		}
	});

	test("ignores stale memory collapse terminal events from a previous session", () => {
		const work = deriveActiveAgentWork(
			[
				event("session_start", { goal: "audit", session_id: "old-session" }, { timestamp: 1 }),
				event(
					"session_end",
					{ turns: 1, stumbles: 0, session_id: "old-session" },
					{ timestamp: 2 },
				),
				event(
					"context_update",
					{ memory_collapse: "started", session_id: "old-session" },
					{ timestamp: 3 },
				),
				event("session_clear", { new_session_id: "new-session" }, { timestamp: 4 }),
				event("session_start", { goal: "follow up", session_id: "new-session" }, { timestamp: 5 }),
				event(
					"context_update",
					{ memory_collapse: "started", session_id: "new-session" },
					{ timestamp: 6 },
				),
				event(
					"context_update",
					{ memory_collapse: "completed", session_id: "old-session" },
					{ timestamp: 7 },
				),
			],
			"running",
		);

		expect(work ? formatActiveAgentWork(work) : null).toBe("Saving memory");
	});

	test("ignores stale memory collapse start when the current session id comes from outside retained events", () => {
		const work = deriveActiveAgentWork(
			[
				event(
					"context_update",
					{ memory_collapse: "started", session_id: "old-session" },
					{ timestamp: 1 },
				),
			],
			"running",
			"new-session",
		);

		expect(work).toBeNull();
	});
});
