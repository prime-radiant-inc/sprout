import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "@kernel/types.ts";
import type { SessionStatus } from "../../hooks/useEvents.ts";
import type { AgentTreeNode } from "../../hooks/useAgentTree.ts";
import { Sidebar } from "../Sidebar.tsx";
import { SidebarSessionSummary } from "../SidebarSessionSummary.tsx";

// --- Helpers ---

function makeNode(overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
	return {
		agentId: "root",
		agentName: "root",
		depth: 0,
		status: "running",
		goal: "Build the thing",
		children: [],
		...overrides,
	};
}

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
	return {
		status: "idle",
		model: "claude-sonnet-4-20250514",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		contextWindowSize: 200_000,
		sessionId: "sess-abc-123",
		availableModels: [],
		sessionStartedAt: null,
		...overrides,
	};
}

function makeFileEvent(
	name: string,
	path: string,
): SessionEvent {
	return {
		kind: "primitive_start",
		timestamp: Date.now(),
		agent_id: "root",
		depth: 0,
		data: { name, args: { path } },
	};
}

// --- Sidebar ---

describe("Sidebar", () => {
	test("renders AgentTree when status is 'running'", () => {
		const html = renderToStaticMarkup(
			<Sidebar
				status={makeStatus({ status: "running" })}
				tree={makeNode()}
				selectedAgent={null}
				onSelectAgent={() => {}}

				onToggle={() => {}}
				events={[]}
				tasks={[]}
			/>,
		);
		// AgentTree renders data-agent-id attributes
		expect(html).toContain('data-agent-id="root"');
		// Should NOT show session summary content
		expect(html).not.toContain("Session");
	});

	test("renders AgentTree when status is 'interrupted'", () => {
		const html = renderToStaticMarkup(
			<Sidebar
				status={makeStatus({ status: "interrupted" })}
				tree={makeNode()}
				selectedAgent={null}
				onSelectAgent={() => {}}

				onToggle={() => {}}
				events={[]}
				tasks={[]}
			/>,
		);
		expect(html).toContain('data-agent-id="root"');
	});

	test("renders session summary when status is 'idle'", () => {
		const html = renderToStaticMarkup(
			<Sidebar
				status={makeStatus({ status: "idle", turns: 5 })}
				tree={makeNode()}
				selectedAgent={null}
				onSelectAgent={() => {}}

				onToggle={() => {}}
				events={[]}
				tasks={[]}
			/>,
		);
		// Should show summary, not agent tree nodes
		expect(html).toContain("5");
		expect(html).not.toContain('data-agent-id="root"');
	});

	test("renders AgentTree when idle but tree has children, even if completed descendants start collapsed", () => {
		const tree = makeNode({
			status: "completed",
			children: [
				makeNode({
					agentId: "child-1",
					agentName: "editor",
					depth: 1,
					status: "completed",
					goal: "Edit file",
				}),
			],
		});
		const html = renderToStaticMarkup(
			<Sidebar
				status={makeStatus({ status: "idle" })}
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				onToggle={() => {}}
				events={[]}
				tasks={[]}
			/>,
		);
		// Should show tree even though idle, because tree has children
		expect(html).toContain('data-agent-id="root"');
		expect(html).not.toContain('data-agent-id="child-1"');
	});
});

// --- SidebarSessionSummary ---

describe("SidebarSessionSummary", () => {
	test("renders turn count", () => {
		const html = renderToStaticMarkup(
			<SidebarSessionSummary
				status={makeStatus({ turns: 12 })}
				events={[]}
			/>,
		);
		expect(html).toContain("12");
	});

	test("renders model name", () => {
		const html = renderToStaticMarkup(
			<SidebarSessionSummary
				status={makeStatus({ model: "claude-sonnet-4-20250514" })}
				events={[]}
			/>,
		);
		expect(html).toContain("claude-sonnet-4-20250514");
	});

	test("renders session ID", () => {
		const html = renderToStaticMarkup(
			<SidebarSessionSummary
				status={makeStatus({ sessionId: "sess-abc-123" })}
				events={[]}
			/>,
		);
		expect(html).toContain("sess-abc-123");
	});

	test("renders files touched from events", () => {
		const events: SessionEvent[] = [
			makeFileEvent("edit_file", "/src/foo.ts"),
			makeFileEvent("write_file", "/src/bar.ts"),
			makeFileEvent("read_file", "/src/baz.ts"),
		];
		const html = renderToStaticMarkup(
			<SidebarSessionSummary
				status={makeStatus()}
				events={events}
			/>,
		);
		expect(html).toContain("/src/foo.ts");
		expect(html).toContain("/src/bar.ts");
		expect(html).toContain("/src/baz.ts");
	});

	test("deduplicates file paths", () => {
		const events: SessionEvent[] = [
			makeFileEvent("edit_file", "/src/foo.ts"),
			makeFileEvent("read_file", "/src/foo.ts"),
			makeFileEvent("write_file", "/src/foo.ts"),
		];
		const html = renderToStaticMarkup(
			<SidebarSessionSummary
				status={makeStatus()}
				events={events}
			/>,
		);
		// Count occurrences — should appear exactly once
		const matches = html.match(/\/src\/foo\.ts/g);
		expect(matches).toHaveLength(1);
	});

	test("ignores non-file primitives", () => {
		const events: SessionEvent[] = [
			{
				kind: "primitive_start",
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { name: "bash", args: { command: "ls" } },
			},
			makeFileEvent("edit_file", "/src/foo.ts"),
		];
		const html = renderToStaticMarkup(
			<SidebarSessionSummary
				status={makeStatus()}
				events={events}
			/>,
		);
		expect(html).toContain("/src/foo.ts");
		expect(html).not.toContain("bash");
	});
});
