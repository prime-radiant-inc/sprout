import { useMemo, useState } from "react";
import type { SessionEvent } from "../../../src/kernel/types.ts";

export interface AgentTreeNode {
	agentId: string;
	agentName: string;
	depth: number;
	status: "running" | "completed" | "failed";
	goal: string;
	children: AgentTreeNode[];
	turns?: number;
	durationMs?: number;
}

/**
 * Build an agent tree from a list of session events.
 *
 * Scans for act_start/act_end pairs to construct parent-child relationships.
 * Root node is derived from depth-0 events. Child nodes come from act_start
 * events, which are emitted by the *parent* agent (so event.agent_id is the
 * parent and event.depth is the parent's depth).
 */
export function buildAgentTree(events: SessionEvent[]): AgentTreeNode {
	const root: AgentTreeNode = {
		agentId: "root",
		agentName: "root",
		depth: 0,
		status: "running",
		goal: "",
		children: [],
	};

	// Track the "current path" — the most recently active node at each depth.
	// path[0] is always root. path[1] is the most recent depth-1 child, etc.
	const path: AgentTreeNode[] = [root];

	// Track start timestamps for durationMs computation.
	const startTimestamps = new Map<AgentTreeNode, number>();

	// Disambiguate child nodes that share the same agent_name.
	// Key: agent_name, value: count seen so far.
	const nameCounters = new Map<string, number>();

	for (const event of events) {
		// Derive root identity from the first depth-0 event
		if (event.depth === 0 && root.agentId === "root" && event.agent_id !== "root") {
			root.agentId = event.agent_id;
		}

		switch (event.kind) {
			case "perceive": {
				if (event.depth === 0 && !root.goal) {
					root.goal = (event.data.goal as string) ?? "";
				}
				break;
			}

			case "session_end": {
				if (event.depth === 0) {
					root.status = "completed";
				}
				break;
			}

			case "act_start": {
				// act_start is emitted by the PARENT at the parent's depth.
				// The child's name is in data.agent_name.
				const childName = (event.data.agent_name as string) ?? event.agent_id;
				const count = (nameCounters.get(childName) ?? 0) + 1;
				nameCounters.set(childName, count);
				// Use a unique agentId: "name" for first instance, "name#2" for second, etc.
				const childId = count === 1 ? childName : `${childName}#${count}`;

				const childDepth = event.depth + 1;
				const node: AgentTreeNode = {
					agentId: childId,
					agentName: childName,
					depth: childDepth,
					status: "running",
					goal: (event.data.goal as string) ?? "",
					children: [],
				};
				startTimestamps.set(node, event.timestamp);

				// Parent is at the event's depth in the path
				const parent = path[event.depth];
				if (parent) {
					parent.children.push(node);
				}

				// Record this child at its depth (and clear deeper entries)
				path[childDepth] = node;
				path.length = childDepth + 1;
				break;
			}

			case "act_end": {
				// act_end is also emitted by the parent at the parent's depth.
				// The matching child node is at depth + 1 in the path.
				const childDepth = event.depth + 1;
				const node = path[childDepth];
				if (node && node !== root) {
					node.status = (event.data.success as boolean) ? "completed" : "failed";
					const turns = event.data.turns as number | undefined;
					if (turns !== undefined) {
						node.turns = turns;
					}
					const startTs = startTimestamps.get(node);
					if (startTs !== undefined) {
						node.durationMs = event.timestamp - startTs;
					}
				}
				break;
			}
		}
	}

	return root;
}

/**
 * Given a tree and a target agentId, return a Set of agentIds
 * for that agent and all its descendants. Returns null if not found.
 */
export function getDescendantIds(tree: AgentTreeNode, agentId: string): Set<string> | null {
	const node = findNode(tree, agentId);
	if (!node) return null;
	const ids = new Set<string>();
	collectIds(node, ids);
	return ids;
}

function findNode(node: AgentTreeNode, agentId: string): AgentTreeNode | null {
	if (node.agentId === agentId) return node;
	for (const child of node.children) {
		const found = findNode(child, agentId);
		if (found) return found;
	}
	return null;
}

function collectIds(node: AgentTreeNode, ids: Set<string>): void {
	ids.add(node.agentId);
	for (const child of node.children) {
		collectIds(child, ids);
	}
}

// --- React hook ---

interface UseAgentTreeResult {
	tree: AgentTreeNode;
	selectedAgent: string | null;
	setSelectedAgent: (agentId: string | null) => void;
}

/**
 * React hook that builds an agent tree from session events
 * and manages the selected agent state.
 */
export function useAgentTree(events: SessionEvent[]): UseAgentTreeResult {
	const tree = useMemo(() => buildAgentTree(events), [events]);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

	return { tree, selectedAgent, setSelectedAgent };
}
