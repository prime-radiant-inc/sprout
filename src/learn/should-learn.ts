import type { LearnSignal } from "../kernel/types.ts";
import type { MetricsStore } from "./metrics-store.ts";

/** Determine whether a LearnSignal warrants a learning response. */
export async function shouldLearn(
	signal: LearnSignal,
	metrics: MetricsStore,
	recentImprovements?: Set<string>,
): Promise<boolean> {
	const count = metrics.stumbleCount(signal.agent_name, signal.kind);

	// Failures always warrant learning — the goal was not achieved
	if (signal.kind === "failure") return true;

	// Skip if a recent improvement already addresses this agent+kind
	if (recentImprovements?.has(`${signal.agent_name}:${signal.kind}`)) return false;

	// Skip one-off errors (fewer than 2 occurrences)
	if (signal.kind === "error" && count < 2) return false;

	// Repeated stumbles of any kind trigger learning
	if (count >= 3) return true;

	return false;
}
