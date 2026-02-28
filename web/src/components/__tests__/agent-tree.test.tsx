import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTreeNode } from "../../hooks/useAgentTree.ts";
import { AgentTree } from "../AgentTree.tsx";

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

	test("shows full goal text without truncation", () => {
		const longGoal = "A".repeat(100);
		const tree = makeNode({ goal: longGoal });
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("A".repeat(100));
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

	test("shows goal text of any length without truncation", () => {
		const goal61 = "a".repeat(61);
		const tree = makeNode({ goal: goal61 });
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain(goal61);
		expect(html).not.toContain("...");
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

	test("renders disclosure triangles for nodes with children", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Root and editor-1 have children, so they should have disclosure triangles
		expect(html).toContain("data-disclosure");
	});

	test("leaf nodes render spacer instead of disclosure triangle", () => {
		// A tree where root has one child (leaf node with no children)
		const tree = makeNode({
			children: [
				makeNode({
					agentId: "leaf-1",
					agentName: "leaf",
					depth: 1,
					status: "completed",
					goal: "Do something",
					children: [],
				}),
			],
		});
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Root has children => disclosure triangle
		expect(html).toContain("data-disclosure");
		// The leaf-1 agent should NOT have a disclosure button
		// Extract the leaf node's row by finding its data-agent-id
		const leafIdx = html.indexOf('data-agent-id="leaf-1"');
		expect(leafIdx).toBeGreaterThan(-1);
		// The leaf's containing <li> should not have data-disclosure
		// Look backwards from the leaf's agent-id to find its row start
		const leafSection = html.slice(Math.max(0, leafIdx - 200), leafIdx);
		expect(leafSection).not.toContain("data-disclosure");
	});

	test("disclosure triangles default to expanded", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Default expanded state should show open disclosure
		expect(html).toContain('data-disclosure="open"');
	});

	test("children are rendered inside a nodeRow wrapper", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Each node should have its disclosure/spacer and button in a row div
		// The disclosure button and the node button should be siblings in the same container
		// Verify that data-disclosure and data-agent-id appear close together (same row)
		const disclosureIdx = html.indexOf("data-disclosure");
		const nextAgentIdIdx = html.indexOf("data-agent-id", disclosureIdx);
		// They should be within the same row, not far apart
		expect(nextAgentIdIdx - disclosureIdx).toBeLessThan(500);
	});
});

