import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "@kernel/types.ts";
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
			agentStats={new Map()}
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

// --- ThreadPanel token usage ---

function renderPanelWithEvents(
	tree: AgentTreeNode,
	events: SessionEvent[],
	agentId = "child-1",
): string {
	return renderToStaticMarkup(
		<ThreadPanel
			agentId={agentId}
			tree={tree}
			events={events}
			agentStats={new Map()}
			onClose={() => {}}
			onSelectAgent={() => {}}
		/>,
	);
}

describe("ThreadPanel token usage", () => {
	test("displays token usage when plan_end events have usage data", () => {
		const tree = makeTree("completed");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: { usage: { input_tokens: 1200, output_tokens: 800, total_tokens: 2000 } },
			},
		];
		const html = renderPanelWithEvents(tree, events);
		expect(html).toContain("data-testid=\"token-usage\"");
		expect(html).toContain("1.2k in");
		expect(html).toContain("800 out");
	});

	test("does not display token usage when no usage data exists", () => {
		const tree = makeTree("running");
		const html = renderPanelWithEvents(tree, []);
		expect(html).not.toContain("data-testid=\"token-usage\"");
	});

	test("aggregates tokens across multiple plan_end events", () => {
		const tree = makeTree("completed");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: { usage: { input_tokens: 5000, output_tokens: 2000, total_tokens: 7000 } },
			},
			{
				kind: "plan_end",
				timestamp: 2000,
				agent_id: "child-1",
				depth: 1,
				data: { usage: { input_tokens: 7500, output_tokens: 3000, total_tokens: 10500 } },
			},
		];
		const html = renderPanelWithEvents(tree, events);
		// 5000 + 7500 = 12500 -> "12.5k in"
		expect(html).toContain("12.5k in");
		// 2000 + 3000 = 5000 -> "5k out"
		expect(html).toContain("5k out");
	});
});

// --- ThreadPanel context pressure ---

describe("ThreadPanel context pressure", () => {
	test("shows pressure bar when contextTokens and contextWindowSize are available", () => {
		const tree = makeTree("running");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: {
					usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
					context_tokens: 80000,
					context_window_size: 200000,
				},
			},
		];
		const html = renderPanelWithEvents(tree, events);
		expect(html).toContain("data-testid=\"context-pressure\"");
		// 80000 / 200000 = 40%
		expect(html).toContain("40%");
	});

	test("does not show pressure bar when contextTokens is null", () => {
		const tree = makeTree("running");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: { usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 } },
			},
		];
		const html = renderPanelWithEvents(tree, events);
		expect(html).not.toContain("data-testid=\"context-pressure\"");
	});

	test("applies success color when pressure is below 60%", () => {
		const tree = makeTree("running");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: {
					usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
					context_tokens: 50000,
					context_window_size: 200000,
				},
			},
		];
		const html = renderPanelWithEvents(tree, events);
		// 25% -> success
		expect(html).toContain("var(--color-success)");
	});

	test("applies warning color when pressure is between 60% and 84%", () => {
		const tree = makeTree("running");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: {
					usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
					context_tokens: 140000,
					context_window_size: 200000,
				},
			},
		];
		const html = renderPanelWithEvents(tree, events);
		// 70% -> warning
		expect(html).toContain("var(--color-warning)");
	});

	test("applies error color when pressure is 85% or above", () => {
		const tree = makeTree("running");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: {
					usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
					context_tokens: 180000,
					context_window_size: 200000,
				},
			},
		];
		const html = renderPanelWithEvents(tree, events);
		// 90% -> error
		expect(html).toContain("var(--color-error)");
	});

	test("wraps pressure and token usage in headerStats container", () => {
		const tree = makeTree("running");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: {
					usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
					context_tokens: 80000,
					context_window_size: 200000,
				},
			},
		];
		const html = renderPanelWithEvents(tree, events);
		expect(html).toContain("data-testid=\"header-stats\"");
		// Both should be present
		expect(html).toContain("data-testid=\"context-pressure\"");
		expect(html).toContain("data-testid=\"token-usage\"");
	});

	test("token usage still wrapped in headerStats even without pressure data", () => {
		const tree = makeTree("completed");
		const events: SessionEvent[] = [
			{
				kind: "plan_end",
				timestamp: 1000,
				agent_id: "child-1",
				depth: 1,
				data: { usage: { input_tokens: 1200, output_tokens: 800, total_tokens: 2000 } },
			},
		];
		const html = renderPanelWithEvents(tree, events);
		expect(html).toContain("data-testid=\"header-stats\"");
		expect(html).toContain("data-testid=\"token-usage\"");
		expect(html).not.toContain("data-testid=\"context-pressure\"");
	});
});
