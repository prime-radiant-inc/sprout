import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../root/agents/utility/agents/task-manager/tools/cli.ts");

/** Environment stripped of vars that let the CLI auto-resolve a tasks file. */
const cleanEnv = (() => {
	const env = { ...process.env };
	delete env.SPROUT_PROJECT_DATA_DIR;
	delete env.SPROUT_GENOME_PATH;
	delete env.SPROUT_SESSION_ID;
	return env;
})();

async function run(
	...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: cleanEnv,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("task CLI", () => {
	let tmpDir: string;
	let tasksFile: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "sprout-tasks-cli-"));
		tasksFile = join(tmpDir, "tasks.json");
	});

	test("errors without --tasks-file", async () => {
		const result = await run("create", "--description", "test");
		expect(result.exitCode).not.toBe(0);
		const err = JSON.parse(result.stderr);
		expect(err.error).toContain("--tasks-file");
	});

	test("errors without a command", async () => {
		const result = await run("--tasks-file", tasksFile);
		expect(result.exitCode).not.toBe(0);
		const err = JSON.parse(result.stderr);
		expect(err.error).toContain("No command");
	});

	test("errors on unknown command", async () => {
		const result = await run("--tasks-file", tasksFile, "explode");
		expect(result.exitCode).not.toBe(0);
		const err = JSON.parse(result.stderr);
		expect(err.error).toContain("Unknown command");
	});

	test("create outputs the new task as JSON", async () => {
		const result = await run("--tasks-file", tasksFile, "create", "--description", "Build widget");
		expect(result.exitCode).toBe(0);
		const task = JSON.parse(result.stdout);
		expect(task.id).toBe("task-001");
		expect(task.description).toBe("Build widget");
		expect(task.status).toBe("new");
	});

	test("create with all options", async () => {
		const result = await run(
			"--tasks-file",
			tasksFile,
			"create",
			"--description",
			"Build widget",
			"--prompt",
			"Full spec here",
			"--assigned-to",
			"engineer",
		);
		expect(result.exitCode).toBe(0);
		const task = JSON.parse(result.stdout);
		expect(task.initial_prompt).toBe("Full spec here");
		expect(task.assigned_to).toBe("engineer");
	});

	test("create errors without --description", async () => {
		const result = await run("--tasks-file", tasksFile, "create");
		expect(result.exitCode).not.toBe(0);
		const err = JSON.parse(result.stderr);
		expect(err.error).toContain("--description");
	});

	test("list returns all tasks", async () => {
		await run("--tasks-file", tasksFile, "create", "--description", "Task A");
		await run("--tasks-file", tasksFile, "create", "--description", "Task B");
		const result = await run("--tasks-file", tasksFile, "list");
		expect(result.exitCode).toBe(0);
		const tasks = JSON.parse(result.stdout);
		expect(tasks).toHaveLength(2);
	});

	test("list filters by status", async () => {
		await run("--tasks-file", tasksFile, "create", "--description", "Task A");
		await run("--tasks-file", tasksFile, "create", "--description", "Task B");
		await run("--tasks-file", tasksFile, "update", "--id", "task-002", "--status", "done");
		const result = await run("--tasks-file", tasksFile, "list", "--status", "new");
		expect(result.exitCode).toBe(0);
		const tasks = JSON.parse(result.stdout);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].id).toBe("task-001");
	});

	test("get returns a specific task", async () => {
		await run("--tasks-file", tasksFile, "create", "--description", "Task A");
		const result = await run("--tasks-file", tasksFile, "get", "--id", "task-001");
		expect(result.exitCode).toBe(0);
		const task = JSON.parse(result.stdout);
		expect(task.description).toBe("Task A");
	});

	test("get errors for nonexistent task", async () => {
		const result = await run("--tasks-file", tasksFile, "get", "--id", "task-999");
		expect(result.exitCode).not.toBe(0);
		const err = JSON.parse(result.stderr);
		expect(err.error).toContain("Task not found");
	});

	test("update changes status", async () => {
		await run("--tasks-file", tasksFile, "create", "--description", "Task A");
		const result = await run(
			"--tasks-file",
			tasksFile,
			"update",
			"--id",
			"task-001",
			"--status",
			"in_progress",
		);
		expect(result.exitCode).toBe(0);
		const task = JSON.parse(result.stdout);
		expect(task.status).toBe("in_progress");
	});

	test("update errors without --id", async () => {
		const result = await run("--tasks-file", tasksFile, "update", "--status", "done");
		expect(result.exitCode).not.toBe(0);
	});

	test("comment adds a note", async () => {
		await run("--tasks-file", tasksFile, "create", "--description", "Task A");
		const result = await run(
			"--tasks-file",
			tasksFile,
			"comment",
			"--id",
			"task-001",
			"--text",
			"Looks good",
		);
		expect(result.exitCode).toBe(0);
		const task = JSON.parse(result.stdout);
		expect(task.notes).toHaveLength(1);
		expect(task.notes[0].text).toBe("Looks good");
	});

	test("comment errors without --id or --text", async () => {
		const result = await run("--tasks-file", tasksFile, "comment", "--text", "No id");
		expect(result.exitCode).not.toBe(0);
	});
});
