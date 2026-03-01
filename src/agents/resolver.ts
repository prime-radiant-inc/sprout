import type { AgentSpec } from "../kernel/types.ts";
import type { AgentTreeEntry } from "./loader.ts";

export interface ResolvedDelegate {
	spec: AgentSpec;
	path: string;
}

/**
 * Resolve the full set of agents an agent can delegate to.
 *
 * Children are looked up by combining selfPath with each bare child name
 * to form the full tree key (e.g., "tech-lead" + "engineer" -> "tech-lead/engineer").
 * When selfPath is empty (root agent), bare child names are used as-is.
 *
 * Explicit agent refs are looked up directly as full tree paths.
 *
 * @param tree - The complete agent tree map (path -> entry)
 * @param selfName - This agent's name (excluded from results)
 * @param selfPath - This agent's path in the tree (empty string for root)
 * @param childNames - Bare child names from the tree entry's children array
 * @param agentRefs - Explicit agent paths from the spec's `agents` field
 * @returns Array of resolved delegates with specs and paths
 */
export function resolveAgentDelegates(
	tree: Map<string, AgentTreeEntry>,
	selfName: string,
	selfPath: string,
	childNames: string[],
	agentRefs: string[],
): ResolvedDelegate[] {
	const result: ResolvedDelegate[] = [];
	const seen = new Set<string>();

	// Auto-discovered children: build full path from selfPath + bare name
	for (const childName of childNames) {
		const childPath = selfPath ? `${selfPath}/${childName}` : childName;
		const entry = tree.get(childPath);
		if (!entry || entry.spec.name === selfName) continue;
		if (seen.has(entry.spec.name)) continue;
		seen.add(entry.spec.name);
		result.push({ spec: entry.spec, path: childPath });
	}

	// Explicit references from agents field (already full paths)
	for (const ref of agentRefs) {
		const entry = tree.get(ref);
		if (!entry || entry.spec.name === selfName) continue;
		if (seen.has(entry.spec.name)) continue;
		seen.add(entry.spec.name);
		result.push({ spec: entry.spec, path: ref });
	}

	return result;
}
