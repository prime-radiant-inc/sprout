import { useMemo } from "react";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import { type AgentTreeNode, getDescendantIds } from "./useAgentTree.ts";

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
}

/**
 * Format a number compactly: under 1000 as-is, 1000+ as "1.2k".
 */
export function formatCompactNumber(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	const fixed = k.toFixed(1);
	const formatted = fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
	return `${formatted}k`;
}

/**
 * Aggregate token usage for an agent and all its descendants.
 *
 * Scans plan_end events whose agent_id is in the descendant set,
 * summing input_tokens and output_tokens from data.usage.
 * Returns null if the agent isn't found or no usage data exists.
 */
export function aggregateTokenUsage(
	events: SessionEvent[],
	tree: AgentTreeNode,
	agentId: string,
): TokenUsage | null {
	const ids = getDescendantIds(tree, agentId);
	if (!ids) return null;

	let inputTokens = 0;
	let outputTokens = 0;
	let found = false;

	for (const event of events) {
		if (event.kind !== "plan_end") continue;
		if (!ids.has(event.agent_id)) continue;

		const usage = event.data.usage;
		if (typeof usage !== "object" || usage == null) continue;

		const u = usage as Record<string, unknown>;
		if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") continue;

		inputTokens += u.input_tokens;
		outputTokens += u.output_tokens;
		found = true;
	}

	return found ? { inputTokens, outputTokens } : null;
}

/**
 * React hook that computes aggregated token usage for an agent.
 */
export function useTokenUsage(
	events: SessionEvent[],
	tree: AgentTreeNode,
	agentId: string,
): TokenUsage | null {
	return useMemo(
		() => aggregateTokenUsage(events, tree, agentId),
		[events, tree, agentId],
	);
}
