import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "../../../../src/kernel/types.ts";
import { buildAgentTree } from "../../hooks/useAgentTree.ts";
import { AssistantMessage } from "../AssistantMessage.tsx";
import { Breadcrumb } from "../Breadcrumb.tsx";
import { ConversationView } from "../ConversationView.tsx";
import { DelegationBlock } from "../DelegationBlock.tsx";
import { EventLine } from "../EventLine.tsx";
import { smartArgs } from "../format.ts";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { SystemMessage } from "../SystemMessage.tsx";
import { ToolCall } from "../ToolCall.tsx";
import { UserMessage } from "../UserMessage.tsx";
import { ReadFileRenderer } from "../tools/ReadFileRenderer.tsx";
import { EditFileRenderer } from "../tools/EditFileRenderer.tsx";
import { ExecRenderer } from "../tools/ExecRenderer.tsx";
import { FallbackRenderer } from "../tools/FallbackRenderer.tsx";

// --- Helpers ---

function makeEvent(
	kind: SessionEvent["kind"],
	data: Record<string, unknown> = {},
	overrides: Partial<SessionEvent> = {},
): SessionEvent {
	return {
		kind,
		timestamp: 1000,
		agent_id: "root",
		depth: 0,
		data,
		...overrides,
	};
}

// --- format ---

describe("format", () => {
	test("smartArgs wraps exec command in backticks", () => {
		expect(smartArgs("exec", { command: "ls -la" })).toBe("`ls -la`");
	});

	test("smartArgs exec truncation respects maxLen", () => {
		const longCmd = "a".repeat(100);
		const result = smartArgs("exec", { command: longCmd });
		// backticks add 2 chars, inner truncated = 57 chars + "..." = 60, total with backticks = 62
		expect(result.length).toBeLessThanOrEqual(62);
	});
});

// --- MarkdownBlock ---

describe("MarkdownBlock", () => {
	test("renders markdown as HTML", () => {
		const html = renderToStaticMarkup(<MarkdownBlock content="**bold**" />);
		expect(html).toContain("<strong>bold</strong>");
	});

	test("renders code fences", () => {
		const md = "```js\nconst x = 1;\n```";
		const html = renderToStaticMarkup(<MarkdownBlock content={md} />);
		expect(html).toContain("<code");
		expect(html).toContain("const x = 1;");
	});

	test("renders inline code", () => {
		const html = renderToStaticMarkup(
			<MarkdownBlock content="use `foo()` here" />,
		);
		expect(html).toContain("<code>foo()</code>");
	});

	test("renders empty string without error", () => {
		const html = renderToStaticMarkup(<MarkdownBlock content="" />);
		expect(html).toBeDefined();
	});

	test("sanitizes dangerous HTML in markdown", () => {
		const html = renderToStaticMarkup(
			<MarkdownBlock content='<img src=x onerror="alert(1)">' />,
		);
		expect(html).not.toContain("onerror");
		expect(html).toContain("<img");
	});

	test("wraps code blocks in a data-code-block container", () => {
		const md = "```js\nconst x = 1;\n```";
		const html = renderToStaticMarkup(<MarkdownBlock content={md} />);
		expect(html).toContain("data-code-block");
		expect(html).toContain("<pre");
		expect(html).toContain("const x = 1;");
	});

	test("does not wrap inline code in data-code-block container", () => {
		const html = renderToStaticMarkup(
			<MarkdownBlock content="use `foo()` here" />,
		);
		expect(html).not.toContain("data-code-block");
		expect(html).toContain("<code>foo()</code>");
	});

	test("wraps multiple code blocks each in their own container", () => {
		const md = "```\nfirst\n```\n\ntext\n\n```\nsecond\n```";
		const html = renderToStaticMarkup(<MarkdownBlock content={md} />);
		const matches = html.match(/data-code-block/g);
		expect(matches).toHaveLength(2);
	});
});

// --- UserMessage ---

describe("UserMessage", () => {
	test("renders user text", () => {
		const html = renderToStaticMarkup(<UserMessage text="fix the bug" />);
		expect(html).toContain("fix the bug");
	});

	test("renders with steering style when isSteering is true", () => {
		const html = renderToStaticMarkup(
			<UserMessage text="focus on tests" isSteering />,
		);
		expect(html).toContain("focus on tests");
		expect(html).toContain('data-kind="steering"');
	});

	test("does not render terminal prompt character", () => {
		const html = renderToStaticMarkup(<UserMessage text="hello" />);
		expect(html).not.toContain("&gt;");
	});

	test("renders 'You' label when isFirstInGroup is true", () => {
		const html = renderToStaticMarkup(
			<UserMessage text="hello" isFirstInGroup />,
		);
		expect(html).toContain("You");
	});

	test("does not render header when isFirstInGroup is false", () => {
		const html = renderToStaticMarkup(<UserMessage text="hello" />);
		expect(html).not.toContain("You");
	});

	test("renders steering badge when isSteering is true", () => {
		const html = renderToStaticMarkup(
			<UserMessage text="focus on tests" isSteering />,
		);
		expect(html).toContain("steering");
	});

	test("renders formatted timestamp when provided", () => {
		// 2025-01-15T12:30:00.000Z
		const ts = 1736944200000;
		const html = renderToStaticMarkup(
			<UserMessage text="hello" isFirstInGroup timestamp={ts} />,
		);
		expect(html).toContain("12:30");
	});
});

// --- AssistantMessage ---

describe("AssistantMessage", () => {
	test("renders text as markdown", () => {
		const html = renderToStaticMarkup(
			<AssistantMessage text="Here is **bold** text" />,
		);
		expect(html).toContain("<strong>bold</strong>");
	});

	test("renders reasoning in a collapsible section", () => {
		const html = renderToStaticMarkup(
			<AssistantMessage
				text="The answer is 42"
				reasoning="Let me think about this..."
			/>,
		);
		expect(html).toContain("The answer is 42");
		expect(html).toContain("Let me think about this...");
		expect(html).toContain("thinking");
	});

	test("renders text only when no reasoning", () => {
		const html = renderToStaticMarkup(
			<AssistantMessage text="just text" />,
		);
		expect(html).toContain("just text");
		expect(html).not.toContain("thinking");
	});

	test("renders reasoning only when no text", () => {
		const html = renderToStaticMarkup(
			<AssistantMessage reasoning="just reasoning" />,
		);
		expect(html).toContain("just reasoning");
	});

	test("renders agent name when isFirstInGroup is true", () => {
		const html = renderToStaticMarkup(
			<AssistantMessage text="hello" isFirstInGroup agentName="planner" />,
		);
		expect(html).toContain("planner");
	});

	test("renders 'Assistant' as default name when isFirstInGroup but no agentName", () => {
		const html = renderToStaticMarkup(
			<AssistantMessage text="hello" isFirstInGroup />,
		);
		expect(html).toContain("Assistant");
	});

	test("does not render header when isFirstInGroup is false or undefined", () => {
		const html = renderToStaticMarkup(
			<AssistantMessage text="hello" agentName="planner" />,
		);
		expect(html).not.toContain("planner");
		expect(html).not.toContain("Assistant");
	});

	test("renders formatted timestamp when isFirstInGroup and timestamp provided", () => {
		// 2025-01-15T12:30:00.000Z
		const ts = 1736944200000;
		const html = renderToStaticMarkup(
			<AssistantMessage text="hello" isFirstInGroup timestamp={ts} />,
		);
		expect(html).toContain("12:30");
	});
});

// --- ToolCall ---

describe("ToolCall", () => {
	test("renders tool name", () => {
		const html = renderToStaticMarkup(
			<ToolCall
				toolName="read_file"
				success={true}
				args={{ path: "/tmp/test.ts" }}
			/>,
		);
		expect(html).toContain("read_file");
	});

	test("shows success indicator", () => {
		const html = renderToStaticMarkup(
			<ToolCall toolName="exec" success={true} />
		);
		expect(html).toContain('data-status="success"');
		expect(html).toContain("\u2713");
	});

	test("shows failure indicator and error", () => {
		const html = renderToStaticMarkup(
			<ToolCall
				toolName="exec"
				success={false}
				error="command not found"
			/>,
		);
		expect(html).toContain('data-status="error"');
		expect(html).toContain("\u2717");
		expect(html).toContain("command not found");
	});

	test("shows duration when provided", () => {
		const html = renderToStaticMarkup(
			<ToolCall toolName="exec" success={true} durationMs={1500} />,
		);
		expect(html).toContain("1.5s");
	});

	test("renders smart args for exec", () => {
		const html = renderToStaticMarkup(
			<ToolCall
				toolName="exec"
				success={true}
				args={{ command: "ls -la" }}
			/>,
		);
		expect(html).toContain("ls -la");
	});

	test("renders output preview when provided", () => {
		const html = renderToStaticMarkup(
			<ToolCall
				toolName="read_file"
				success={true}
				output="file contents here"
			/>,
		);
		expect(html).toContain("file contents here");
	});
});

// --- ReadFileRenderer ---

describe("ReadFileRenderer", () => {
	test("renders filename from args", () => {
		const html = renderToStaticMarkup(
			<ReadFileRenderer
				toolName="read_file"
				args={{ path: "/src/main.ts" }}
				output="const x = 1;\nconst y = 2;\nconst z = 3;"
				success={true}
			/>,
		);
		expect(html).toContain("/src/main.ts");
	});

	test("previews first 10 lines of output", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const html = renderToStaticMarkup(
			<ReadFileRenderer
				toolName="read_file"
				args={{ path: "/tmp/big.ts" }}
				output={lines.join("\n")}
				success={true}
			/>,
		);
		expect(html).toContain("line 1");
		expect(html).toContain("line 10");
		expect(html).not.toContain("line 11");
	});

	test("shows line count", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
		const html = renderToStaticMarkup(
			<ReadFileRenderer
				toolName="read_file"
				args={{ path: "/tmp/big.ts" }}
				output={lines.join("\n")}
				success={true}
			/>,
		);
		expect(html).toContain("50 lines");
	});
});

// --- EditFileRenderer ---

describe("EditFileRenderer", () => {
	test("renders diff lines with added/removed indicators", () => {
		const diffOutput = [
			"--- a/file.ts",
			"+++ b/file.ts",
			"@@ -1,3 +1,3 @@",
			" unchanged",
			"-old line",
			"+new line",
			" unchanged",
		].join("\n");
		const html = renderToStaticMarkup(
			<EditFileRenderer
				toolName="edit_file"
				args={{ path: "/src/file.ts" }}
				output={diffOutput}
				success={true}
			/>,
		);
		expect(html).toContain('data-diff="added"');
		expect(html).toContain('data-diff="removed"');
		expect(html).toContain("+new line");
		expect(html).toContain("-old line");
	});

	test("renders file path from args", () => {
		const html = renderToStaticMarkup(
			<EditFileRenderer
				toolName="edit_file"
				args={{ path: "/src/app.tsx" }}
				output="edited successfully"
				success={true}
			/>,
		);
		expect(html).toContain("/src/app.tsx");
	});

	test("falls back to plain output when no diff detected", () => {
		const html = renderToStaticMarkup(
			<EditFileRenderer
				toolName="edit_file"
				args={{ path: "/src/app.tsx" }}
				output="file updated"
				success={true}
			/>,
		);
		expect(html).toContain("file updated");
	});
});

// --- ExecRenderer ---

describe("ExecRenderer", () => {
	test("renders command and output", () => {
		const html = renderToStaticMarkup(
			<ExecRenderer
				toolName="exec"
				args={{ command: "ls -la" }}
				output="total 32\ndrwxr-xr-x 5 user staff 160"
				success={true}
			/>,
		);
		expect(html).toContain("ls -la");
		expect(html).toContain("total 32");
	});

	test("shows error when failed", () => {
		const html = renderToStaticMarkup(
			<ExecRenderer
				toolName="exec"
				args={{ command: "bad-cmd" }}
				output="command not found"
				success={false}
				error="exit code 127"
			/>,
		);
		expect(html).toContain("bad-cmd");
		expect(html).toContain("exit code 127");
	});
});

// --- FallbackRenderer ---

describe("FallbackRenderer", () => {
	test("renders formatted tool args", () => {
		const html = renderToStaticMarkup(
			<FallbackRenderer
				toolName="custom_tool"
				args={{ key: "value", count: 42 }}
				output="some output"
				success={true}
			/>,
		);
		// renderToStaticMarkup HTML-encodes quotes inside elements
		expect(html).toContain("&quot;key&quot;");
		expect(html).toContain("&quot;value&quot;");
		expect(html).toContain("42");
	});

	test("renders output", () => {
		const html = renderToStaticMarkup(
			<FallbackRenderer
				toolName="custom_tool"
				args={{ key: "value" }}
				output="tool result here"
				success={true}
			/>,
		);
		expect(html).toContain("tool result here");
	});
});

// --- DelegationBlock ---

describe("DelegationBlock", () => {
	test("renders agent name and goal", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="code-editor"
				goal="Refactor the parser"
				status="running"
			/>,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain("Refactor the parser");
	});

	test("renders running status", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="code-editor"
				goal="Refactor the parser"
				status="running"
			/>,
		);
		expect(html).toContain('data-status="running"');
	});

	test("renders completed status with success check", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="code-editor"
				goal="Refactor the parser"
				status="completed"
				turns={3}
				durationMs={5000}
			/>,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain('data-status="completed"');
		expect(html).toContain("\u2713");
		expect(html).toContain("3 turns");
		expect(html).toContain("5.0s");
	});

	test("renders failed status with error styling", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="code-editor"
				goal="Refactor the parser"
				status="failed"
			/>,
		);
		expect(html).toContain('data-status="failed"');
		expect(html).toContain("failed");
	});

	test("renders turns and duration when provided", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="worker"
				goal="do stuff"
				status="completed"
				turns={7}
				durationMs={12300}
			/>,
		);
		expect(html).toContain("7 turns");
		expect(html).toContain("12.3s");
	});

	test("renders View thread link when onOpenThread provided", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="code-editor"
				goal="Refactor the parser"
				status="completed"
				onOpenThread={() => {}}
			/>,
		);
		expect(html).toContain("View thread");
	});

	test("does not render View thread link when onOpenThread is absent", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="code-editor"
				goal="Refactor the parser"
				status="completed"
			/>,
		);
		expect(html).not.toContain("View thread");
	});

	test("truncates long goals", () => {
		const longGoal = "A".repeat(100);
		const html = renderToStaticMarkup(
			<DelegationBlock
				agentName="test"
				goal={longGoal}
				status="running"
			/>,
		);
		expect(html).toContain("...");
		expect(html).not.toContain("A".repeat(100));
	});

	test("DelegationBlock truncates goal to exactly 80 characters", () => {
		const longGoal = "a".repeat(100);
		const html = renderToStaticMarkup(
			<DelegationBlock agentName="agent" goal={longGoal} status="running" />,
		);
		// The displayed goal should be at most 80 chars: 77 chars + "..."
		const goalMatch = html.match(/(a+)\.\.\./);
		expect(goalMatch).toBeTruthy();
		expect(goalMatch![1]!.length + 3).toBe(80);
	});
});

// --- SystemMessage ---

describe("SystemMessage", () => {
	test("renders warning message with data-kind and dot", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="warning" message="watch out" />,
		);
		expect(html).toContain("watch out");
		expect(html).toContain('data-kind="warning"');
		expect(html).toContain('data-testid="dot"');
	});

	test("renders error message with data-kind and dot", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="error" message="something broke" />,
		);
		expect(html).toContain("something broke");
		expect(html).toContain('data-kind="error"');
		expect(html).toContain('data-testid="dot"');
	});

	test("renders compaction message", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="compaction" message="Context compacted" />,
		);
		expect(html).toContain("Context compacted");
	});

	test("renders generic system message", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="session_resume" message="Resumed session" />,
		);
		expect(html).toContain("Resumed session");
	});

	test("renders as centered pill with wrapper", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="compaction" message="Context compacted" />,
		);
		expect(html).toContain('data-testid="system-message-wrapper"');
		expect(html).toContain('data-testid="dot"');
	});

	test("renders dot element inside pill", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="session_start" message="Session started" />,
		);
		expect(html).toContain('data-testid="dot"');
		expect(html).toContain('data-kind="session_start"');
	});
});

// --- EventLine ---

describe("EventLine", () => {
	test("renders perceive as UserMessage", () => {
		const event = makeEvent("perceive", { goal: "fix the bug" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("fix the bug");
	});

	test("renders steering as UserMessage with steering style", () => {
		const event = makeEvent("steering", { text: "focus on tests" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("focus on tests");
		expect(html).toContain('data-kind="steering"');
	});

	test("renders plan_end with text as AssistantMessage", () => {
		const event = makeEvent("plan_end", { text: "Here is the **plan**" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("<strong>plan</strong>");
	});

	test("renders plan_end with reasoning", () => {
		const event = makeEvent("plan_end", {
			text: "answer",
			reasoning: "let me think",
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("answer");
		expect(html).toContain("let me think");
	});

	test("returns null for plan_end with no text or reasoning", () => {
		const event = makeEvent("plan_end", {});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toBe("");
	});

	test("returns null for primitive_start", () => {
		const event = makeEvent("primitive_start", {
			name: "read_file",
			args: {},
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toBe("");
	});

	test("renders primitive_end as ToolCall", () => {
		const event = makeEvent("primitive_end", {
			name: "exec",
			args: { command: "ls" },
			success: true,
			output: "file.txt",
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={250} />,
		);
		expect(html).toContain("exec");
		expect(html).toContain("ls");
	});

	test("renders act_start as running DelegationBlock", () => {
		const event = makeEvent("act_start", {
			agent_name: "code-editor",
			goal: "write tests",
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain("write tests");
		expect(html).toContain('data-status="running"');
	});

	test("renders act_end as completed DelegationBlock", () => {
		const event = makeEvent("act_end", {
			agent_name: "code-editor",
			goal: "write tests",
			success: true,
			turns: 5,
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={3000} />,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain('data-status="completed"');
		expect(html).toContain("5 turns");
	});

	test("renders act_end as failed DelegationBlock", () => {
		const event = makeEvent("act_end", {
			agent_name: "code-editor",
			goal: "write tests",
			success: false,
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain('data-status="failed"');
	});

	test("renders warning as SystemMessage", () => {
		const event = makeEvent("warning", { message: "careful" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("careful");
		expect(html).toContain('data-kind="warning"');
	});

	test("renders error as SystemMessage", () => {
		const event = makeEvent("error", { error: "bad thing" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("bad thing");
		expect(html).toContain('data-kind="error"');
	});

	test("renders compaction as SystemMessage", () => {
		const event = makeEvent("compaction", {
			beforeCount: 100,
			afterCount: 20,
			summary: "compacted context",
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("100");
		expect(html).toContain("20");
	});

	test("returns null for context_update", () => {
		const event = makeEvent("context_update", { context_tokens: 500 });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toBe("");
	});

	test("returns null for exit_hint", () => {
		const event = makeEvent("exit_hint", {});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toBe("");
	});

	test("returns null for session_start", () => {
		const event = makeEvent("session_start", { model: "gpt-4o" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toBe("");
	});

	test("returns null for session_end", () => {
		const event = makeEvent("session_end", {});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toBe("");
	});

	test("renders interrupted as SystemMessage", () => {
		const event = makeEvent("interrupted", { message: "user interrupt" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("user interrupt");
	});

	test("renders session_resume as SystemMessage", () => {
		const event = makeEvent("session_resume", { history_length: 10 });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("Resumed");
		expect(html).toContain("10");
	});

	test("renders session_clear as SystemMessage", () => {
		const event = makeEvent("session_clear", {});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("New session");
	});

	test("renders plan_delta text as streaming assistant message", () => {
		const html = renderToStaticMarkup(
			<EventLine
				event={{ kind: "plan_delta", timestamp: 1, agent_id: "root", depth: 0, data: { text: "Hello " } }}
				durationMs={null}
				streamingText="Hello world"
			/>,
		);
		expect(html).toContain("Hello world");
	});

	test("passes isFirstInGroup to UserMessage for perceive events", () => {
		const event = makeEvent("perceive", { goal: "hello" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} isFirstInGroup />,
		);
		expect(html).toContain("You");
	});

	test("passes isFirstInGroup and agentName to AssistantMessage for plan_end", () => {
		const event = makeEvent("plan_end", { text: "answer" }, { agent_id: "planner-agent" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} isFirstInGroup />,
		);
		expect(html).toContain("Assistant");
	});

	test("passes onSelectAgent as onOpenThread to DelegationBlock for act_end", () => {
		const event = makeEvent("act_end", {
			agent_name: "code-editor",
			goal: "write tests",
			success: true,
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("View thread");
	});

	test("passes timestamp to UserMessage when isFirstInGroup", () => {
		const event = makeEvent("perceive", { goal: "hello" }, { timestamp: 1736944200000 });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} isFirstInGroup />,
		);
		expect(html).toContain("12:30");
	});

	test("passes timestamp to AssistantMessage when isFirstInGroup", () => {
		const event = makeEvent("plan_end", { text: "answer" }, { timestamp: 1736944200000 });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} isFirstInGroup />,
		);
		expect(html).toContain("12:30");
	});

	test("passes agentName to AssistantMessage for plan_end", () => {
		const event = makeEvent("plan_end", { text: "hello" }, { agent_id: "child-1" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} isFirstInGroup agentName="test-agent" />,
		);
		expect(html).toContain("test-agent");
	});

	test("passes agentName to AssistantMessage for plan_delta streaming", () => {
		const event = makeEvent("plan_delta", { text: "..." }, { agent_id: "child-1" });
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} isFirstInGroup streamingText="hello" agentName="streamer" />,
		);
		expect(html).toContain("streamer");
	});
});

// --- ConversationView ---

describe("ConversationView", () => {
	test("renders a list of events", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", { goal: "hello world" }),
			makeEvent("plan_end", { text: "I will help you" }),
			makeEvent("primitive_end", {
				name: "exec",
				args: { command: "echo hi" },
				success: true,
				output: "hi",
			}),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(<ConversationView events={events} tree={tree} />);
		expect(html).toContain("hello world");
		expect(html).toContain("I will help you");
		expect(html).toContain("exec");
	});

	test("skips events that return null", () => {
		const events: SessionEvent[] = [
			makeEvent("session_start", { model: "gpt-4o" }),
			makeEvent("perceive", { goal: "visible" }),
			makeEvent("context_update", { context_tokens: 500 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(<ConversationView events={events} tree={tree} />);
		expect(html).toContain("visible");
		expect(html).not.toContain("context_tokens");
	});

	test("tracks duration from start to end events", () => {
		const events: SessionEvent[] = [
			makeEvent("primitive_start", { name: "exec", args: {} }, { timestamp: 1000 }),
			makeEvent(
				"primitive_end",
				{ name: "exec", args: { command: "ls" }, success: true },
				{ timestamp: 2500 },
			),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(<ConversationView events={events} tree={tree} />);
		expect(html).toContain("1.5s");
	});

	test("filters events by agentId when provided", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", { goal: "root goal" }, { agent_id: "root-agent", depth: 0 }),
			makeEvent("act_start", { agent_name: "alpha", goal: "alpha work" }, { agent_id: "alpha-agent", depth: 1, timestamp: 1001 }),
			makeEvent("perceive", { goal: "alpha goal" }, { agent_id: "alpha-agent", depth: 1 }),
			makeEvent("act_end", { agent_name: "alpha", success: true }, { agent_id: "alpha-agent", depth: 1, timestamp: 1002 }),
			makeEvent("act_start", { agent_name: "beta", goal: "beta work" }, { agent_id: "beta-agent", depth: 1, timestamp: 1003 }),
			makeEvent("perceive", { goal: "beta goal" }, { agent_id: "beta-agent", depth: 1 }),
			makeEvent("act_end", { agent_name: "beta", success: true }, { agent_id: "beta-agent", depth: 1, timestamp: 1004 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(
			<ConversationView events={events} agentFilter="alpha-agent" tree={tree} />,
		);
		expect(html).toContain("alpha goal");
		expect(html).not.toContain("beta goal");
		expect(html).not.toContain("root goal");
	});

	test("agent filter includes descendant events", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", { goal: "root goal" }, { agent_id: "root-agent", depth: 0 }),
			makeEvent("act_start", { agent_name: "parent", goal: "parent work" }, { agent_id: "parent-agent", depth: 1 }),
			makeEvent("perceive", { goal: "parent goal" }, { agent_id: "parent-agent", depth: 1 }),
			makeEvent("act_start", { agent_name: "child", goal: "child work" }, { agent_id: "child-agent", depth: 2 }),
			makeEvent("perceive", { goal: "child goal" }, { agent_id: "child-agent", depth: 2 }),
			makeEvent("act_end", { agent_name: "child", success: true }, { agent_id: "child-agent", depth: 2 }),
			makeEvent("act_end", { agent_name: "parent", success: true }, { agent_id: "parent-agent", depth: 1 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(
			<ConversationView events={events} agentFilter="parent-agent" tree={tree} />,
		);
		// Should include parent and its child
		expect(html).toContain("parent goal");
		expect(html).toContain("child goal");
		// Should exclude root
		expect(html).not.toContain("root goal");
	});

	test("renders empty state when no events", () => {
		const tree = buildAgentTree([]);
		const html = renderToStaticMarkup(<ConversationView events={[]} tree={tree} />);
		expect(html).toBeDefined();
	});

	test("accumulates plan_delta text into a single streaming message", () => {
		const events: SessionEvent[] = [
			makeEvent("plan_start", {}, { timestamp: 1000 }),
			makeEvent("plan_delta", { text: "Hello " }, { timestamp: 1001 }),
			makeEvent("plan_delta", { text: "world" }, { timestamp: 1002 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(<ConversationView events={events} tree={tree} />);
		expect(html).toContain("Hello world");
	});

	test("clears plan_delta buffer on plan_end", () => {
		const events: SessionEvent[] = [
			makeEvent("plan_start", {}, { timestamp: 1000 }),
			makeEvent("plan_delta", { text: "streaming text" }, { timestamp: 1001 }),
			makeEvent("plan_end", { text: "final text" }, { timestamp: 1002 }),
			makeEvent("plan_start", {}, { timestamp: 1003 }),
			makeEvent("plan_delta", { text: "second" }, { timestamp: 1004 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(<ConversationView events={events} tree={tree} />);
		expect(html).toContain("final text");
		expect(html).toContain("second");
		// Buffer from first plan should NOT bleed into second
		expect(html).not.toContain("streaming textsecond");
	});

	test("groups consecutive plan_end from same agent — only first gets header", () => {
		const events: SessionEvent[] = [
			makeEvent("plan_end", { text: "first message" }, { timestamp: 1000 }),
			makeEvent("plan_end", { text: "second message" }, { timestamp: 1001 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(<ConversationView events={events} tree={tree} />);
		expect(html).toContain("first message");
		expect(html).toContain("second message");
		// The agent name header (">root<") should appear only once (first message in the group).
		// We match ">root<" to avoid counting "root" in key attributes.
		const matches = html.match(/>root</g);
		expect(matches).toHaveLength(1);
	});

	test("delegation blocks render with data-status attribute", () => {
		const events: SessionEvent[] = [
			makeEvent("act_start", { agent_name: "worker", goal: "do work" }, { timestamp: 1000 }),
			makeEvent("act_end", { agent_name: "worker", goal: "do work", success: true, turns: 2 }, { timestamp: 2000 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(<ConversationView events={events} tree={tree} />);
		expect(html).toContain('data-status="running"');
		expect(html).toContain('data-status="completed"');
	});

	test("passes onSelectAgent to delegation blocks as onOpenThread", () => {
		const events: SessionEvent[] = [
			makeEvent("act_end", { agent_name: "worker", goal: "do work", success: true }, { agent_id: "worker-agent", timestamp: 1000 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(
			<ConversationView events={events} tree={tree} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("View thread");
	});

	test("passes onSelectAgent to enable View thread links on act_start", () => {
		const events: SessionEvent[] = [
			makeEvent("act_start", { agent_name: "sub-agent", goal: "do stuff" }, { agent_id: "child-1", depth: 1 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(
			<ConversationView events={events} tree={tree} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("View thread");
	});

	test("shows StreamingBanner when last event is plan_delta", () => {
		const events: SessionEvent[] = [
			makeEvent("plan_delta", { text: "thinking..." }, { agent_id: "root", timestamp: 1000 }),
		];
		const tree = buildAgentTree([]);
		const html = renderToStaticMarkup(
			<ConversationView events={events} tree={tree} />,
		);
		expect(html).toContain("is responding");
	});

	test("StreamingBanner shows resolved agent name, not raw ID", () => {
		const events: SessionEvent[] = [
			makeEvent("act_start", { agent_name: "code-editor", goal: "edit" }, { agent_id: "ce-1", depth: 1 }),
			makeEvent("plan_delta", { text: "thinking..." }, { agent_id: "ce-1", depth: 1, timestamp: 1000 }),
		];
		const tree = buildAgentTree(events);
		const html = renderToStaticMarkup(
			<ConversationView events={events} tree={tree} />,
		);
		expect(html).toContain("is responding");
		// The StreamingBanner renders agentName in a span adjacent to "is responding".
		// It should use the resolved name "code-editor", not the raw agent_id "ce-1".
		expect(html).not.toMatch(/ce-1<\/span><span[^>]*>is responding/);
		expect(html).toMatch(/code-editor<\/span><span[^>]*>is responding/);
	});
});

// --- Breadcrumb ---

describe("Breadcrumb", () => {
	test("renders segments as buttons", () => {
		const tree = buildAgentTree([
			makeEvent("act_start", { agent_name: "child", goal: "g" }, { agent_id: "child-1", depth: 1 }),
		]);
		const html = renderToStaticMarkup(
			<Breadcrumb tree={tree} selectedAgent="child-1" onSelectAgent={() => {}} />,
		);
		expect(html).toContain("button");
		expect(html).toContain("root");
		expect(html).toContain("child");
	});
});
