import type { AgentSpec } from "../kernel/types.ts";
import type { AgentTreeEntry } from "./loader.ts";

export type DelegationSource = "tree_child" | "explicit_ref" | "resolved_path_fallback";

export interface DelegationInspection {
	agent_name: string;
	source: DelegationSource;
	requested_ref: string;
	resolved_path: string;
}

export interface InspectTreeDelegationsInput {
	tree: Map<string, AgentTreeEntry>;
	selfName: string;
	selfPath: string;
	childNames: string[];
	agentRefs: string[];
}

/**
 * Inspect tree-based delegation visibility and report where each delegate came from.
 * Order is deterministic: auto-discovered children first, then explicit refs.
 */
export function inspectTreeDelegations(
	input: InspectTreeDelegationsInput,
): DelegationInspection[] {
	const result: DelegationInspection[] = [];
	const seen = new Set<string>();

	for (const childName of input.childNames) {
		const childPath = input.selfPath ? `${input.selfPath}/${childName}` : childName;
		const entry = input.tree.get(childPath);
		if (!entry || entry.spec.name === input.selfName) continue;
		if (seen.has(entry.spec.name)) continue;
		seen.add(entry.spec.name);
		result.push({
			agent_name: entry.spec.name,
			source: "tree_child",
			requested_ref: childName,
			resolved_path: childPath,
		});
	}

	for (const ref of input.agentRefs) {
		const entry = input.tree.get(ref);
		if (!entry || entry.spec.name === input.selfName) continue;
		if (seen.has(entry.spec.name)) continue;
		seen.add(entry.spec.name);
		result.push({
			agent_name: entry.spec.name,
			source: "explicit_ref",
			requested_ref: ref,
			resolved_path: ref,
		});
	}

	return result;
}

export interface InspectStaticDelegationsInput {
	selfName: string;
	agentRefs: string[];
	availableAgents: AgentSpec[];
}

/**
 * Inspect non-tree delegation visibility using static refs and leaf-name fallback.
 * Order is deterministic based on the provided agentRefs array.
 */
export function inspectStaticDelegations(
	input: InspectStaticDelegationsInput,
): DelegationInspection[] {
	const result: DelegationInspection[] = [];
	const seen = new Set<string>();

	for (const ref of input.agentRefs) {
		const exact = input.availableAgents.find((a) => a.name === ref);
		if (exact && exact.name !== input.selfName && !seen.has(exact.name)) {
			seen.add(exact.name);
			result.push({
				agent_name: exact.name,
				source: "explicit_ref",
				requested_ref: ref,
				resolved_path: exact.name,
			});
			continue;
		}

		if (!ref.includes("/")) continue;
		const leaf = ref.split("/").pop();
		if (!leaf) continue;
		const fallback = input.availableAgents.find((a) => a.name === leaf);
		if (!fallback || fallback.name === input.selfName) continue;
		if (seen.has(fallback.name)) continue;
		seen.add(fallback.name);
		result.push({
			agent_name: fallback.name,
			source: "resolved_path_fallback",
			requested_ref: ref,
			resolved_path: fallback.name,
		});
	}

	return result;
}
