import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@kernel/types.ts";
import { buildTaskList, type Task } from "../useTaskList.ts";

// --- Helpers ---

let nextTs = 1000;

function makeEvent(
	kind: SessionEvent["kind"],
	data: Record<string, unknown> = {},
	agentId = "root",
	depth = 0,
): SessionEvent {
	return {
		kind,
		timestamp: nextTs++,
		agent_id: agentId,
		depth,
		data,
	};
}

// --- Tests ---

describe("buildTaskList", () => {
	test("returns empty array when no events", () => {
		expect(buildTaskList([])).toEqual([]);
	});

	test("returns empty array when no task_update events", () => {
		const events = [
			makeEvent("session_start", { goal: "test" }),
			makeEvent("plan_start", { turn: 1 }),
		];
		expect(buildTaskList(events)).toEqual([]);
	});

	test("returns tasks from the most recent task_update event", () => {
		const tasks1: Task[] = [{ id: "1", description: "Old", status: "new", assigned_to: null }];
		const tasks2: Task[] = [
			{ id: "1", description: "Updated", status: "in_progress", assigned_to: "agent-1" },
			{ id: "2", description: "New task", status: "new", assigned_to: null },
		];
		const events = [
			makeEvent("session_start", { goal: "test" }),
			makeEvent("task_update", { tasks: tasks1 }),
			makeEvent("plan_start", { turn: 1 }),
			makeEvent("task_update", { tasks: tasks2 }),
			makeEvent("plan_end", { text: "done" }),
		];
		expect(buildTaskList(events)).toEqual(tasks2);
	});

	test("returns tasks from single task_update event", () => {
		const tasks: Task[] = [{ id: "1", description: "Test", status: "done", assigned_to: null }];
		const events = [makeEvent("task_update", { tasks })];
		expect(buildTaskList(events)).toEqual(tasks);
	});

	test("returns empty array when task_update has non-array tasks", () => {
		const events = [makeEvent("task_update", { tasks: "not an array" })];
		expect(buildTaskList(events)).toEqual([]);
	});

	test("returns empty array when task_update has no tasks key", () => {
		const events = [makeEvent("task_update", { something_else: true })];
		expect(buildTaskList(events)).toEqual([]);
	});

	test("skips task_update with invalid data and finds earlier valid one", () => {
		const validTasks: Task[] = [{ id: "1", description: "Valid", status: "new", assigned_to: null }];
		const events = [
			makeEvent("task_update", { tasks: validTasks }),
			makeEvent("task_update", { tasks: "invalid" }),
		];
		expect(buildTaskList(events)).toEqual(validTasks);
	});
});
