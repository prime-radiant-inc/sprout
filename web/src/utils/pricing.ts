import type { AgentStats } from "../hooks/useAgentStats.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import { getDescendantIds } from "../hooks/useAgentTree.ts";
import {
	FALLBACK_PRICING_TABLE,
	longestPrefixMatch,
	withAnthropicCachePricing,
} from "@kernel/pricing.ts";
import type { ModelPricing, PricingTable } from "@kernel/pricing.ts";

export type { ModelPricing, PricingTable };

let activePricingTable: PricingTable | null = null;

/** Called when snapshot arrives with server-provided pricing. */
export function setPricingTable(table: PricingTable | null): void {
	activePricingTable = table;
}

/** Find pricing for a model name by longest prefix match. Returns null if no match. */
export function getModelPricing(model: string): ModelPricing | null {
	if (activePricingTable) {
		const result = longestPrefixMatch(model, activePricingTable);
		if (result) return withAnthropicCachePricing(undefined, model, result);
	}
	const fallback = longestPrefixMatch(model, FALLBACK_PRICING_TABLE);
	return fallback ? withAnthropicCachePricing(undefined, model, fallback) : null;
}

/** Compute dollar cost from token counts and model name. Returns null if model unknown. */
export function computeCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
	cacheWrite5mTokens = 0,
	cacheWrite1hTokens = 0,
): number | null {
	const pricing = getModelPricing(model);
	if (!pricing) return null;

	if (cacheReadTokens > 0 && pricing.cached_input === undefined) return null;
	if (cacheWrite5mTokens > 0 && pricing.cache_write_5m === undefined) return null;
	if (cacheWrite1hTokens > 0 && pricing.cache_write_1h === undefined) return null;

	const knownCacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens;
	if (cacheWriteTokens > knownCacheWriteTokens) return null;

	const inputCost =
		(inputTokens * pricing.input +
			cacheReadTokens * (pricing.cached_input ?? 0) +
			cacheWrite5mTokens * (pricing.cache_write_5m ?? 0) +
			cacheWrite1hTokens * (pricing.cache_write_1h ?? 0)) /
		1_000_000;
	const outputCost = (outputTokens * pricing.output) / 1_000_000;

	return inputCost + outputCost;
}

/**
 * Compute the total cost across a subtree by summing each agent's own cost
 * (using that agent's own model and token counts).
 */
export function computeSubtreeCost(
	tree: AgentTreeNode,
	agentId: string,
	agentStats: Map<string, AgentStats>,
): number | null {
	const ids = getDescendantIds(tree, agentId);
	if (!ids) return null;

	let total = 0;
	let found = false;

	for (const id of ids) {
		const stats = agentStats.get(id);
		if (!stats?.model) continue;
		if (
			stats.inputTokens === 0 &&
			stats.outputTokens === 0 &&
			stats.cacheReadTokens === 0 &&
			stats.cacheWriteTokens === 0
		) {
			continue;
		}
		const cost = computeCost(
			stats.model,
			stats.inputTokens,
			stats.outputTokens,
			stats.cacheReadTokens,
			stats.cacheWriteTokens,
			stats.cacheWrite5mTokens,
			stats.cacheWrite1hTokens,
		);
		if (cost != null) {
			total += cost;
			found = true;
		}
	}

	return found ? total : null;
}

/** Format a dollar amount for display: "$0.12", "$1.23", "$123" */
export function formatCost(dollars: number): string {
	if (dollars >= 100) return `$${Math.round(dollars)}`;
	return `$${dollars.toFixed(2)}`;
}
