import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "../../../../src/kernel/types.ts";
import { buildAgentTree } from "../../hooks/useAgentTree.ts";
import { AssistantMessage } from "../AssistantMessage.tsx";
import { CodeBlock } from "../CodeBlock.tsx";
import { ConversationView } from "../ConversationView.tsx";
import { DelegationBlock } from "../DelegationBlock.tsx";
import { EventLine } from "../EventLine.tsx";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { SystemMessage } from "../SystemMessage.tsx";
import { ToolCall } from "../ToolCall.tsx";
import { UserMessage } from "../UserMessage.tsx";

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

// --- CodeBlock ---

describe("CodeBlock", () => {
	test("renders code in pre > code tags", () => {
		const html = renderToStaticMarkup(<CodeBlock code="const x = 1;" />);
		expect(html).toContain("<pre");
		expect(html).toContain("<code");
		expect(html).toContain("const x = 1;");
	});

	test("adds language class when provided", () => {
		const html = renderToStaticMarkup(
			<CodeBlock code="fn main() {}" language="rust" />,
		);
		expect(html).toContain("language-rust");
	});

	test("omits language class when not provided", () => {
		const html = renderToStaticMarkup(<CodeBlock code="hello" />);
		expect(html).not.toContain("language-");
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

	test("renders prompt indicator", () => {
		const html = renderToStaticMarkup(<UserMessage text="hello" />);
		// Should have some visual indicator (chevron or similar)
		expect(html).toContain("&gt;");
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

// --- DelegationBlock ---

describe("DelegationBlock", () => {
	test("renders agent name and goal for start", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				variant="start"
				agentName="code-editor"
				goal="Refactor the parser"
			/>,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain("Refactor the parser");
	});

	test("renders success indicator for end", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				variant="end"
				agentName="code-editor"
				success={true}
				turns={3}
				durationMs={5000}
			/>,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain('data-status="success"');
		expect(html).toContain("\u2713");
		expect(html).toContain("3 turns");
		expect(html).toContain("5.0s");
	});

	test("renders failure indicator for end", () => {
		const html = renderToStaticMarkup(
			<DelegationBlock
				variant="end"
				agentName="code-editor"
				success={false}
			/>,
		);
		expect(html).toContain("failed");
	});

	test("truncates long goals", () => {
		const longGoal = "A".repeat(100);
		const html = renderToStaticMarkup(
			<DelegationBlock
				variant="start"
				agentName="test"
				goal={longGoal}
			/>,
		);
		// Should truncate to ~80 chars
		expect(html).toContain("...");
		expect(html).not.toContain("A".repeat(100));
	});
});

// --- SystemMessage ---

describe("SystemMessage", () => {
	test("renders warning message", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="warning" message="watch out" />,
		);
		expect(html).toContain("watch out");
		expect(html).toContain('data-kind="warning"');
		expect(html).toContain("\u26A0"); // warning icon
	});

	test("renders error message", () => {
		const html = renderToStaticMarkup(
			<SystemMessage kind="error" message="something broke" />,
		);
		expect(html).toContain("something broke");
		expect(html).toContain('data-kind="error"');
		expect(html).toContain("\u2717"); // error icon
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

	test("renders act_start as DelegationBlock start", () => {
		const event = makeEvent("act_start", {
			agent_name: "code-editor",
			goal: "write tests",
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={null} />,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain("write tests");
	});

	test("renders act_end as DelegationBlock end", () => {
		const event = makeEvent("act_end", {
			agent_name: "code-editor",
			success: true,
			turns: 5,
		});
		const html = renderToStaticMarkup(
			<EventLine event={event} durationMs={3000} />,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain("5 turns");
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
});
