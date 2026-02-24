import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/kernel/types.ts";
import {
	formatDuration,
	primitiveKeyArg,
	renderEvent,
	smartArgs,
	truncateLines,
} from "../../src/tui/render-event.ts";

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

describe("smartArgs", () => {
	test("exec shows command in backticks", () => {
		expect(smartArgs("exec", { command: "ls -la" })).toBe("`ls -la`");
	});

	test("read_file shows path with offset+limit", () => {
		expect(smartArgs("read_file", { path: "f.ts", offset: 10, limit: 20 })).toBe("f.ts:10+20");
	});

	test("write_file shows path with line count", () => {
		expect(smartArgs("write_file", { path: "f.ts", content: "a\nb" })).toBe("f.ts (2 lines)");
	});

	test("grep shows pattern and optional path", () => {
		expect(smartArgs("grep", { pattern: "TODO", path: "src/" })).toBe("`TODO` src/");
	});

	test("glob shows pattern in backticks", () => {
		expect(smartArgs("glob", { pattern: "**/*.ts" })).toBe("`**/*.ts`");
	});
});

describe("primitiveKeyArg (backward compat wrapper)", () => {
	test("returns space-prefixed smartArgs", () => {
		expect(primitiveKeyArg("exec", { command: "ls" })).toBe(" `ls`");
	});

	test("returns empty string when no args", () => {
		expect(primitiveKeyArg("exec", undefined)).toBe("");
	});
});

describe("formatDuration", () => {
	test("formats milliseconds as seconds", () => {
		expect(formatDuration(1500)).toBe("1.5s");
	});

	test("returns null for null", () => {
		expect(formatDuration(null)).toBeNull();
	});
});

describe("renderEvent", () => {
	test("session_start shows diamond icon", () => {
		const result = renderEvent(makeEvent("session_start", { goal: "Fix bug" }));
		expect(result).toBe("\u25C6 Starting session...");
	});

	test("plan_start shows thinking indicator", () => {
		const result = renderEvent(makeEvent("plan_start", { turn: 1 }));
		expect(result).toBe("\u25CC thinking...");
	});

	test("plan_end shows reasoning indented and text at base indent", () => {
		const result = renderEvent(
			makeEvent("plan_end", {
				reasoning: "I need to create a file.",
				text: "I'll use the code-editor agent.",
			}),
		);
		expect(result).toContain("  I need to create a file.");
		expect(result).toContain("I'll use the code-editor agent.");
	});

	test("plan_end shows only text when no reasoning", () => {
		const result = renderEvent(makeEvent("plan_end", { text: "Done thinking." }));
		expect(result).toBe("Done thinking.");
	});

	test("plan_end returns null when no text or reasoning", () => {
		const result = renderEvent(makeEvent("plan_end", { turn: 1 }));
		expect(result).toBeNull();
	});

	test("primitive_start shows triangle and exec command", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "exec", args: { command: "ls -la" } }),
		);
		expect(result).toBe("  \u25B8 exec `ls -la`");
	});

	test("primitive_start shows read_file path", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "read_file", args: { path: "/src/main.ts" } }),
		);
		expect(result).toBe("  \u25B8 read_file /src/main.ts");
	});

	test("primitive_start shows write_file path", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "write_file", args: { path: "/src/out.ts" } }),
		);
		expect(result).toBe("  \u25B8 write_file /src/out.ts");
	});

	test("primitive_start shows grep pattern", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "grep", args: { pattern: "TODO" } }),
		);
		expect(result).toBe("  \u25B8 grep `TODO`");
	});

	test("primitive_start shows glob pattern", () => {
		const result = renderEvent(
			makeEvent("primitive_start", { name: "glob", args: { pattern: "**/*.ts" } }),
		);
		expect(result).toBe("  \u25B8 glob `**/*.ts`");
	});

	test("primitive_end shows success with check mark", () => {
		const result = renderEvent(
			makeEvent("primitive_end", {
				name: "exec",
				success: true,
				output: "file1.ts\nfile2.ts\nfile3.ts",
			}),
		);
		expect(result).toBe("  \u25B8 exec \u2713");
	});

	test("primitive_end shows success with no output", () => {
		const result = renderEvent(
			makeEvent("primitive_end", { name: "write_file", success: true, output: "" }),
		);
		expect(result).toBe("  \u25B8 write_file \u2713");
	});

	test("primitive_end shows failure with error", () => {
		const result = renderEvent(
			makeEvent("primitive_end", {
				name: "exec",
				success: false,
				error: "command not found",
			}),
		);
		expect(result).toBe("  \u25B8 exec \u2717 command not found");
	});

	test("primitive_end shows failure without error", () => {
		const result = renderEvent(makeEvent("primitive_end", { name: "exec", success: false }));
		expect(result).toBe("  \u25B8 exec \u2717");
	});

	test("act_start shows arrow with agent and goal", () => {
		const result = renderEvent(
			makeEvent("act_start", { agent_name: "code-editor", goal: "Create hello.py" }),
		);
		expect(result).toBe("\u2192 code-editor: Create hello.py");
	});

	test("act_end shows return arrow with check on success", () => {
		const result = renderEvent(
			makeEvent("act_end", { agent_name: "code-editor", success: true, turns: 2 }),
		);
		expect(result).toBe("\u2190 code-editor \u2713 (2 turns)");
	});

	test("act_end shows failure", () => {
		const result = renderEvent(makeEvent("act_end", { agent_name: "code-editor", success: false }));
		expect(result).toBe("\u2190 code-editor \u2717 failed");
	});

	test("session_end shows summary with empty diamond", () => {
		const result = renderEvent(makeEvent("session_end", { turns: 5, stumbles: 2 }));
		expect(result).toBe("\u25C7 Session complete. 5 turns, 2 stumbles.");
	});

	test("depth 1 indents by 2 spaces", () => {
		const result = renderEvent(makeEvent("session_start", { goal: "Fix" }, "code-editor", 1));
		expect(result).toBe("  \u25C6 Starting session...");
	});

	test("depth 2 indents by 4 spaces", () => {
		const result = renderEvent(makeEvent("plan_start", { turn: 1 }, "command-runner", 2));
		expect(result).toBe("    \u25CC thinking...");
	});

	// Events that should be null (skipped)
	test("perceive shows goal", () => {
		expect(renderEvent(makeEvent("perceive", { goal: "Create hello.py" }))).toBe(
			"\u276F Create hello.py",
		);
	});

	test("recall -> null", () => {
		expect(renderEvent(makeEvent("recall"))).toBeNull();
	});

	test("plan_delta -> null", () => {
		expect(renderEvent(makeEvent("plan_delta"))).toBeNull();
	});

	test("verify -> null", () => {
		expect(renderEvent(makeEvent("verify"))).toBeNull();
	});

	test("learn_signal -> null", () => {
		expect(renderEvent(makeEvent("learn_signal"))).toBeNull();
	});

	test("learn_start shows message", () => {
		const result = renderEvent(makeEvent("learn_start"));
		expect(result).toBe("\u25CB Learning from stumble...");
	});

	test("learn_mutation shows mutation type", () => {
		const result = renderEvent(makeEvent("learn_mutation", { mutation_type: "add_memory" }));
		expect(result).toBe("\u25CB Genome updated: add_memory");
	});

	test("learn_end -> null", () => {
		expect(renderEvent(makeEvent("learn_end"))).toBeNull();
	});

	test("warning shows message", () => {
		const result = renderEvent(makeEvent("warning", { message: "rate limit approaching" }));
		expect(result).toBe("\u26A0 rate limit approaching");
	});

	test("error shows message", () => {
		const result = renderEvent(makeEvent("error", { error: "connection refused" }));
		expect(result).toBe("\u2717 connection refused");
	});

	test("steering shows user text", () => {
		const result = renderEvent(makeEvent("steering", { text: "focus on tests" }));
		expect(result).toBe("\u276F focus on tests");
	});

	test("renders session_resume event", () => {
		const result = renderEvent(makeEvent("session_resume", { turns: 5 }));
		expect(result).toContain("Resumed session");
	});

	test("renders interrupted event", () => {
		const result = renderEvent(makeEvent("interrupted", { message: "User interrupted" }));
		expect(result).toContain("User interrupted");
	});

	test("renders context_update event as null", () => {
		const result = renderEvent(makeEvent("context_update", { pressure: 0.45 }));
		expect(result).toBeNull();
	});

	test("renders compaction event", () => {
		const result = renderEvent(makeEvent("compaction", { beforeCount: 20, afterCount: 7 }));
		expect(result).toContain("compacted");
	});

	test("returns null for unknown event kind", () => {
		const event = makeEvent("totally_unknown" as any, {});
		expect(renderEvent(event)).toBeNull();
	});

	test("plan_end with only reasoning (empty text)", () => {
		const result = renderEvent(makeEvent("plan_end", { reasoning: "I think so", text: "" }));
		expect(result).toContain("I think so");
	});

	test("session_clear shows new session message", () => {
		const result = renderEvent(makeEvent("session_clear", { new_session_id: "abc" }));
		expect(result).toContain("New session started");
	});
});
