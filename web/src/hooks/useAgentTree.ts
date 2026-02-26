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
 * events at depth > 0.
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
	// path[0] is always root. path[1] is the most recent depth-1 act_start node, etc.
	const path: AgentTreeNode[] = [root];

	// Track start timestamps for durationMs computation.
	// Key: the node object reference (via a parallel array with act_start nodes).
	const startTimestamps = new Map<AgentTreeNode, number>();

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
				const node: AgentTreeNode = {
					agentId: event.agent_id,
					agentName: (event.data.agent_name as string) ?? event.agent_id,
					depth: event.depth,
					status: "running",
					goal: (event.data.goal as string) ?? "",
					children: [],
				};
				startTimestamps.set(node, event.timestamp);

				// Parent is at depth - 1 in the current path
				const parent = path[event.depth - 1];
				if (parent) {
					parent.children.push(node);
				}

				// Update path at this depth (and clear deeper entries)
				path[event.depth] = node;
				path.length = event.depth + 1;
				break;
			}

			case "act_end": {
				// Find the matching node — it's the current node at this depth in path
				const node = path[event.depth];
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
