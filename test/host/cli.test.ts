import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, renderEvent, truncateLines } from "../../src/host/cli.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";

const defaultGenomePath = join(homedir(), ".local/share/sprout-genome");

function makeEvent(
	kind: SessionEvent["kind"],
	data: Record<string, unknown> = {},
	agentId = "root",
	depth = 0,
): SessionEvent {
	return {
		kind,
		timestamp: Date.now(),
		agent_id: agentId,
		depth,
		data,
	};
}

describe("parseArgs", () => {
	test("no args → interactive mode", () => {
		const result = parseArgs([]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt returns oneshot mode", () => {
		const result = parseArgs(["--prompt", "Fix the bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with multiple words joins them", () => {
		const result = parseArgs(["--prompt", "Fix", "the", "bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with no goal returns help", () => {
		const result = parseArgs(["--prompt"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("bare goal returns oneshot mode", () => {
		const result = parseArgs(["Fix the bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume returns resume mode", () => {
		const result = parseArgs(["--resume", "01ABC123"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC123",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume with no session ID returns help", () => {
		const result = parseArgs(["--resume"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--resume-last returns resume-last mode", () => {
		const result = parseArgs(["--resume-last"]);
		expect(result).toEqual({
			kind: "resume-last",
			genomePath: defaultGenomePath,
		});
	});

	test("--list returns list mode", () => {
		const result = parseArgs(["--list"]);
		expect(result).toEqual({
			kind: "list",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome list → genome-list command", () => {
		const result = parseArgs(["--genome", "list"]);
		expect(result).toEqual({
			kind: "genome-list",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome log → genome-log command", () => {
		const result = parseArgs(["--genome", "log"]);
		expect(result).toEqual({
			kind: "genome-log",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome rollback <commit> → genome-rollback command", () => {
		const result = parseArgs(["--genome", "rollback", "abc123"]);
		expect(result).toEqual({
			kind: "genome-rollback",
			genomePath: defaultGenomePath,
			commit: "abc123",
		});
	});

	test("--genome-path with goal → oneshot with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path", "Fix bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix bug",
			genomePath: "/custom/path",
		});
	});

	test("--genome-path with no args → interactive with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: "/custom/path",
		});
	});

	test("--help → help", () => {
		const result = parseArgs(["--help"]);
		expect(result).toEqual({ kind: "help" });
	});
});

describe("truncateLines", () => {
	test("returns text unchanged when under limit", () => {
		expect(truncateLines("line1\nline2\nline3", 10)).toBe("line1\nline2\nline3");
	});

	test("truncates to maxLines with ellipsis", () => {
		const text = "line1\nline2\nline3\nline4\nline5";
		expect(truncateLines(text, 3)).toBe("line1\nline2\nline3\n... (2 more lines)");
	});

	test("returns single line unchanged", () => {
		expect(truncateLines("hello", 10)).toBe("hello");
	});

	test("handles empty string", () => {
		expect(truncateLines("", 10)).toBe("");
	});
});

describe("renderEvent", () => {
	test("session_start shows agent prefix", () => {
		const result = renderEvent(makeEvent("session_start", { goal: "Fix bug" }));
		expect(result).toBe("[root] Starting session...");
	});

	test("plan_start shows turn number", () => {
		const result = renderEvent(makeEvent("plan_start", { turn: 1 }));
		expect(result).toBe("[root] Planning (turn 1)...");
	});

	test("plan_end shows reasoning and text", () => {
		const result = renderEvent(
			makeEvent("plan_end", {
				reasoning: "I need to create a file.",
				text: "I'll use the code-editor agent.",
			}),
		);
		expect(result).toContain("[root] I need to create a file.");
		expect(result).toContain("[root] I'll use the code-editor agent.");
	});

	test("plan_end shows only text when no reasoning", () => {
		const result = renderEvent(makeEvent("plan_end", { text: "Done thinking." }));
		expect(result).toBe("[root] Done thinking.");
	});

	test("plan_end returns null when no text or reasoning", () => {
		const result = renderEvent(makeEvent("plan_end", { turn: 1 }));
		expect(result).toBeNull();
	});

	test("primitive_start shows exec command", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "exec", args: { command: "ls -la" } }),
		);
		expect(result).toBe("[root]   exec `ls -la`");
	});

	test("primitive_start shows read_file path", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "read_file", args: { path: "/src/main.ts" } }),
		);
		expect(result).toBe("[root]   read_file /src/main.ts");
	});

	test("primitive_start shows write_file path", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "write_file", args: { path: "/src/out.ts" } }),
		);
		expect(result).toBe("[root]   write_file /src/out.ts");
	});

	test("primitive_start shows grep pattern", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "grep", args: { pattern: "TODO" } }),
		);
		expect(result).toBe("[root]   grep `TODO`");
	});

	test("primitive_start shows glob pattern", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "glob", args: { pattern: "**/*.ts" } }),
		);
		expect(result).toBe("[root]   glob `**/*.ts`");
	});

	test("primitive_end shows success with output line count", () => {
		const result = renderEvent(
			makeEvent("primitive_end", {
				name: "exec",
				success: true,
				output: "file1.ts\nfile2.ts\nfile3.ts",
			}),
		);
		expect(result).toBe("[root]   exec: done (3 lines)");
	});

	test("primitive_end shows success with no output", () => {
		const result = renderEvent(
			makeEvent("primitive_end", { name: "write_file", success: true, output: "" }),
		);
		expect(result).toBe("[root]   write_file: done");
	});

	test("primitive_end shows failure with error", () => {
		const result = renderEvent(
			makeEvent("primitive_end", {
				name: "exec",
				success: false,
				error: "command not found",
			}),
		);
		expect(result).toBe("[root]   exec: failed — command not found");
	});

	test("primitive_end shows failure without error", () => {
		const result = renderEvent(makeEvent("primitive_end", { name: "exec", success: false }));
		expect(result).toBe("[root]   exec: failed");
	});

	test("act_start shows arrow with agent and goal", () => {
		const result = renderEvent(
			makeEvent("act_start", { agent_name: "code-editor", goal: "Create hello.py" }),
		);
		expect(result).toBe("[root] \u2192 code-editor: Create hello.py");
	});

	test("act_end shows return arrow with result", () => {
		const result = renderEvent(
			makeEvent("act_end", { agent_name: "code-editor", success: true, turns: 2 }),
		);
		expect(result).toBe("[root] \u2190 code-editor: done (2 turns)");
	});

	test("act_end shows failure", () => {
		const result = renderEvent(makeEvent("act_end", { agent_name: "code-editor", success: false }));
		expect(result).toBe("[root] \u2190 code-editor: failed");
	});

	test("session_end shows summary", () => {
		const result = renderEvent(makeEvent("session_end", { turns: 5, stumbles: 2 }));
		expect(result).toBe("[root] Session complete. 5 turns, 2 stumbles.");
	});

	test("depth 1 indents by 2 spaces", () => {
		const result = renderEvent(makeEvent("session_start", { goal: "Fix" }, "code-editor", 1));
		expect(result).toBe("  [code-editor] Starting session...");
	});

	test("depth 2 indents by 4 spaces", () => {
		const result = renderEvent(makeEvent("plan_start", { turn: 1 }, "command-runner", 2));
		expect(result).toBe("    [command-runner] Planning (turn 1)...");
	});

	// Events that should be null (skipped)
	test("perceive → null", () => {
		expect(renderEvent(makeEvent("perceive"))).toBeNull();
	});

	test("recall → null", () => {
		expect(renderEvent(makeEvent("recall"))).toBeNull();
	});

	test("plan_delta → null", () => {
		expect(renderEvent(makeEvent("plan_delta"))).toBeNull();
	});

	test("verify → null", () => {
		expect(renderEvent(makeEvent("verify"))).toBeNull();
	});

	test("learn_signal → null", () => {
		expect(renderEvent(makeEvent("learn_signal"))).toBeNull();
	});

	test("learn_start shows message", () => {
		const result = renderEvent(makeEvent("learn_start"));
		expect(result).toBe("[root] Learning from stumble...");
	});

	test("learn_mutation shows mutation type", () => {
		const result = renderEvent(makeEvent("learn_mutation", { mutation_type: "add_memory" }));
		expect(result).toBe("[root]   Genome updated: add_memory");
	});

	test("learn_end → null", () => {
		expect(renderEvent(makeEvent("learn_end"))).toBeNull();
	});

	test("warning shows message", () => {
		const result = renderEvent(makeEvent("warning", { message: "rate limit approaching" }));
		expect(result).toBe("[root] \u26a0 rate limit approaching");
	});

	test("error shows message", () => {
		const result = renderEvent(makeEvent("error", { error: "connection refused" }));
		expect(result).toBe("[root] \u2717 connection refused");
	});

	test("steering → null", () => {
		expect(renderEvent(makeEvent("steering"))).toBeNull();
	});
});
