import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarTaskList } from "../SidebarTaskList.tsx";
import type { Task } from "../../hooks/useTaskList.ts";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		description: "Implement feature X",
		status: "new",
		assigned_to: null,
		...overrides,
	};
}

describe("SidebarTaskList", () => {
	test("returns null when tasks array is empty", () => {
		const html = renderToStaticMarkup(<SidebarTaskList tasks={[]} />);
		expect(html).toBe("");
	});

	test("renders header with 'Tasks' text", () => {
		const html = renderToStaticMarkup(
			<SidebarTaskList tasks={[makeTask()]} />,
		);
		expect(html).toContain("Tasks");
	});

	test("renders task description", () => {
		const html = renderToStaticMarkup(
			<SidebarTaskList tasks={[makeTask({ description: "Fix the bug" })]} />,
		);
		expect(html).toContain("Fix the bug");
	});

	test("renders multiple tasks", () => {
		const tasks = [
			makeTask({ id: "t1", description: "First task" }),
			makeTask({ id: "t2", description: "Second task" }),
			makeTask({ id: "t3", description: "Third task" }),
		];
		const html = renderToStaticMarkup(<SidebarTaskList tasks={tasks} />);
		expect(html).toContain("First task");
		expect(html).toContain("Second task");
		expect(html).toContain("Third task");
	});

	test("renders ○ icon for new status", () => {
		const html = renderToStaticMarkup(
			<SidebarTaskList tasks={[makeTask({ status: "new" })]} />,
		);
		expect(html).toContain("\u25CB");
	});

	test("renders ● icon for in_progress status", () => {
		const html = renderToStaticMarkup(
			<SidebarTaskList tasks={[makeTask({ status: "in_progress" })]} />,
		);
		expect(html).toContain("\u25CF");
	});

	test("renders ✓ icon for done status", () => {
		const html = renderToStaticMarkup(
			<SidebarTaskList tasks={[makeTask({ status: "done" })]} />,
		);
		expect(html).toContain("\u2713");
	});

	test("renders ✕ icon for cancelled status", () => {
		const html = renderToStaticMarkup(
			<SidebarTaskList tasks={[makeTask({ status: "cancelled" })]} />,
		);
		expect(html).toContain("\u2715");
	});

	test("renders a ul element for the list", () => {
		const html = renderToStaticMarkup(
			<SidebarTaskList tasks={[makeTask()]} />,
		);
		expect(html).toContain("<ul");
		expect(html).toContain("<li");
	});
});
