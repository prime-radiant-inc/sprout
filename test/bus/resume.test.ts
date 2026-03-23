import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkHandleCompleted,
	extractChildHandles,
	loadCompletedChildHandles,
	readHandleResult,
	replayHandleLog,
} from "../../src/bus/resume.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
import { Msg, messageText } from "../../src/llm/types.ts";

/** Helper: write an array of SessionEvents as JSONL */
async function writeEventLog(path: string, events: SessionEvent[]): Promise<void> {
	const lines = events.map((e) => JSON.stringify(e)).join("\n");
	await writeFile(path, `${lines}\n`, "utf-8");
}

/** Helper: build a SessionEvent with defaults */
function event(kind: SessionEvent["kind"], data: Record<string, unknown>, depth = 1): SessionEvent {
	return {
		kind,
		timestamp: Date.now(),
		agent_id: "code-editor",
		depth,
		data,
	};
}

describe("replayHandleLog", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-handle-resume-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("reconstructs history from events at the agent's depth", async () => {
		const logPath = join(tempDir, "handle.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Edit the file" }),
			event("plan_end", { assistant_message: Msg.assistant("I'll edit that file.") }),
			event("primitive_end", { tool_result_message: Msg.toolResult("c1", "file edited") }),
		]);

		const history = await replayHandleLog(logPath);

		expect(history).toHaveLength(3);
		expect(history[0]!.role).toBe("user");
		expect(messageText(history[0]!)).toBe("Edit the file");
		expect(history[1]!.role).toBe("assistant");
		expect(messageText(history[1]!)).toBe("I'll edit that file.");
		expect(history[2]!.role).toBe("tool");
		expect(history[2]!.tool_call_id).toBe("c1");
	});

	test("returns empty array for nonexistent file", async () => {
		const history = await replayHandleLog(join(tempDir, "nope.jsonl"));

		expect(history).toEqual([]);
	});

	test("returns empty array for empty file", async () => {
		const logPath = join(tempDir, "empty.jsonl");
		await writeFile(logPath, "", "utf-8");

		const history = await replayHandleLog(logPath);

		expect(history).toEqual([]);
	});

	test("handles compaction by resetting history to summary", async () => {
		const logPath = join(tempDir, "compacted.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "First goal" }),
			event("plan_end", { assistant_message: Msg.assistant("Working...") }),
			event("primitive_end", { tool_result_message: Msg.toolResult("c1", "ok") }),
			event("compaction", { summary: "Summary: edited a file successfully." }),
			event("plan_end", { assistant_message: Msg.assistant("Continuing after compaction.") }),
		]);

		const history = await replayHandleLog(logPath);

		expect(history).toHaveLength(2);
		expect(history[0]!.role).toBe("user");
		expect(messageText(history[0]!)).toBe("Summary: edited a file successfully.");
		expect(history[1]!.role).toBe("assistant");
		expect(messageText(history[1]!)).toBe("Continuing after compaction.");
	});

	test("ignores events at different depths", async () => {
		const logPath = join(tempDir, "mixed-depths.jsonl");
		// Agent is at depth 1, but some stray depth-2 events appear
		await writeEventLog(logPath, [
			event("perceive", { goal: "Agent goal" }, 1),
			event("perceive", { goal: "Subagent goal" }, 2),
			event("plan_end", { assistant_message: Msg.assistant("Subagent reply") }, 2),
			event("plan_end", { assistant_message: Msg.assistant("Agent reply") }, 1),
		]);

		const history = await replayHandleLog(logPath);

		expect(history).toHaveLength(2);
		expect(messageText(history[0]!)).toBe("Agent goal");
		expect(messageText(history[1]!)).toBe("Agent reply");
	});

	test("handles malformed JSONL lines gracefully", async () => {
		const logPath = join(tempDir, "malformed.jsonl");
		const valid1 = JSON.stringify(event("perceive", { goal: "A goal" }));
		const corrupt = "{totally broken json!!!";
		const valid2 = JSON.stringify(event("plan_end", { assistant_message: Msg.assistant("Reply") }));
		await writeFile(logPath, `${[valid1, corrupt, valid2].join("\n")}\n`, "utf-8");

		const history = await replayHandleLog(logPath);

		expect(history).toHaveLength(2);
		expect(messageText(history[0]!)).toBe("A goal");
		expect(messageText(history[1]!)).toBe("Reply");
	});

	test("handles steering events as user messages", async () => {
		const logPath = join(tempDir, "steered.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Do something" }),
			event("plan_end", { assistant_message: Msg.assistant("Starting.") }),
			event("steering", { text: "Change direction." }),
		]);

		const history = await replayHandleLog(logPath);

		expect(history).toHaveLength(3);
		expect(history[2]!.role).toBe("user");
		expect(messageText(history[2]!)).toBe("Change direction.");
	});

	test("handles act_end events as tool results", async () => {
		const logPath = join(tempDir, "delegated.jsonl");
		const toolResultMsg = Msg.toolResult("call-5", "subagent done", false);
		await writeEventLog(logPath, [
			event("perceive", { goal: "Delegate work" }),
			event("plan_end", { assistant_message: Msg.assistant("Delegating.") }),
			event("act_end", { tool_result_message: toolResultMsg }),
		]);

		const history = await replayHandleLog(logPath);

		expect(history).toHaveLength(3);
		expect(history[2]!.role).toBe("tool");
		expect(history[2]!.tool_call_id).toBe("call-5");
	});

	test("uses first event's depth as the filter depth", async () => {
		// Agent at depth 0 — should still work (not hardcoded to non-zero)
		const logPath = join(tempDir, "depth-zero.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Root goal" }, 0),
			event("perceive", { goal: "Sub goal" }, 1),
			event("plan_end", { assistant_message: Msg.assistant("Root reply") }, 0),
		]);

		const history = await replayHandleLog(logPath);

		expect(history).toHaveLength(2);
		expect(messageText(history[0]!)).toBe("Root goal");
		expect(messageText(history[1]!)).toBe("Root reply");
	});
});

describe("extractChildHandles", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-extract-handles-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns empty array for log with no delegations", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Do something" }, 0),
			event("plan_end", { assistant_message: Msg.assistant("On it.") }, 0),
			event("primitive_end", { tool_result_message: Msg.toolResult("c1", "done") }, 0),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toEqual([]);
	});

	test("extracts completed blocking delegation with handle_id", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Delegate work" }, 0),
			event("plan_end", { assistant_message: Msg.assistant("Delegating.") }, 0),
			event(
				"act_end",
				{
					agent_name: "code-editor",
					success: true,
					handle_id: "handle-abc",
					turns: 5,
					timed_out: false,
					tool_result_message: Msg.toolResult("c1", "Agent completed the work"),
				},
				0,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toHaveLength(1);
		expect(handles[0]).toEqual({
			handleId: "handle-abc",
			agentName: "code-editor",
			agentId: undefined,
			completed: true,
		});
	});

	test("extracts completed child handles from a resumed non-root agent log", async () => {
		const logPath = join(tempDir, "handle.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Coordinator follow-up" }, 2),
			event(
				"act_start",
				{
					agent_name: "engineer",
					handle_id: "handle-nested",
					child_id: "child-nested",
				},
				2,
			),
			event(
				"act_end",
				{
					agent_name: "engineer",
					success: true,
					handle_id: "handle-nested",
					child_id: "child-nested",
					turns: 4,
					timed_out: false,
					tool_result_message: Msg.toolResult("c1", "completed"),
				},
				2,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toEqual([
			{
				handleId: "handle-nested",
				agentName: "engineer",
				agentId: "child-nested",
				completed: true,
			},
		]);
	});

	test("extracts non-blocking delegation handle as not completed", async () => {
		const logPath = join(tempDir, "session.jsonl");
		// Non-blocking: act_end has handle_id but no turns/timed_out
		await writeEventLog(logPath, [
			event("perceive", { goal: "Spawn background agent" }, 0),
			event("plan_end", { assistant_message: Msg.assistant("Spawning.") }, 0),
			event(
				"act_end",
				{
					agent_name: "code-editor",
					success: true,
					handle_id: "handle-xyz",
					tool_result_message: Msg.toolResult("c1", "Agent started. Handle: handle-xyz"),
				},
				0,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toHaveLength(1);
		expect(handles[0]!.handleId).toBe("handle-xyz");
		expect(handles[0]!.agentName).toBe("code-editor");
		expect(handles[0]!.completed).toBe(false);
	});

	test("ignores act_end events without handle_id", async () => {
		const logPath = join(tempDir, "session.jsonl");
		// In-process delegation: act_end has no handle_id
		await writeEventLog(logPath, [
			event("perceive", { goal: "In-process delegation" }, 0),
			event(
				"act_end",
				{
					agent_name: "code-reader",
					success: true,
					tool_result_message: Msg.toolResult("c1", "done"),
				},
				0,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toEqual([]);
	});

	test("ignores act_end events at non-zero depth", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Root" }, 0),
			// This is a sub-agent's act_end, not the root's
			event(
				"act_end",
				{
					agent_name: "helper",
					success: true,
					handle_id: "handle-sub",
					tool_result_message: Msg.toolResult("c2", "sub done"),
				},
				1,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toEqual([]);
	});

	test("extracts multiple handles from same log", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Multi-delegation" }, 0),
			event(
				"act_end",
				{
					agent_name: "code-editor",
					success: true,
					handle_id: "handle-1",
					turns: 3,
					tool_result_message: Msg.toolResult("c1", "done"),
				},
				0,
			),
			event(
				"act_end",
				{
					agent_name: "code-reader",
					success: true,
					handle_id: "handle-2",
					turns: 2,
					tool_result_message: Msg.toolResult("c2", "done"),
				},
				0,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toHaveLength(2);
		expect(handles[0]!.handleId).toBe("handle-1");
		expect(handles[0]!.agentName).toBe("code-editor");
		expect(handles[1]!.handleId).toBe("handle-2");
		expect(handles[1]!.agentName).toBe("code-reader");
	});

	test("returns empty array for nonexistent log file", async () => {
		const handles = await extractChildHandles(join(tempDir, "nope.jsonl"));

		expect(handles).toEqual([]);
	});

	test("extracts handles from act_start when no act_end exists (in-flight delegation)", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Delegate work" }, 0),
			event(
				"act_start",
				{
					agent_name: "code-editor",
					goal: "edit something",
					handle_id: "handle-inflight",
				},
				0,
			),
			// No act_end — agent died mid-delegation
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toHaveLength(1);
		expect(handles[0]).toEqual({
			handleId: "handle-inflight",
			agentName: "code-editor",
			completed: false,
		});
	});

	test("act_end updates completion status of handle found in act_start", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event(
				"act_start",
				{
					agent_name: "code-editor",
					goal: "edit something",
					handle_id: "handle-full",
				},
				0,
			),
			event(
				"act_end",
				{
					agent_name: "code-editor",
					success: true,
					handle_id: "handle-full",
					turns: 3,
					tool_result_message: Msg.toolResult("c1", "done"),
				},
				0,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toHaveLength(1);
		expect(handles[0]!.handleId).toBe("handle-full");
		expect(handles[0]!.completed).toBe(true);
	});

	test("ignores act_start events without handle_id", async () => {
		const logPath = join(tempDir, "session.jsonl");
		// In-process delegation: act_start has no handle_id
		await writeEventLog(logPath, [
			event(
				"act_start",
				{
					agent_name: "code-reader",
					goal: "read something",
				},
				0,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toEqual([]);
	});

	test("extracts act_start events at the resumed agent depth", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event(
				"act_start",
				{
					agent_name: "helper",
					goal: "sub task",
					handle_id: "handle-sub",
					child_id: "child-sub",
				},
				1,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toEqual([
			{
				handleId: "handle-sub",
				agentName: "helper",
				agentId: "child-sub",
				completed: false,
			},
		]);
	});

	test("marks blocking delegation as completed when turns field is present", async () => {
		const logPath = join(tempDir, "session.jsonl");
		await writeEventLog(logPath, [
			event(
				"act_end",
				{
					agent_name: "code-editor",
					success: true,
					handle_id: "handle-blocking",
					turns: 4,
					timed_out: false,
					tool_result_message: Msg.toolResult("c1", "Task completed successfully"),
				},
				0,
			),
		]);

		const handles = await extractChildHandles(logPath);

		expect(handles).toHaveLength(1);
		expect(handles[0]!.completed).toBe(true);
	});
});

describe("loadCompletedChildHandles", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-completed-handles-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("loads completed handle results with agent metadata for resume", async () => {
		const logPath = join(tempDir, "handle.jsonl");
		const handleLogDir = join(tempDir, "children");
		await mkdir(handleLogDir, { recursive: true });

		await writeEventLog(logPath, [
			event("perceive", { goal: "Resume coordinator" }, 1),
			event(
				"act_start",
				{
					agent_name: "engineer",
					handle_id: "handle-resume",
					child_id: "child-resume",
				},
				1,
			),
			event(
				"act_end",
				{
					agent_name: "engineer",
					success: true,
					handle_id: "handle-resume",
					child_id: "child-resume",
					turns: 3,
					timed_out: false,
					tool_result_message: Msg.toolResult("c1", "done"),
				},
				1,
			),
		]);

		await writeEventLog(join(handleLogDir, "handle-resume.jsonl"), [
			event("session_start", {}, 2),
			event(
				"session_end",
				{
					output: "done",
					success: true,
					stumbles: 0,
					turns: 3,
					timed_out: false,
				},
				2,
			),
		]);

		const handles = await loadCompletedChildHandles({
			logPath,
			handleLogDir,
			ownerId: "tech-lead",
		});

		expect(handles).toEqual([
			{
				handleId: "handle-resume",
				ownerId: "tech-lead",
				agentName: "engineer",
				agentId: "child-resume",
				result: {
					kind: "result",
					handle_id: "handle-resume",
					output: "done",
					success: true,
					stumbles: 0,
					turns: 3,
					timed_out: false,
				},
			},
		]);
	});
});

describe("checkHandleCompleted", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-check-handle-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns true when handle log contains session_end event", async () => {
		const handleLogDir = join(tempDir, "logs", "session-1");
		await mkdir(handleLogDir, { recursive: true });

		const handleId = "handle-abc";
		const logPath = join(handleLogDir, `${handleId}.jsonl`);
		await writeEventLog(logPath, [
			event("perceive", { goal: "work" }),
			event("plan_end", { assistant_message: Msg.assistant("working") }),
			event("session_end", { output: "done", success: true, turns: 3 }),
		]);

		const completed = await checkHandleCompleted(handleLogDir, handleId);

		expect(completed).toBe(true);
	});

	test("returns false when handle log has no session_end event", async () => {
		const handleLogDir = join(tempDir, "logs", "session-1");
		await mkdir(handleLogDir, { recursive: true });

		const handleId = "handle-abc";
		const logPath = join(handleLogDir, `${handleId}.jsonl`);
		await writeEventLog(logPath, [
			event("perceive", { goal: "work" }),
			event("plan_end", { assistant_message: Msg.assistant("working") }),
		]);

		const completed = await checkHandleCompleted(handleLogDir, handleId);

		expect(completed).toBe(false);
	});

	test("returns false when handle log file does not exist", async () => {
		const handleLogDir = join(tempDir, "logs", "session-1");
		await mkdir(handleLogDir, { recursive: true });

		const completed = await checkHandleCompleted(handleLogDir, "nonexistent-handle");

		expect(completed).toBe(false);
	});
});

describe("readHandleResult", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-read-handle-result-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("extracts ResultMessage from per-handle log with session_end", async () => {
		const handleLogDir = join(tempDir, "logs", "session-1");
		await mkdir(handleLogDir, { recursive: true });

		const handleId = "handle-abc";
		const logPath = join(handleLogDir, `${handleId}.jsonl`);
		await writeEventLog(logPath, [
			event("perceive", { goal: "work" }),
			event("plan_end", { assistant_message: Msg.assistant("working") }),
			event("session_end", {
				output: "Completed the task successfully",
				success: true,
				stumbles: 1,
				turns: 4,
				timed_out: false,
			}),
		]);

		const result = await readHandleResult(handleLogDir, handleId);

		expect(result).not.toBeNull();
		expect(result!.kind).toBe("result");
		expect(result!.handle_id).toBe(handleId);
		expect(result!.output).toBe("Completed the task successfully");
		expect(result!.success).toBe(true);
		expect(result!.stumbles).toBe(1);
		expect(result!.turns).toBe(4);
		expect(result!.timed_out).toBe(false);
	});

	test("returns null when log has no session_end event", async () => {
		const handleLogDir = join(tempDir, "logs", "session-1");
		await mkdir(handleLogDir, { recursive: true });

		const handleId = "handle-abc";
		const logPath = join(handleLogDir, `${handleId}.jsonl`);
		await writeEventLog(logPath, [
			event("perceive", { goal: "work" }),
			event("plan_end", { assistant_message: Msg.assistant("working") }),
		]);

		const result = await readHandleResult(handleLogDir, handleId);

		expect(result).toBeNull();
	});

	test("returns null when log file does not exist", async () => {
		const handleLogDir = join(tempDir, "logs", "session-1");
		await mkdir(handleLogDir, { recursive: true });

		const result = await readHandleResult(handleLogDir, "nonexistent-handle");

		expect(result).toBeNull();
	});

	test("defaults output to empty string when session_end has no output field", async () => {
		const handleLogDir = join(tempDir, "logs", "session-1");
		await mkdir(handleLogDir, { recursive: true });

		const handleId = "handle-no-output";
		const logPath = join(handleLogDir, `${handleId}.jsonl`);
		await writeEventLog(logPath, [
			event("session_end", {
				success: false,
				stumbles: 2,
				turns: 5,
				timed_out: true,
			}),
		]);

		const result = await readHandleResult(handleLogDir, handleId);

		expect(result).not.toBeNull();
		expect(result!.output).toBe("");
		expect(result!.success).toBe(false);
		expect(result!.timed_out).toBe(true);
	});
});
