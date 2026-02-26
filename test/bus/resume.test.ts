import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayHandleLog } from "../../src/bus/resume.ts";
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
