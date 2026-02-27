import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTreeNode } from "../../hooks/useAgentTree.ts";
import { AgentTree } from "../AgentTree.tsx";
import { Breadcrumb } from "../Breadcrumb.tsx";

// --- Helpers ---

function makeNode(
	overrides: Partial<AgentTreeNode> = {},
): AgentTreeNode {
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

function makeTree(): AgentTreeNode {
	return makeNode({
		agentId: "root",
		agentName: "root",
		goal: "Orchestrate the build",
		status: "running",
		children: [
			makeNode({
				agentId: "editor-1",
				agentName: "code-editor",
				depth: 1,
				status: "completed",
				goal: "Write the parser",
				children: [
					makeNode({
						agentId: "runner-1",
						agentName: "test-runner",
						depth: 2,
						status: "completed",
						goal: "Run unit tests",
					}),
				],
			}),
			makeNode({
				agentId: "editor-2",
				agentName: "code-editor",
				depth: 1,
				status: "failed",
				goal: "Refactor the formatter",
			}),
			makeNode({
				agentId: "reader-1",
				agentName: "code-reader",
				depth: 1,
				status: "running",
				goal: "Analyze dependencies",
			}),
		],
	});
}

// --- AgentTree ---

describe("AgentTree", () => {
	test("renders all agent names in the tree", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("root");
		expect(html).toContain("code-editor");
		expect(html).toContain("test-runner");
		expect(html).toContain("code-reader");
	});

	test("renders 'All agents' option at top", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("All agents");
	});

	test("renders nested structure with depth-based nesting", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// The tree should have nested <ul> elements for children
		// Count <ul> tags — at minimum: root list + children of root + children of code-editor
		const ulCount = (html.match(/<ul/g) || []).length;
		expect(ulCount).toBeGreaterThanOrEqual(3);
	});

	test("shows checkmark for completed agents", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Completed status should show a checkmark
		expect(html).toContain("\u2713");
	});

	test("shows X for failed agents", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Failed status should show an X
		expect(html).toContain("\u2717");
	});

	test("shows pulsing indicator for running agents", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Running status should have data-status="running" for CSS animation targeting
		expect(html).toContain('data-status="running"');
	});

	test("marks selected agent with data-selected attribute", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent="editor-1"
				onSelectAgent={() => {}}
			/>,
		);
		expect(html).toContain('data-selected="true"');
	});

	test("each node has data-agent-id for click targeting", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain('data-agent-id="root"');
		expect(html).toContain('data-agent-id="editor-1"');
		expect(html).toContain('data-agent-id="editor-2"');
		expect(html).toContain('data-agent-id="reader-1"');
		expect(html).toContain('data-agent-id="runner-1"');
	});

	test("truncates long goals", () => {
		const longGoal = "A".repeat(100);
		const tree = makeNode({ goal: longGoal });
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("...");
		expect(html).not.toContain("A".repeat(100));
	});

	test("renders goal text for each node", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("Orchestrate the build");
		expect(html).toContain("Write the parser");
		expect(html).toContain("Run unit tests");
	});

	test("renders toggle button", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				onToggle={() => {}}
			/>,
		);
		// Toggle button should exist with a data attribute for identification
		expect(html).toContain('data-action="toggle"');
	});

	test("renders a single node tree", () => {
		const tree = makeNode();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("root");
		expect(html).toContain("Build the thing");
	});

	test("'All agents' has data-agent-id with null marker", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// "All agents" should have a way to clear the filter
		expect(html).toContain('data-agent-id="all"');
	});

	test("'All agents' is selected when selectedAgent is null", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// The "All agents" row should be marked as selected
		// We need to check that data-agent-id="all" and data-selected="true" are on the same element
		// Since renderToStaticMarkup gives us a flat string, we check the "all" item has selected
		const allAgentsSection = html.slice(
			html.indexOf('data-agent-id="all"'),
			html.indexOf('data-agent-id="all"') + 200,
		);
		expect(allAgentsSection).toContain('data-selected="true"');
	});

	test("does not render toggle button when onToggle omitted", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).not.toContain('data-action="toggle"');
	});

	test("truncates goal to exactly maxLen-1 characters plus ellipsis", () => {
		const goal61 = "a".repeat(61);
		const tree = makeNode({ goal: goal61 });
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// truncateGoal: goal.slice(0, 59) + "..." = 59 a's followed by ...
		const goalMatch = html.match(/(a+)\.\.\./);
		expect(goalMatch).toBeTruthy();
		expect(goalMatch![1]!.length).toBe(59);
	});

	test("does not truncate goal at exactly maxLen characters", () => {
		const goal60 = "b".repeat(60);
		const tree = makeNode({ goal: goal60 });
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain(goal60);
		expect(html).not.toContain("...");
	});
});

// --- Breadcrumb ---

describe("Breadcrumb", () => {
	test("renders nothing when no agent is selected", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<Breadcrumb tree={tree} selectedAgent={null} />,
		);
		expect(html).toBe("");
	});

	test("renders root name when root is selected", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<Breadcrumb tree={tree} selectedAgent="root" />,
		);
		expect(html).toContain("root");
	});

	test("renders full path for a depth-1 agent", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<Breadcrumb tree={tree} selectedAgent="editor-1" />,
		);
		expect(html).toContain("root");
		expect(html).toContain("code-editor");
	});

	test("renders full path for a depth-2 agent", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<Breadcrumb tree={tree} selectedAgent="runner-1" />,
		);
		expect(html).toContain("root");
		expect(html).toContain("code-editor");
		expect(html).toContain("test-runner");
	});

	test("uses separator between path segments", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<Breadcrumb tree={tree} selectedAgent="runner-1" />,
		);
		// Should have separators between segments
		expect(html).toContain("\u203A"); // single right-pointing angle quotation mark
	});

	test("renders nothing when agent is not found in tree", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<Breadcrumb tree={tree} selectedAgent="nonexistent" />,
		);
		expect(html).toBe("");
	});
});
