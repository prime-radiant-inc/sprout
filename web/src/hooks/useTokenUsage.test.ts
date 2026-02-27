import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import { buildAgentTree } from "./useAgentTree.ts";
import { aggregateTokenUsage, formatCompactNumber } from "./useTokenUsage.ts";

// --- Helpers ---

let nextTs = 1000;

function makeEvent(
	kind: SessionEvent["kind"],
	agentId: string,
	depth: number,
	data: Record<string, unknown> = {},
): SessionEvent {
	return { kind, timestamp: nextTs++, agent_id: agentId, depth, data };
}

function resetTimestamps(): void {
	nextTs = 1000;
}

// --- formatCompactNumber ---

describe("formatCompactNumber", () => {
	test("returns number as-is below 1000", () => {
		expect(formatCompactNumber(0)).toBe("0");
		expect(formatCompactNumber(1)).toBe("1");
		expect(formatCompactNumber(42)).toBe("42");
		expect(formatCompactNumber(999)).toBe("999");
	});

	test("formats thousands with one decimal", () => {
		expect(formatCompactNumber(1000)).toBe("1k");
		expect(formatCompactNumber(1200)).toBe("1.2k");
		expect(formatCompactNumber(12500)).toBe("12.5k");
		expect(formatCompactNumber(999999)).toBe("1000k");
	});

	test("drops trailing .0 for even thousands", () => {
		expect(formatCompactNumber(2000)).toBe("2k");
		expect(formatCompactNumber(10000)).toBe("10k");
	});
});

// --- aggregateTokenUsage ---

describe("aggregateTokenUsage", () => {
	test("returns null when no plan_end events exist", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
		];
		const tree = buildAgentTree(events);

		expect(aggregateTokenUsage(events, tree, "child-1")).toBeNull();
	});

	test("sums tokens from a single plan_end event", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
			makeEvent("plan_end", "child-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
			}),
		];
		const tree = buildAgentTree(events);

		expect(aggregateTokenUsage(events, tree, "child-1")).toEqual({
			inputTokens: 500,
			outputTokens: 200,
		});
	});

	test("sums tokens across multiple plan_end events for same agent", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
			makeEvent("plan_end", "child-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
			}),
			makeEvent("plan_end", "child-1", 1, {
				usage: { input_tokens: 800, output_tokens: 300, total_tokens: 1100 },
			}),
		];
		const tree = buildAgentTree(events);

		expect(aggregateTokenUsage(events, tree, "child-1")).toEqual({
			inputTokens: 1300,
			outputTokens: 500,
		});
	});

	test("includes descendant agent tokens", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			// Root spawns parent-agent
			makeEvent("act_start", "root", 0, { agent_name: "parent", goal: "Plan", child_id: "parent-1" }),
			makeEvent("plan_end", "parent-1", 1, {
				usage: { input_tokens: 1000, output_tokens: 400, total_tokens: 1400 },
			}),
			// parent-agent spawns grandchild
			makeEvent("act_start", "parent-1", 1, { agent_name: "child", goal: "Execute", child_id: "grandchild-1" }),
			makeEvent("plan_end", "grandchild-1", 2, {
				usage: { input_tokens: 300, output_tokens: 100, total_tokens: 400 },
			}),
			makeEvent("act_end", "parent-1", 1, { agent_name: "child", child_id: "grandchild-1", success: true }),
			makeEvent("act_end", "root", 0, { agent_name: "parent", child_id: "parent-1", success: true }),
		];
		const tree = buildAgentTree(events);

		// Querying parent-1 should include grandchild-1's tokens too
		expect(aggregateTokenUsage(events, tree, "parent-1")).toEqual({
			inputTokens: 1300,
			outputTokens: 500,
		});
	});

	test("excludes tokens from sibling agents", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "agent-a" }),
			makeEvent("plan_end", "agent-a", 1, {
				usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
			}),
			makeEvent("act_end", "root", 0, { agent_name: "editor", child_id: "agent-a", success: true }),
			makeEvent("act_start", "root", 0, { agent_name: "runner", goal: "Run", child_id: "agent-b" }),
			makeEvent("plan_end", "agent-b", 1, {
				usage: { input_tokens: 1000, output_tokens: 800, total_tokens: 1800 },
			}),
			makeEvent("act_end", "root", 0, { agent_name: "runner", child_id: "agent-b", success: true }),
		];
		const tree = buildAgentTree(events);

		expect(aggregateTokenUsage(events, tree, "agent-a")).toEqual({
			inputTokens: 500,
			outputTokens: 200,
		});
		expect(aggregateTokenUsage(events, tree, "agent-b")).toEqual({
			inputTokens: 1000,
			outputTokens: 800,
		});
	});

	test("returns null when agent not found in tree", () => {
		resetTimestamps();
		const events = [makeEvent("perceive", "root", 0, { goal: "Work" })];
		const tree = buildAgentTree(events);

		expect(aggregateTokenUsage(events, tree, "nonexistent")).toBeNull();
	});

	test("returns null when plan_end events have no usage data", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
			makeEvent("plan_end", "child-1", 1, { text: "I will edit the file" }),
		];
		const tree = buildAgentTree(events);

		expect(aggregateTokenUsage(events, tree, "child-1")).toBeNull();
	});

	test("skips plan_end events with malformed usage data", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
			// Good usage
			makeEvent("plan_end", "child-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
			}),
			// Malformed: usage is a string instead of object
			makeEvent("plan_end", "child-1", 1, { usage: "bad" }),
		];
		const tree = buildAgentTree(events);

		expect(aggregateTokenUsage(events, tree, "child-1")).toEqual({
			inputTokens: 500,
			outputTokens: 200,
		});
	});
});
