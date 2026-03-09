import { describe, expect, test } from "bun:test";
import { computeCost, computeSubtreeCost, formatCost, getModelPricing, setPricingTable } from "./pricing";
import type { AgentStats } from "../hooks/useAgentStats";
import type { AgentTreeNode } from "../hooks/useAgentTree";

describe("getModelPricing", () => {
	test("matches exact prefix", () => {
		const p = getModelPricing("o4-mini");
		expect(p).toEqual({ input: 1.1, output: 4.4 });
	});

	test("matches model with version suffix", () => {
		const p = getModelPricing("claude-sonnet-4-20250514");
		expect(p).toEqual({ input: 3, output: 15 });
	});

	test("returns null for unknown model", () => {
		expect(getModelPricing("unknown-model")).toBeNull();
	});

	test("matches longest prefix when multiple could match", () => {
		// "claude-sonnet-4" is longer than "claude-" if we ever had a shorter prefix
		const p = getModelPricing("claude-sonnet-4-latest");
		expect(p).toEqual({ input: 3, output: 15 });
	});
});

describe("computeCost", () => {
	test("computes cost for known model", () => {
		// 1M input * $3/M + 500K output * $15/M = $3 + $7.50 = $10.50
		const cost = computeCost("claude-sonnet-4-20250514", 1_000_000, 500_000);
		expect(cost).toBeCloseTo(10.5);
	});

	test("returns 0 for zero tokens", () => {
		expect(computeCost("claude-sonnet-4", 0, 0)).toBe(0);
	});

	test("returns null for unknown model", () => {
		expect(computeCost("unknown-model", 1000, 1000)).toBeNull();
	});

	test("computes cost with cached tokens at reduced rates", () => {
		// 1M total input, 800K cached reads, 100K cache writes, 100K uncached
		// Uncached: 100K × $3/M = $0.30
		// Cache reads: 800K × $3/M × 0.10 = $0.24
		// Cache writes: 100K × $3/M × 0.25 = $0.075
		// Total input: $0.615
		// Output: 0
		const cost = computeCost("claude-sonnet-4-6", 1_000_000, 0, 800_000, 100_000);
		expect(cost).toBeCloseTo(0.615);
	});

	test("cache tokens default to zero (backward compatible)", () => {
		const cost = computeCost("claude-sonnet-4-20250514", 1_000_000, 500_000);
		expect(cost).toBeCloseTo(10.5);
	});
});

describe("formatCost", () => {
	test("formats sub-dollar amounts", () => {
		expect(formatCost(0.12)).toBe("$0.12");
	});

	test("formats dollar amounts with cents", () => {
		expect(formatCost(1.5)).toBe("$1.50");
	});

	test("formats large amounts without decimals", () => {
		expect(formatCost(150)).toBe("$150");
	});

	test("formats zero", () => {
		expect(formatCost(0)).toBe("$0.00");
	});

	test("rounds to 2 decimal places", () => {
		expect(formatCost(0.129)).toBe("$0.13");
	});
});

describe("computeSubtreeCost", () => {
	const makeStats = (model: string, inputTokens: number, outputTokens: number): AgentStats => ({
		agentId: "",
		depth: 0,
		state: "idle" as const,
		inputTokens,
		outputTokens,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		currentTurn: 0,
		llmCallStartedAt: null,
		streamingChunks: 0,
		model,
	});

	const makeNode = (agentId: string, children: AgentTreeNode[] = []): AgentTreeNode => ({
		agentId,
		agentName: agentId,
		depth: 0,
		status: "completed" as const,
		goal: "",
		children,
	});

	test("single agent returns its own cost", () => {
		const tree = makeNode("root");
		const stats = new Map([["root", makeStats("claude-sonnet-4-6", 1_000_000, 0)]]);
		expect(computeSubtreeCost(tree, "root", stats)).toBeCloseTo(3.0);
	});

	test("sums costs across agents with different models", () => {
		const tree = makeNode("root", [makeNode("child1"), makeNode("child2")]);
		const stats = new Map([
			["root", makeStats("claude-sonnet-4-6", 1_000_000, 0)],    // $3
			["child1", makeStats("claude-haiku-4-5", 1_000_000, 0)],   // $0.80
			["child2", makeStats("claude-haiku-4-5", 1_000_000, 0)],   // $0.80
		]);
		expect(computeSubtreeCost(tree, "root", stats)).toBeCloseTo(4.6);
	});

	test("skips agents with unknown models", () => {
		const tree = makeNode("root", [makeNode("child1")]);
		const stats = new Map([
			["root", makeStats("claude-sonnet-4-6", 1_000_000, 0)],    // $3
			["child1", makeStats("unknown-model", 1_000_000, 0)],      // null, skipped
		]);
		expect(computeSubtreeCost(tree, "root", stats)).toBeCloseTo(3.0);
	});

	test("returns null when agent not in tree", () => {
		const tree = makeNode("root");
		const stats = new Map([["root", makeStats("claude-sonnet-4-6", 1_000_000, 0)]]);
		expect(computeSubtreeCost(tree, "nonexistent", stats)).toBeNull();
	});

	test("returns null when no agents have token data", () => {
		const tree = makeNode("root", [makeNode("child1")]);
		const stats = new Map([
			["root", makeStats("claude-sonnet-4-6", 0, 0)],
			["child1", makeStats("claude-haiku-4-5", 0, 0)],
		]);
		expect(computeSubtreeCost(tree, "root", stats)).toBeNull();
	});
});

describe("setPricingTable", () => {
	test("server table provides pricing for getModelPricing", () => {
		setPricingTable([["my-custom-model", { input: 5, output: 25 }]]);
		expect(getModelPricing("my-custom-model-v2")).toEqual({ input: 5, output: 25 });
		setPricingTable(null);
	});

	test("null reverts to fallback behaviour", () => {
		setPricingTable([["claude-sonnet-4", { input: 99, output: 99 }]]);
		setPricingTable(null);
		const p = getModelPricing("claude-sonnet-4-20250514");
		// Should get fallback pricing, not server pricing
		expect(p).toEqual({ input: 3, output: 15 });
	});

	test("server table takes priority over fallback for matching models", () => {
		const serverTable: [string, { input: number; output: number }][] = [
			["claude-sonnet-4", { input: 3.5, output: 16 }],
		];
		setPricingTable(serverTable);
		const p = getModelPricing("claude-sonnet-4-20250514");
		expect(p).toEqual({ input: 3.5, output: 16 });
		// Falls back for non-matching models
		expect(getModelPricing("o4-mini-2025")).toEqual({ input: 1.1, output: 4.4 });
		setPricingTable(null);
	});
});
