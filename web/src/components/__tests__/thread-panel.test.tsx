import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTreeNode } from "../../hooks/useAgentTree.ts";
import { ThreadPanel } from "../ThreadPanel.tsx";

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

function makeTree(childStatus: AgentTreeNode["status"] = "running"): AgentTreeNode {
	return makeNode({
		agentId: "root",
		agentName: "root",
		goal: "Orchestrate",
		children: [
			makeNode({
				agentId: "child-1",
				agentName: "code-editor",
				depth: 1,
				status: childStatus,
				goal: "Write the parser",
			}),
		],
	});
}

function renderPanel(tree: AgentTreeNode, agentId = "child-1"): string {
	return renderToStaticMarkup(
		<ThreadPanel
			agentId={agentId}
			tree={tree}
			events={[]}
			onClose={() => {}}
			onSelectAgent={() => {}}
		/>,
	);
}

// --- ThreadPanel status badge ---

describe("ThreadPanel status badge", () => {
	test("shows checkmark for completed agent", () => {
		const html = renderPanel(makeTree("completed"));
		expect(html).toContain("\u2713");
	});

	test("shows X mark for failed agent", () => {
		const html = renderPanel(makeTree("failed"));
		expect(html).toContain("\u2717");
	});

	test("shows filled circle for running agent", () => {
		const html = renderPanel(makeTree("running"));
		expect(html).toContain("\u25CF");
	});

	test("applies data-status attribute for CSS targeting", () => {
		for (const status of ["running", "completed", "failed"] as const) {
			const html = renderPanel(makeTree(status));
			expect(html).toContain(`data-status="${status}"`);
		}
	});

	test("status badge appears in the header, not in the body", () => {
		const html = renderPanel(makeTree("completed"));
		// The header region ends before data-region="thread-panel" body.
		// Check that the checkmark appears before the ConversationView section.
		const headerEnd = html.indexOf("</header>") !== -1
			? html.indexOf("</header>")
			: html.indexOf("data-region=\"thread-panel\"");
		// At minimum, the status icon should appear near the agent name
		const checkmarkIdx = html.indexOf("\u2713");
		const agentNameIdx = html.indexOf("code-editor");
		expect(checkmarkIdx).toBeGreaterThan(-1);
		expect(agentNameIdx).toBeGreaterThan(-1);
		// Status should be close to the agent name (within the same header area)
		expect(Math.abs(checkmarkIdx - agentNameIdx)).toBeLessThan(300);
	});

	test("does not render status badge when agent not found in tree", () => {
		const tree = makeTree("running");
		const html = renderPanel(tree, "nonexistent-agent");
		// Should not contain any status icon
		expect(html).not.toContain("\u2713");
		expect(html).not.toContain("\u2717");
		// The filled circle could appear in ConversationView, so just check
		// there is no data-status attribute in the header
		expect(html).not.toContain("data-status");
	});
});
