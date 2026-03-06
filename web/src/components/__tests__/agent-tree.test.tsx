import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "@kernel/types.ts";
import type { AgentStats } from "../../hooks/useAgentStats.ts";
import type { AgentTreeNode } from "../../hooks/useAgentTree.ts";
import { buildAgentTree } from "../../hooks/useAgentTree.ts";
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

/** Variant with root completed — no hide-finished filtering applied. */
function makeCompletedTree(): AgentTreeNode {
	return { ...makeTree(), status: "completed" };
}

// --- AgentTree ---

describe("AgentTree", () => {
	test("renders all agent names in the tree", () => {
		const tree = makeCompletedTree();
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
		const tree = makeCompletedTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// The tree should have nested <ul> elements for children
		// Count <ul> tags — at minimum: root list + children of root + children of code-editor
		const ulCount = (html.match(/<ul/g) || []).length;
		expect(ulCount).toBeGreaterThanOrEqual(3);
	});

	test("shows checkmark for completed agents", () => {
		const tree = makeCompletedTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Completed status should show a checkmark
		expect(html).toContain("\u2713");
	});

	test("shows X for failed agents", () => {
		const tree = makeCompletedTree();
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
		const tree = makeCompletedTree();
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
		const tree = makeCompletedTree();
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
		const tree = makeCompletedTree();
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
			status: "completed",
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

	test("shows description instead of goal when description is set", () => {
		const tree = makeNode({
			children: [
				makeNode({
					agentId: "editor-1",
					agentName: "code-editor",
					depth: 1,
					status: "running",
					goal: "Read all TypeScript files in src/auth and summarize the authentication flow",
					description: "Analyze auth flow",
				}),
			],
		});
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("Analyze auth flow");
		expect(html).not.toContain("Read all TypeScript files");
	});

	test("falls back to goal when description is absent", () => {
		const tree = makeNode({
			children: [
				makeNode({
					agentId: "editor-1",
					agentName: "code-editor",
					depth: 1,
					status: "running",
					goal: "Write the parser",
				}),
			],
		});
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("Write the parser");
	});

	test("hides finished agents by default when root is running", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Root and running child should be visible
		expect(html).toContain('data-agent-id="root"');
		expect(html).toContain('data-agent-id="reader-1"');
		// Completed and failed children should be hidden
		expect(html).not.toContain('data-agent-id="editor-1"');
		expect(html).not.toContain('data-agent-id="editor-2"');
	});

	test("shows toggle button with finished count when root is running", () => {
		const tree = makeTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("Show 3 finished agents");
	});

	test("does not show toggle button when root is completed", () => {
		const tree = makeCompletedTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).not.toContain("finished agent");
	});

	test("does not show toggle button when no finished agents exist", () => {
		const tree = makeNode({
			status: "running",
			children: [
				makeNode({
					agentId: "child-1",
					agentName: "runner",
					depth: 1,
					status: "running",
					goal: "Run things",
				}),
			],
		});
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).not.toContain("finished agent");
	});

	test("shows all agents when root is completed (session done)", () => {
		const tree = makeCompletedTree();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain('data-agent-id="editor-1"');
		expect(html).toContain('data-agent-id="editor-2"');
		expect(html).toContain('data-agent-id="reader-1"');
		expect(html).toContain('data-agent-id="runner-1"');
	});

	test("toggle text uses singular when only one finished agent", () => {
		const tree = makeNode({
			status: "running",
			children: [
				makeNode({
					agentId: "child-1",
					agentName: "editor",
					depth: 1,
					status: "completed",
					goal: "Edit stuff",
				}),
			],
		});
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("Show 1 finished agent");
		expect(html).not.toContain("finished agents");
	});
});

describe("buildAgentTree", () => {
	function makeEvent(
		kind: string,
		data: Record<string, unknown>,
		overrides: Partial<SessionEvent> = {},
	): SessionEvent {
		return {
			kind: kind as SessionEvent["kind"],
			agent_id: "root-agent",
			depth: 0,
			timestamp: Date.now(),
			data,
			...overrides,
		} as SessionEvent;
	}

	test("extracts description from act_start event", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", { goal: "Go" }, { agent_id: "root-agent", depth: 0 }),
			makeEvent(
				"act_start",
				{
					agent_name: "code-reader",
					goal: "Read all TypeScript files in src/auth and summarize the authentication flow",
					description: "Analyze auth flow",
					child_id: "CID1",
				},
				{ agent_id: "root-agent", depth: 0 },
			),
		];
		const tree = buildAgentTree(events);
		const child = tree.children[0]!;
		expect(child.agentName).toBe("code-reader");
		expect(child.description).toBe("Analyze auth flow");
		expect(child.goal).toBe("Read all TypeScript files in src/auth and summarize the authentication flow");
	});

	test("description is undefined when not in event data", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", { goal: "Go" }, { agent_id: "root-agent", depth: 0 }),
			makeEvent(
				"act_start",
				{ agent_name: "code-reader", goal: "Find code", child_id: "CID1" },
				{ agent_id: "root-agent", depth: 0 },
			),
		];
		const tree = buildAgentTree(events);
		expect(tree.children[0]!.description).toBeUndefined();
	});
});

// --- Agent stats rendering tests ---

function makeStats(overrides: Partial<AgentStats> = {}): AgentStats {
	return {
		agentId: "root",
		depth: 0,
		state: "idle",
		inputTokens: 0,
		outputTokens: 0,
		currentTurn: 0,
		llmCallStartedAt: null,
		streamingChunks: 0,
		model: "",
		...overrides,
	};
}

describe("AgentTree with stats", () => {
	test("renders agent state when stats are provided", () => {
		const tree = makeNode({ agentId: "root", status: "running" });
		const agentStats = new Map<string, AgentStats>([
			["root", makeStats({ agentId: "root", state: "calling_llm" })],
		]);
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				agentStats={agentStats}
			/>,
		);
		expect(html).toContain("data-agent-state");
		expect(html).toContain("Calling LLM");
	});

	test("renders token counts when stats have token data", () => {
		const tree = makeNode({ agentId: "root", status: "running" });
		const agentStats = new Map<string, AgentStats>([
			["root", makeStats({ agentId: "root", inputTokens: 1500, outputTokens: 300 })],
		]);
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				agentStats={agentStats}
			/>,
		);
		expect(html).toContain("1.5k");
		expect(html).toContain("300");
	});

	test("renders turn number when stats have turn data", () => {
		const tree = makeNode({ agentId: "root", status: "running" });
		const agentStats = new Map<string, AgentStats>([
			["root", makeStats({ agentId: "root", currentTurn: 3 })],
		]);
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				agentStats={agentStats}
			/>,
		);
		expect(html).toContain("T3");
	});

	test("does not render stats section when no stats available for agent", () => {
		const tree = makeNode({ agentId: "root", status: "running" });
		const emptyStats = new Map<string, AgentStats>();
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				agentStats={emptyStats}
			/>,
		);
		expect(html).not.toContain("data-agent-state");
	});

	test("renders stats for child agents", () => {
		const tree = makeNode({
			agentId: "root",
			status: "running",
			children: [
				makeNode({
					agentId: "child-1",
					agentName: "editor",
					depth: 1,
					status: "running",
					goal: "Edit code",
				}),
			],
		});
		const agentStats = new Map<string, AgentStats>([
			["root", makeStats({ agentId: "root", state: "delegating" })],
			["child-1", makeStats({ agentId: "child-1", state: "executing_tool", currentTurn: 2, inputTokens: 800, outputTokens: 120 })],
		]);
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				agentStats={agentStats}
			/>,
		);
		expect(html).toContain("Delegating");
		expect(html).toContain("Executing tool");
	});

	test("renders without stats prop (backward compatible)", () => {
		const tree = makeNode();
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// Should render normally without any stats-related elements
		expect(html).toContain("root");
		expect(html).not.toContain("data-agent-state");
	});

	test("does not render stats line for idle agents with no tokens", () => {
		const tree = makeNode({ agentId: "root", status: "running" });
		const agentStats = new Map<string, AgentStats>([
			["root", makeStats({ agentId: "root", state: "idle", inputTokens: 0, outputTokens: 0, currentTurn: 0 })],
		]);
		const html = renderToStaticMarkup(
			<AgentTree
				tree={tree}
				selectedAgent={null}
				onSelectAgent={() => {}}
				agentStats={agentStats}
			/>,
		);
		// Idle with no activity — no stats line needed
		expect(html).not.toContain("data-agent-state");
	});
});

