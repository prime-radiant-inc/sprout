import { describe, expect, test } from "bun:test";
import { replayMessagesFromEvents } from "../../src/kernel/event-replay.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
import { ContentKind, type Message, Msg, messageText } from "../../src/llm/types.ts";

/** Helper: build a SessionEvent with defaults */
function event(kind: SessionEvent["kind"], data: Record<string, unknown>, depth = 0): SessionEvent {
	return { kind, timestamp: Date.now(), agent_id: "agent-1", depth, data };
}

/** Helper: an assistant message carrying tool_use blocks */
function assistantWithCalls(
	text: string,
	calls: { id: string; name: string; args?: Record<string, unknown> }[],
): Message {
	return {
		role: "assistant",
		content: [
			{ kind: ContentKind.TEXT, text },
			...calls.map((c) => ({
				kind: ContentKind.TOOL_CALL,
				tool_call: { id: c.id, name: c.name, arguments: c.args ?? {} },
			})),
		],
	};
}

/** Every tool_use id in history must have exactly one matching tool result. */
function assertProviderValid(history: Message[]): void {
	const callIds: string[] = [];
	const resultIds: string[] = [];
	for (const msg of history) {
		for (const part of msg.content) {
			if (part.kind === ContentKind.TOOL_CALL && part.tool_call) callIds.push(part.tool_call.id);
			if (part.kind === ContentKind.TOOL_RESULT && part.tool_result)
				resultIds.push(part.tool_result.tool_call_id);
		}
	}
	expect(resultIds.toSorted()).toEqual(callIds.toSorted());
}

function lastMessage(history: Message[]): Message {
	const msg = history[history.length - 1];
	expect(msg).toBeDefined();
	return msg!;
}

function toolResultFor(history: Message[], callId: string): { content: string; isError: boolean } {
	const matches = history.flatMap((msg) =>
		msg.content.filter(
			(p) => p.kind === ContentKind.TOOL_RESULT && p.tool_result?.tool_call_id === callId,
		),
	);
	expect(matches).toHaveLength(1);
	const tr = matches[0]!.tool_result!;
	return { content: String(tr.content), isError: tr.is_error };
}

describe("cell-spawn act-event replay exclusion", () => {
	test("skips cell_spawn act_end events but keeps the cell primitive_end", () => {
		const history = replayMessagesFromEvents(
			[
				event("perceive", { goal: "Fan out work" }),
				event("plan_end", {
					assistant_message: assistantWithCalls("Running a cell.", [{ id: "c1", name: "cell" }]),
				}),
				// Cell-spawn act_end: no matching tool_use exists in the transcript.
				// Replaying its tool_result would orphan it — must be skipped.
				event("act_end", {
					cell_spawn: true,
					handle_id: "h-child-1",
					tool_result_message: Msg.toolResult("bogus-orphan", "child done"),
				}),
				event("primitive_end", { tool_result_message: Msg.toolResult("c1", "cell completed") }),
			],
			"root",
		);

		expect(history).toHaveLength(3);
		expect(lastMessage(history).tool_call_id).toBe("c1");
		assertProviderValid(history);
	});

	test("non-cell act_end tool results still replay", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Delegating.", [{ id: "d1", name: "delegate" }]),
				}),
				event("act_end", {
					handle_id: "h-1",
					tool_result_message: Msg.toolResult("d1", "child done"),
				}),
			],
			"root",
		);

		expect(history).toHaveLength(2);
		expect(lastMessage(history).tool_call_id).toBe("d1");
		assertProviderValid(history);
	});
});

describe("dangling-call synthesis", () => {
	test("dangling cell call: lists recoverable and died_with_owner children", () => {
		const history = replayMessagesFromEvents(
			[
				event("perceive", { goal: "Fan out" }),
				event("plan_end", {
					assistant_message: assistantWithCalls("Running a cell.", [{ id: "c1", name: "cell" }]),
				}),
				// One spawn completed (act_end, result journaled), one still in flight
				event("act_start", { cell_spawn: true, handle_id: "h-done" }),
				event("act_start", { cell_spawn: true, handle_id: "h-flight" }),
				event("act_end", { cell_spawn: true, handle_id: "h-done", turns: 3 }),
				// process died here — no primitive_end for the cell
			],
			"root",
		);

		const { content, isError } = toolResultFor(history, "c1");
		expect(isError).toBe(true);
		expect(content).toContain("died while a cell was running");
		expect(content).toContain("recoverable: h-done");
		expect(content).toContain("died_with_owner: h-flight");
		assertProviderValid(history);
	});

	test("dangling delegate with act_start only closes as died_with_owner", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Delegating.", [{ id: "d1", name: "delegate" }]),
				}),
				event("act_start", { handle_id: "h-9", agent_name: "worker" }),
			],
			"root",
		);

		const { content, isError } = toolResultFor(history, "d1");
		expect(isError).toBe(true);
		expect(content).toContain("died while this delegation was running");
		expect(content).toContain("died_with_owner: h-9");
		assertProviderValid(history);
	});

	test("dangling delegate with act_end but no tool_result closes as recoverable", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Delegating.", [{ id: "d1", name: "delegate" }]),
				}),
				event("act_start", { handle_id: "h-9", agent_name: "worker" }),
				event("act_end", { handle_id: "h-9", agent_name: "worker", turns: 4 }),
			],
			"root",
		);

		const { content, isError } = toolResultFor(history, "d1");
		expect(isError).toBe(true);
		expect(content).toContain("recoverable: h-9");
		assertProviderValid(history);
	});

	test("dangling delegate with no recorded spawn gets a truthful generic error", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Delegating.", [{ id: "d1", name: "delegate" }]),
				}),
			],
			"root",
		);

		const { content, isError } = toolResultFor(history, "d1");
		expect(isError).toBe(true);
		expect(content).toContain("died while this delegation was running");
		assertProviderValid(history);
	});

	test("dangling primitive call gets a plain synthesized error", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Reading.", [{ id: "p1", name: "read_file" }]),
				}),
			],
			"root",
		);

		const { content, isError } = toolResultFor(history, "p1");
		expect(isError).toBe(true);
		expect(content).toContain("died while this call was executing");
		expect(content).toContain("re-issue if still needed");
		assertProviderValid(history);
	});

	test("completed log synthesizes nothing", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Reading.", [{ id: "p1", name: "read_file" }]),
				}),
				event("primitive_end", { tool_result_message: Msg.toolResult("p1", "file contents") }),
				event("plan_end", { assistant_message: Msg.assistant("Done.") }),
			],
			"root",
		);

		expect(history).toHaveLength(3);
		expect(messageText(lastMessage(history))).toBe("Done.");
		assertProviderValid(history);
	});

	test("multiple parallel dangling calls each get closed", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Parallel work.", [
						{ id: "d1", name: "delegate" },
						{ id: "p1", name: "read_file" },
						{ id: "c1", name: "cell" },
					]),
				}),
				event("act_start", { handle_id: "h-del", agent_name: "worker" }),
				event("act_start", { cell_spawn: true, handle_id: "h-cell-child" }),
			],
			"root",
		);

		expect(toolResultFor(history, "d1").content).toContain("died_with_owner: h-del");
		expect(toolResultFor(history, "p1").content).toContain("re-issue if still needed");
		expect(toolResultFor(history, "c1").content).toContain("died_with_owner: h-cell-child");
		assertProviderValid(history);
	});

	test("partially answered parallel calls only synthesize the unanswered ones", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Parallel.", [
						{ id: "p1", name: "read_file" },
						{ id: "p2", name: "read_file" },
					]),
				}),
				event("primitive_end", { tool_result_message: Msg.toolResult("p1", "ok") }),
			],
			"root",
		);

		expect(toolResultFor(history, "p1").content).toBe("ok");
		expect(toolResultFor(history, "p2").isError).toBe(true);
		assertProviderValid(history);
	});

	test("observer act events are ignored by the spawn scan", () => {
		const history = replayMessagesFromEvents(
			[
				event("plan_end", {
					assistant_message: assistantWithCalls("Delegating.", [{ id: "d1", name: "delegate" }]),
				}),
				event("act_start", { observer: true, handle_id: "h-observer" }),
				event("act_start", { handle_id: "h-real", agent_name: "worker" }),
			],
			"root",
		);

		const { content } = toolResultFor(history, "d1");
		expect(content).toContain("died_with_owner: h-real");
		expect(content).not.toContain("h-observer");
	});
});
