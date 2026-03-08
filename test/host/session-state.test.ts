import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyHistoryShadowUpdate,
	beginSubmitGoalTransition,
	clearSessionShadowState,
	loadAllEventLogs,
} from "../../src/host/session-state.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
import { Msg } from "../../src/llm/types.ts";

function makeEvent(
	kind: SessionEvent["kind"],
	data: Record<string, unknown>,
	depth = 0,
): SessionEvent {
	return {
		kind,
		timestamp: Date.now(),
		agent_id: "root",
		depth,
		data,
	};
}

describe("applyHistoryShadowUpdate", () => {
	test("appends goal user message on perceive at depth 0", () => {
		const next = applyHistoryShadowUpdate([], makeEvent("perceive", { goal: "build feature" }));
		expect(next).toEqual([Msg.user("build feature")]);
	});

	test("appends assistant message on plan_end", () => {
		const assistant = Msg.assistant("Done.");
		const next = applyHistoryShadowUpdate(
			[],
			makeEvent("plan_end", { assistant_message: assistant }),
		);
		expect(next).toEqual([assistant]);
	});

	test("replaces history with compaction summary user message", () => {
		const prior = [Msg.user("first"), Msg.assistant("second")];
		const next = applyHistoryShadowUpdate(
			prior,
			makeEvent("compaction", { summary: "compressed" }),
		);
		expect(next).toEqual([Msg.user("compressed")]);
	});

	test("ignores non-root-depth events", () => {
		const prior = [Msg.user("keep")];
		const next = applyHistoryShadowUpdate(
			prior,
			makeEvent("perceive", { goal: "ignored at depth 1" }, 1),
		);
		expect(next).toBe(prior);
	});
});

describe("beginSubmitGoalTransition", () => {
	test("emits resume on first run when history exists", () => {
		const next = beginSubmitGoalTransition({ hasRun: false, historyLength: 2 });
		expect(next.shouldEmitResume).toBe(true);
		expect(next.hasRun).toBe(true);
	});

	test("does not emit resume when history is empty or already ran", () => {
		expect(beginSubmitGoalTransition({ hasRun: false, historyLength: 0 }).shouldEmitResume).toBe(
			false,
		);
		expect(beginSubmitGoalTransition({ hasRun: true, historyLength: 2 }).shouldEmitResume).toBe(
			false,
		);
	});
});

describe("clearSessionShadowState", () => {
	test("resets history and run state and updates session id", () => {
		const next = clearSessionShadowState("next-session-id");
		expect(next).toEqual({
			sessionId: "next-session-id",
			history: [],
			hasRun: false,
			suppressEvents: true,
		});
	});
});

describe("loadAllEventLogs", () => {
	function eventLine(kind: string, timestamp: number): string {
		return JSON.stringify({
			kind,
			timestamp,
			agent_id: "test",
			depth: 0,
			data: {},
		});
	}

	test("loads root events only when no session directory exists", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "sprout-test-"));
		const rootLog = join(tmp, "root.jsonl");
		await writeFile(
			rootLog,
			[
				eventLine("plan_start", 100),
				eventLine("plan_start", 200),
				eventLine("plan_start", 300),
			].join("\n"),
		);
		const events = await loadAllEventLogs(rootLog, join(tmp, "nonexistent"));
		expect(events).toHaveLength(3);
	});

	test("loads root + child events merged and sorted", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "sprout-test-"));
		const rootLog = join(tmp, "root.jsonl");
		const sessionDir = join(tmp, "session");
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			rootLog,
			[
				eventLine("plan_start", 100),
				eventLine("plan_start", 300),
				eventLine("plan_start", 500),
			].join("\n"),
		);
		await writeFile(
			join(sessionDir, "child1.jsonl"),
			[eventLine("plan_start", 200), eventLine("plan_start", 400)].join("\n"),
		);
		const events = await loadAllEventLogs(rootLog, sessionDir);
		expect(events).toHaveLength(5);
		expect(events.map((e) => e.timestamp)).toEqual([100, 200, 300, 400, 500]);
	});

	test("recursively loads nested subagent logs", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "sprout-test-"));
		const rootLog = join(tmp, "root.jsonl");
		const sessionDir = join(tmp, "session");
		const subagentsDir = join(sessionDir, "subagents");
		await mkdir(subagentsDir, { recursive: true });
		await writeFile(rootLog, eventLine("plan_start", 100));
		await writeFile(join(sessionDir, "child1.jsonl"), eventLine("plan_start", 200));
		await writeFile(join(subagentsDir, "grandchild.jsonl"), eventLine("plan_start", 300));
		const events = await loadAllEventLogs(rootLog, sessionDir);
		expect(events).toHaveLength(3);
	});
});
