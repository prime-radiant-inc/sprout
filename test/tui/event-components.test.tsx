import { describe, expect, test } from "bun:test";
import { Box } from "ink";
import { render } from "ink-testing-library";
import type { SessionEvent } from "../../src/kernel/types.ts";
import {
	AssistantTextLine,
	DelegationEndLine,
	DelegationStartLine,
	PlanningLine,
	renderEventComponent,
	SystemLine,
	ToolEndLine,
	ToolStartLine,
} from "../../src/tui/event-components.tsx";
import { formatDuration, smartArgs } from "../../src/tui/render-event.ts";

// ---------------------------------------------------------------------------
// smartArgs
// ---------------------------------------------------------------------------

describe("smartArgs", () => {
	test("exec shows command in backticks", () => {
		expect(smartArgs("exec", { command: "ls -la" })).toBe("`ls -la`");
	});

	test("exec truncates long commands", () => {
		const longCmd = "a".repeat(100);
		const result = smartArgs("exec", { command: longCmd });
		expect(result.length).toBeLessThan(70);
		expect(result).toContain("...");
	});

	test("exec returns empty for missing command", () => {
		expect(smartArgs("exec", {})).toBe("");
	});

	test("read_file shows path", () => {
		expect(smartArgs("read_file", { path: "/src/main.ts" })).toBe("/src/main.ts");
	});

	test("read_file shows offset and limit", () => {
		expect(smartArgs("read_file", { path: "/src/main.ts", offset: 10, limit: 50 })).toBe(
			"/src/main.ts:10+50",
		);
	});

	test("read_file shows only limit", () => {
		expect(smartArgs("read_file", { path: "/src/main.ts", limit: 20 })).toBe("/src/main.ts:+20");
	});

	test("write_file shows path and line count", () => {
		expect(smartArgs("write_file", { path: "/out.ts", content: "a\nb\nc" })).toBe(
			"/out.ts (3 lines)",
		);
	});

	test("write_file shows only path when no content", () => {
		expect(smartArgs("write_file", { path: "/out.ts" })).toBe("/out.ts");
	});

	test("edit_file shows path", () => {
		expect(smartArgs("edit_file", { path: "/src/foo.ts" })).toBe("/src/foo.ts");
	});

	test("grep shows pattern in backticks", () => {
		expect(smartArgs("grep", { pattern: "TODO" })).toBe("`TODO`");
	});

	test("grep shows pattern and path", () => {
		expect(smartArgs("grep", { pattern: "TODO", path: "src/" })).toBe("`TODO` src/");
	});

	test("glob shows pattern in backticks", () => {
		expect(smartArgs("glob", { pattern: "**/*.ts" })).toBe("`**/*.ts`");
	});

	test("default shows first short key=value", () => {
		expect(smartArgs("unknown_tool", { key: "val" })).toBe("key=val");
	});

	test("default skips long values", () => {
		expect(smartArgs("unknown_tool", { key: "a".repeat(50) })).toBe("");
	});

	test("returns empty for no args", () => {
		expect(smartArgs("exec", undefined)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
	test("formats milliseconds as seconds with one decimal", () => {
		expect(formatDuration(1500)).toBe("1.5s");
	});

	test("returns null for null input", () => {
		expect(formatDuration(null)).toBeNull();
	});

	test("formats zero", () => {
		expect(formatDuration(0)).toBe("0.0s");
	});

	test("formats sub-second", () => {
		expect(formatDuration(300)).toBe("0.3s");
	});
});

// ---------------------------------------------------------------------------
// Individual components (rendered via ink-testing-library)
// ---------------------------------------------------------------------------

describe("ToolStartLine", () => {
	test("shows tool name and args", () => {
		const { lastFrame } = render(
			<ToolStartLine depth={0} toolName="exec" args={{ command: "ls" }} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("exec");
		expect(frame).toContain("`ls`");
	});

	test("indents based on depth", () => {
		const { lastFrame: frame0 } = render(
			<ToolStartLine depth={0} toolName="exec" args={{ command: "ls" }} />,
		);
		const { lastFrame: frame1 } = render(
			<ToolStartLine depth={1} toolName="exec" args={{ command: "ls" }} />,
		);
		// Depth 1 should have more leading whitespace
		const indent0 = frame0()!.length - frame0()!.trimStart().length;
		const indent1 = frame1()!.length - frame1()!.trimStart().length;
		expect(indent1).toBeGreaterThan(indent0);
	});

	test("handles no args", () => {
		const { lastFrame } = render(<ToolStartLine depth={0} toolName="custom" />);
		expect(lastFrame()).toContain("custom");
	});
});

describe("ToolEndLine", () => {
	test("shows check mark on success", () => {
		const { lastFrame } = render(
			<ToolEndLine
				depth={0}
				toolName="write_file"
				args={{ path: "/out.ts" }}
				success={true}
				durationMs={300}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("write_file");
		expect(frame).toContain("\u2713");
		expect(frame).toContain("0.3s");
	});

	test("shows cross mark and error on failure", () => {
		const { lastFrame } = render(
			<ToolEndLine
				depth={0}
				toolName="exec"
				args={{ command: "bad" }}
				success={false}
				error="command not found"
				durationMs={500}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("\u2717");
		expect(frame).toContain("command not found");
	});

	test("shows output preview for short output", () => {
		const { lastFrame } = render(
			<ToolEndLine
				depth={0}
				toolName="exec"
				args={{ command: "echo hi" }}
				success={true}
				output="Hello, World!"
				durationMs={100}
			/>,
		);
		expect(lastFrame()).toContain("Hello, World!");
	});

	test("truncates long output to 3 lines", () => {
		const output = "line1\nline2\nline3\nline4\nline5";
		const { lastFrame } = render(
			<ToolEndLine
				depth={0}
				toolName="exec"
				args={{ command: "cat" }}
				success={true}
				output={output}
				durationMs={100}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("line1");
		expect(frame).toContain("line3");
		expect(frame).toContain("2 more lines");
		expect(frame).not.toContain("line4");
	});

	test("no output preview on failure", () => {
		const { lastFrame } = render(
			<ToolEndLine
				depth={0}
				toolName="exec"
				success={false}
				error="failed"
				output="some output"
				durationMs={100}
			/>,
		);
		// Output preview is only shown on success
		expect(lastFrame()).not.toContain("some output");
	});

	test("handles null duration", () => {
		const { lastFrame } = render(
			<ToolEndLine depth={0} toolName="exec" success={true} durationMs={null} />,
		);
		// Should render without duration
		expect(lastFrame()).toContain("\u2713");
		expect(lastFrame()).not.toContain("s");
	});
});

describe("AssistantTextLine", () => {
	test("shows text content", () => {
		const { lastFrame } = render(<AssistantTextLine depth={0} text="Hello world" />);
		expect(lastFrame()).toContain("Hello world");
	});

	test("shows reasoning in dim/italic", () => {
		const { lastFrame } = render(
			<AssistantTextLine depth={0} reasoning="I should check first" text="Checking..." />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("I should check first");
		expect(frame).toContain("Checking...");
	});

	test("shows only reasoning when no text", () => {
		const { lastFrame } = render(<AssistantTextLine depth={0} reasoning="thinking about it" />);
		expect(lastFrame()).toContain("thinking about it");
	});
});

describe("DelegationStartLine", () => {
	test("shows agent name and goal", () => {
		const { lastFrame } = render(
			<DelegationStartLine depth={0} agentName="editor" goal="Create test file" />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("editor");
		expect(frame).toContain("Create test file");
		expect(frame).toContain("\u2192");
	});

	test("truncates long goals", () => {
		const longGoal = "a".repeat(120);
		const { lastFrame } = render(
			<DelegationStartLine depth={0} agentName="editor" goal={longGoal} />,
		);
		expect(lastFrame()).toContain("...");
	});
});

describe("DelegationEndLine", () => {
	test("shows success with turns and duration", () => {
		const { lastFrame } = render(
			<DelegationEndLine depth={0} agentName="editor" success={true} turns={3} durationMs={3100} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("\u2190");
		expect(frame).toContain("editor");
		expect(frame).toContain("\u2713");
		expect(frame).toContain("(3 turns)");
		expect(frame).toContain("3.1s");
	});

	test("shows failure", () => {
		const { lastFrame } = render(
			<DelegationEndLine depth={0} agentName="editor" success={false} durationMs={1000} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("\u2717 failed");
	});
});

describe("SystemLine", () => {
	test("renders dim system message", () => {
		const { lastFrame } = render(
			<SystemLine depth={0} kind="session_start" message="Starting session..." />,
		);
		expect(lastFrame()).toContain("Starting session...");
	});

	test("error uses cross icon", () => {
		const { lastFrame } = render(<SystemLine depth={0} kind="error" message="something broke" />);
		expect(lastFrame()).toContain("\u2717 something broke");
	});

	test("warning uses warning icon", () => {
		const { lastFrame } = render(<SystemLine depth={0} kind="warning" message="heads up" />);
		expect(lastFrame()).toContain("\u26A0 heads up");
	});

	test("interrupted uses circle-slash icon", () => {
		const { lastFrame } = render(
			<SystemLine depth={0} kind="interrupted" message="user interrupt" />,
		);
		expect(lastFrame()).toContain("\u2298 user interrupt");
	});

	test("session_end uses empty diamond", () => {
		const { lastFrame } = render(
			<SystemLine depth={0} kind="session_end" message="Session complete." />,
		);
		expect(lastFrame()).toContain("\u25C7 Session complete.");
	});
});

describe("PlanningLine", () => {
	test("shows planning indicator", () => {
		const { lastFrame } = render(<PlanningLine depth={0} />);
		expect(lastFrame()).toContain("planning...");
	});

	test("shows turn number when provided", () => {
		const { lastFrame } = render(<PlanningLine depth={0} turn={3} />);
		expect(lastFrame()).toContain("planning (turn 3)...");
	});

	test("indents at depth", () => {
		const { lastFrame } = render(<PlanningLine depth={1} />);
		const frame = lastFrame()!;
		const stripped = frame.trimStart();
		expect(frame.length - stripped.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AssistantTextLine markdown rendering
// ---------------------------------------------------------------------------

describe("AssistantTextLine markdown rendering", () => {
	test("renders plain text", () => {
		const { lastFrame } = render(<AssistantTextLine depth={0} text="hello world" />);
		expect(lastFrame()).toContain("hello world");
	});

	test("renders bold text without asterisks", () => {
		const { lastFrame } = render(<AssistantTextLine depth={0} text="hello **bold** world" />);
		const frame = lastFrame()!;
		expect(frame).toContain("bold");
		expect(frame).not.toContain("**");
	});

	test("renders inline code", () => {
		const { lastFrame } = render(<AssistantTextLine depth={0} text="run `npm test` now" />);
		const frame = lastFrame()!;
		expect(frame).toContain("npm test");
	});

	test("renders code blocks", () => {
		const text = "before\n```\ncode here\n```\nafter";
		const { lastFrame } = render(<AssistantTextLine depth={0} text={text} />);
		const frame = lastFrame()!;
		expect(frame).toContain("code here");
	});

	test("renders headers", () => {
		const { lastFrame } = render(<AssistantTextLine depth={0} text="# My Header" />);
		const frame = lastFrame()!;
		expect(frame).toContain("My Header");
	});

	test("renders bullet lists", () => {
		const text = "Items:\n- first\n- second\n- third";
		const { lastFrame } = render(<AssistantTextLine depth={0} text={text} />);
		const frame = lastFrame()!;
		expect(frame).toContain("first");
		expect(frame).toContain("second");
		expect(frame).toContain("third");
	});
});

// ---------------------------------------------------------------------------
// renderEventComponent dispatcher
// ---------------------------------------------------------------------------

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

describe("renderEventComponent", () => {
	test("session_start returns null (suppressed in TUI)", () => {
		const node = renderEventComponent(makeEvent("session_start"), null);
		expect(node).toBeNull();
	});

	test("plan_start returns null (suppressed in TUI)", () => {
		const node = renderEventComponent(makeEvent("plan_start", { turn: 1 }), null);
		expect(node).toBeNull();
	});

	test("plan_end renders assistant text", () => {
		const node = renderEventComponent(
			makeEvent("plan_end", { text: "I'll create the file.", reasoning: "Let me think..." }),
			null,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		const frame = lastFrame()!;
		expect(frame).toContain("I'll create the file.");
		expect(frame).toContain("Let me think...");
	});

	test("plan_end returns null for empty text and reasoning", () => {
		const node = renderEventComponent(makeEvent("plan_end", { turn: 1 }), null);
		expect(node).toBeNull();
	});

	test("primitive_start renders tool start", () => {
		const node = renderEventComponent(
			makeEvent("primitive_start", { name: "exec", args: { command: "ls" } }),
			null,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("exec");
		expect(lastFrame()).toContain("`ls`");
	});

	test("primitive_end renders tool end with duration", () => {
		const node = renderEventComponent(
			makeEvent("primitive_end", { name: "exec", success: true, output: "hello" }),
			1500,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		const frame = lastFrame()!;
		expect(frame).toContain("exec");
		expect(frame).toContain("\u2713");
		expect(frame).toContain("1.5s");
	});

	test("act_start renders delegation start", () => {
		const node = renderEventComponent(
			makeEvent("act_start", { agent_name: "code-editor", goal: "Create hello.py" }),
			null,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("code-editor");
		expect(lastFrame()).toContain("Create hello.py");
	});

	test("act_end renders delegation end", () => {
		const node = renderEventComponent(
			makeEvent("act_end", { agent_name: "code-editor", success: true, turns: 2 }),
			3000,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		const frame = lastFrame()!;
		expect(frame).toContain("code-editor");
		expect(frame).toContain("\u2713");
		expect(frame).toContain("(2 turns)");
		expect(frame).toContain("3.0s");
	});

	test("session_end returns null (suppressed in TUI)", () => {
		const node = renderEventComponent(makeEvent("session_end", { turns: 5, stumbles: 2 }), null);
		expect(node).toBeNull();
	});

	test("warning renders with warning icon", () => {
		const node = renderEventComponent(makeEvent("warning", { message: "rate limit" }), null);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("\u26A0 rate limit");
	});

	test("error renders with error icon", () => {
		const node = renderEventComponent(makeEvent("error", { error: "connection refused" }), null);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("\u2717 connection refused");
	});

	test("context_update returns null", () => {
		expect(renderEventComponent(makeEvent("context_update", { pressure: 0.5 }), null)).toBeNull();
	});

	test("perceive renders user message with goal", () => {
		const node = renderEventComponent(makeEvent("perceive", { goal: "Create hello.py" }), null);
		const { lastFrame } = render(node as any);
		expect(lastFrame()).toContain("Create hello.py");
	});

	test("recall returns null", () => {
		expect(renderEventComponent(makeEvent("recall"), null)).toBeNull();
	});

	test("plan_delta returns null", () => {
		expect(renderEventComponent(makeEvent("plan_delta"), null)).toBeNull();
	});

	test("learn_end returns null", () => {
		expect(renderEventComponent(makeEvent("learn_end"), null)).toBeNull();
	});

	test("unknown event returns null", () => {
		expect(renderEventComponent(makeEvent("totally_unknown" as any), null)).toBeNull();
	});

	test("interrupted renders", () => {
		const node = renderEventComponent(
			makeEvent("interrupted", { message: "User interrupted" }),
			null,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("User interrupted");
	});

	test("compaction renders summary to user", () => {
		const node = renderEventComponent(
			makeEvent("compaction", {
				beforeCount: 20,
				afterCount: 7,
				summary: "User asked to refactor the auth module. Completed steps 1-3.",
			}),
			null,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("compacted");
		expect(lastFrame()).toContain("refactor the auth module");
	});

	test("learn_start renders", () => {
		const node = renderEventComponent(makeEvent("learn_start"), null);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("Learning from stumble...");
	});

	test("learn_mutation renders", () => {
		const node = renderEventComponent(
			makeEvent("learn_mutation", { mutation_type: "add_memory" }),
			null,
		);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("Genome updated: add_memory");
	});

	test("steering renders", () => {
		const node = renderEventComponent(makeEvent("steering", { text: "focus on tests" }), null);
		const { lastFrame } = render(<Box>{node}</Box>);
		expect(lastFrame()).toContain("focus on tests");
	});
});
