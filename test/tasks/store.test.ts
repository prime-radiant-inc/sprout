import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../root/agents/utility/agents/task-manager/tools/store.ts";
import { createEmptyTaskFile } from "../../root/agents/utility/agents/task-manager/tools/types.ts";

describe("TaskStore", () => {
	let tmpDir: string;
	let store: TaskStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "sprout-tasks-"));
		store = new TaskStore(join(tmpDir, "tasks.json"));
	});

	test("createEmptyTaskFile returns correct structure", () => {
		const empty = createEmptyTaskFile();
		expect(empty.tasks).toEqual([]);
		expect(empty.next_id).toBe(1);
	});

	test("load returns empty task file when file does not exist", async () => {
		const data = await store.load();
		expect(data.tasks).toEqual([]);
		expect(data.next_id).toBe(1);
	});

	test("create persists a task to disk", async () => {
		const task = await store.create("Build the widget");
		expect(task.id).toBe("task-001");
		expect(task.description).toBe("Build the widget");
		expect(task.initial_prompt).toBe("");
		expect(task.status).toBe("new");
		expect(task.assigned_to).toBeNull();
		expect(task.notes).toEqual([]);

		// Verify it persisted
		const raw = await readFile(join(tmpDir, "tasks.json"), "utf-8");
		const data = JSON.parse(raw);
		expect(data.tasks).toHaveLength(1);
		expect(data.tasks[0].id).toBe("task-001");
		expect(data.next_id).toBe(2);
	});

	test("create with all optional fields", async () => {
		const task = await store.create("Build it", "Full spec here", "engineer");
		expect(task.initial_prompt).toBe("Full spec here");
		expect(task.assigned_to).toBe("engineer");
	});

	test("create auto-increments IDs", async () => {
		const t1 = await store.create("First");
		const t2 = await store.create("Second");
		const t3 = await store.create("Third");
		expect(t1.id).toBe("task-001");
		expect(t2.id).toBe("task-002");
		expect(t3.id).toBe("task-003");
	});

	test("list returns all tasks", async () => {
		await store.create("Task A");
		await store.create("Task B");
		const all = await store.list();
		expect(all).toHaveLength(2);
	});

	test("list filters by status", async () => {
		await store.create("Task A");
		await store.create("Task B");
		await store.update("task-002", { status: "in_progress" });

		const newTasks = await store.list("new");
		expect(newTasks).toHaveLength(1);
		expect(newTasks[0]!.id).toBe("task-001");

		const inProgress = await store.list("in_progress");
		expect(inProgress).toHaveLength(1);
		expect(inProgress[0]!.id).toBe("task-002");
	});

	test("get returns a specific task", async () => {
		await store.create("Task A");
		await store.create("Task B");
		const task = await store.get("task-002");
		expect(task.description).toBe("Task B");
	});

	test("get throws for nonexistent task", async () => {
		expect(store.get("task-999")).rejects.toThrow("Task not found: task-999");
	});

	test("update changes status", async () => {
		await store.create("Task A");
		const updated = await store.update("task-001", { status: "done" });
		expect(updated.status).toBe("done");

		// Verify persisted
		const reloaded = await store.get("task-001");
		expect(reloaded.status).toBe("done");
	});

	test("update changes assigned_to", async () => {
		await store.create("Task A");
		const updated = await store.update("task-001", { assigned_to: "debugger" });
		expect(updated.assigned_to).toBe("debugger");
	});

	test("update changes description", async () => {
		await store.create("Task A");
		const updated = await store.update("task-001", { description: "Task A revised" });
		expect(updated.description).toBe("Task A revised");
	});

	test("update throws for nonexistent task", async () => {
		expect(store.update("task-999", { status: "done" })).rejects.toThrow(
			"Task not found: task-999",
		);
	});

	test("comment appends a timestamped note", async () => {
		await store.create("Task A");
		const before = Date.now();
		const task = await store.comment("task-001", "Looking good");
		const after = Date.now();

		expect(task.notes).toHaveLength(1);
		expect(task.notes[0]!.text).toBe("Looking good");
		expect(task.notes[0]!.timestamp).toBeGreaterThanOrEqual(before);
		expect(task.notes[0]!.timestamp).toBeLessThanOrEqual(after);

		// Verify persisted
		const reloaded = await store.get("task-001");
		expect(reloaded.notes).toHaveLength(1);
	});

	test("comment throws for nonexistent task", async () => {
		expect(store.comment("task-999", "Nope")).rejects.toThrow("Task not found: task-999");
	});
});
