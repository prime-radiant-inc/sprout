import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayEventLog } from "../../src/host/resume.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
import { Msg, messageText } from "../../src/llm/types.ts";

/** Helper: write an array of SessionEvents as JSONL */
async function writeEventLog(path: string, events: SessionEvent[]): Promise<void> {
	const lines = events.map((e) => JSON.stringify(e)).join("\n");
	await writeFile(path, lines + "\n", "utf-8");
}

/** Helper: build a SessionEvent with defaults */
function event(kind: SessionEvent["kind"], data: Record<string, unknown>, depth = 0): SessionEvent {
	return {
		kind,
		timestamp: Date.now(),
		agent_id: "root",
		depth,
		data,
	};
}

describe("replayEventLog", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-resume-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("reconstructs user message from initial goal", async () => {
		const logPath = join(tempDir, "events.jsonl");
		await writeEventLog(logPath, [event("perceive", { goal: "Write a hello world program" })]);

		const history = await replayEventLog(logPath);

		expect(history).toHaveLength(1);
		expect(history[0]!.role).toBe("user");
		expect(messageText(history[0]!)).toBe("Write a hello world program");
	});

	test("reconstructs assistant messages from plan_end events", async () => {
		const assistantMsg = Msg.assistant("I'll write that for you.");
		const logPath = join(tempDir, "events.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Write code" }),
			event("plan_end", { assistant_message: assistantMsg }),
		]);

		const history = await replayEventLog(logPath);

		expect(history).toHaveLength(2);
		expect(history[1]!.role).toBe("assistant");
		expect(messageText(history[1]!)).toBe("I'll write that for you.");
	});

	test("reconstructs tool results from primitive_end events", async () => {
		const toolResultMsg = Msg.toolResult("call-1", "file written", false);
		const logPath = join(tempDir, "events.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Write a file" }),
			event("plan_end", { assistant_message: Msg.assistant("Let me write that.") }),
			event("primitive_end", { tool_result_message: toolResultMsg }),
		]);

		const history = await replayEventLog(logPath);

		expect(history).toHaveLength(3);
		expect(history[2]!.role).toBe("tool");
		expect(history[2]!.tool_call_id).toBe("call-1");
	});

	test("reconstructs delegation results from act_end events", async () => {
		const toolResultMsg = Msg.toolResult("call-2", "subagent completed", false);
		const logPath = join(tempDir, "events.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Delegate work" }),
			event("plan_end", { assistant_message: Msg.assistant("Delegating...") }),
			event("act_end", { tool_result_message: toolResultMsg }),
		]);

		const history = await replayEventLog(logPath);

		expect(history).toHaveLength(3);
		expect(history[2]!.role).toBe("tool");
		expect(history[2]!.tool_call_id).toBe("call-2");
	});

	test("handles compaction events by replacing prior history", async () => {
		const logPath = join(tempDir, "events.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "First goal" }),
			event("plan_end", { assistant_message: Msg.assistant("Working on it.") }),
			event("primitive_end", { tool_result_message: Msg.toolResult("c1", "ok") }),
			event("compaction", { summary: "Summary of work so far: wrote some code." }),
			event("plan_end", { assistant_message: Msg.assistant("Continuing.") }),
		]);

		const history = await replayEventLog(logPath);

		// Compaction should have cleared everything before it
		expect(history).toHaveLength(2);
		expect(history[0]!.role).toBe("user");
		expect(messageText(history[0]!)).toBe("Summary of work so far: wrote some code.");
		expect(history[1]!.role).toBe("assistant");
		expect(messageText(history[1]!)).toBe("Continuing.");
	});

	test("handles steering events as user messages", async () => {
		const logPath = join(tempDir, "events.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Build a feature" }),
			event("plan_end", { assistant_message: Msg.assistant("Starting.") }),
			event("steering", { text: "Actually, use TypeScript instead." }),
		]);

		const history = await replayEventLog(logPath);

		expect(history).toHaveLength(3);
		expect(history[2]!.role).toBe("user");
		expect(messageText(history[2]!)).toBe("Actually, use TypeScript instead.");
	});

	test("returns empty history for empty log", async () => {
		const logPath = join(tempDir, "events.jsonl");
		await writeFile(logPath, "", "utf-8");

		const history = await replayEventLog(logPath);

		expect(history).toHaveLength(0);
	});

	test("skips events with depth > 0", async () => {
		const logPath = join(tempDir, "events.jsonl");
		await writeEventLog(logPath, [
			event("perceive", { goal: "Root goal" }),
			event("perceive", { goal: "Subagent goal" }, 1),
			event("plan_end", { assistant_message: Msg.assistant("Subagent reply") }, 1),
			event("primitive_end", { tool_result_message: Msg.toolResult("c1", "sub result") }, 1),
			event("plan_end", { assistant_message: Msg.assistant("Root reply") }),
		]);

		const history = await replayEventLog(logPath);

		// Only root-level events: perceive + plan_end
		expect(history).toHaveLength(2);
		expect(messageText(history[0]!)).toBe("Root goal");
		expect(messageText(history[1]!)).toBe("Root reply");
	});
});
