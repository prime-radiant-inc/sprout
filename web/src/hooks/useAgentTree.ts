import { useMemo } from "react";
import type { SessionEvent } from "../../../src/kernel/types.ts";

export interface AgentTreeNode {
	agentId: string;
	agentName: string;
	depth: number;
	status: "running" | "completed" | "failed";
	goal: string;
	/** Short label (≤10 words) for tree/headers; falls back to goal when absent */
	description?: string;
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

	// Disambiguate child nodes that share the same agent_name (legacy fallback).
	// Only used when child_id is absent. Not incremented for child_id events.
	const nameCounters = new Map<string, number>();

	// Index nodes by child_id for act_end lookup.
	const nodeById = new Map<string, AgentTreeNode>();

	for (const event of events) {
		// Derive root identity from the first depth-0 event
		if (event.depth === 0 && root.agentId === "root" && event.agent_id !== "root") {
			root.agentId = event.agent_id;
			// TODO: update root.agentName from event data once session_start includes agent_name
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
					root.status = event.data.success === false ? "failed" : "completed";
				}
				break;
			}

			case "act_start": {
				// act_start is emitted by the PARENT at the parent's depth.
				// The child's name is in data.agent_name.
				const childName = (event.data.agent_name as string) ?? event.agent_id;
				// Prefer child_id (ULID) if available; fall back to name-based disambiguation
				let childId: string;
				if (typeof event.data.child_id === "string") {
					childId = event.data.child_id;
				} else {
					const count = (nameCounters.get(childName) ?? 0) + 1;
					nameCounters.set(childName, count);
					childId = count === 1 ? childName : `${childName}#${count}`;
				}

				const childDepth = event.depth + 1;
				const node: AgentTreeNode = {
					agentId: childId,
					agentName: childName,
					depth: childDepth,
					status: "running",
					goal: (event.data.goal as string) ?? "",
					description: typeof event.data.description === "string" ? event.data.description : undefined,
					children: [],
				};
				startTimestamps.set(node, event.timestamp);

				// Parent is at the event's depth in the path
				const parent = path[event.depth];
				if (parent) {
					parent.children.push(node);
				}

				// Index by childId for act_end lookup
				nodeById.set(childId, node);

				// Record this child at its depth (and clear deeper entries)
				path[childDepth] = node;
				path.length = childDepth + 1;
				break;
			}

			case "act_end": {
				// Find node by child_id if available, otherwise fall back to path lookup
				let node: AgentTreeNode | undefined;
				if (typeof event.data.child_id === "string") {
					node = nodeById.get(event.data.child_id);
				} else {
					const childDepth = event.depth + 1;
					node = path[childDepth];
				}
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

export function findNode(node: AgentTreeNode, agentId: string): AgentTreeNode | null {
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
}

/**
 * React hook that builds an agent tree from session events.
 */
export function useAgentTree(events: SessionEvent[]): UseAgentTreeResult {
	const tree = useMemo(() => buildAgentTree(events), [events]);

	return { tree };
}
