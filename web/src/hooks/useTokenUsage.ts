import { useMemo } from "react";
import type { SessionEvent } from "@kernel/types.ts";
import { type AgentTreeNode, getDescendantIds } from "./useAgentTree.ts";

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	contextTokens: number | null;
	contextWindowSize: number | null;
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
	let contextTokens: number | null = null;
	let contextWindowSize: number | null = null;

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

		// Track context window data for the specific agent only (not descendants)
		if (event.agent_id === agentId) {
			if (typeof event.data.context_tokens === "number") {
				contextTokens = event.data.context_tokens;
			}
			if (typeof event.data.context_window_size === "number") {
				contextWindowSize = event.data.context_window_size;
			}
		}
	}

	return found ? { inputTokens, outputTokens, contextTokens, contextWindowSize } : null;
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

export interface ContextPressure {
	contextTokens: number;
	contextWindowSize: number;
	percent: number;
}

export function buildContextPressureMap(events: SessionEvent[]): Map<string, ContextPressure> {
	const map = new Map<string, ContextPressure>();
	for (const event of events) {
		if (event.kind !== "plan_end") continue;
		const ct = event.data.context_tokens;
		const cws = event.data.context_window_size;
		if (typeof ct !== "number" || typeof cws !== "number" || cws === 0) continue;
		map.set(event.agent_id, {
			contextTokens: ct,
			contextWindowSize: cws,
			percent: Math.round((ct / cws) * 100),
		});
	}
	return map;
}

export function useContextPressure(events: SessionEvent[]): Map<string, ContextPressure> {
	return useMemo(() => buildContextPressureMap(events), [events]);
}
