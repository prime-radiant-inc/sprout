import { describe, expect, test } from "bun:test";
import { formatToolKeyArg, getToolDisplayName } from "../../src/shared/tool-display.ts";

describe("getToolDisplayName", () => {
	test("uses explicit displayName when present", () => {
		expect(getToolDisplayName("task-cli", "Task Runner")).toBe("Task Runner");
	});

	test("uses friendly built-in names", () => {
		expect(getToolDisplayName("read_file")).toBe("Read");
		expect(getToolDisplayName("edit_file")).toBe("Edit");
		expect(getToolDisplayName("exec")).toBe("Run");
		expect(getToolDisplayName("wait_agent")).toBe("Wait");
	});

	test("humanizes unknown tool names", () => {
		expect(getToolDisplayName("task-cli")).toBe("Task CLI");
		expect(getToolDisplayName("custom_formatter")).toBe("Custom Formatter");
	});
});

describe("formatToolKeyArg", () => {
	test("uses basename for read_file paths and keeps offset+limit", () => {
		expect(
			formatToolKeyArg("read_file", {
				path: "test/agents/agent.test.ts",
				offset: 512,
				limit: 5,
			}),
		).toBe("agent.test.ts:512+5");
	});

	test("uses basename for edit_file paths", () => {
		expect(formatToolKeyArg("edit_file", { path: "test/agents/agent.test.ts" })).toBe(
			"agent.test.ts",
		);
	});

	test("keeps exec command formatting", () => {
		expect(formatToolKeyArg("exec", { command: "ls -la" })).toBe("`ls -la`");
	});
});
