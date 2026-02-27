import type { SessionEvent } from "../../../src/kernel/types.ts";
import { type AgentTreeNode, getDescendantIds } from "../hooks/useAgentTree.ts";

export interface GroupedEvent {
	event: SessionEvent;
	isFirstInGroup: boolean;
	isLastInGroup: boolean;
	durationMs: number | null;
	streamingText?: string;
	agentName?: string;
}

/** Event kinds that are never displayed. */
const INVISIBLE_KINDS = new Set([
	"context_update",
	"exit_hint",
	"session_start",
	"session_end",
	"recall",
	"verify",
]);

/** Event kinds that can be grouped with consecutive events of the same kind + agent. */
const GROUPABLE_KINDS = new Set(["plan_end", "perceive"]);

/**
 * Build a key for matching start/end event pairs for duration tracking.
 * Returns null if the event isn't a start/end pair we track.
 */
function durationKey(event: SessionEvent): string | null {
	const { kind, agent_id, data } = event;
	switch (kind) {
		case "plan_start":
		case "plan_end":
			return `${agent_id}:plan`;
		case "primitive_start":
		case "primitive_end":
			return `${agent_id}:primitive:${data.name}`;
		case "act_start":
		case "act_end":
			return `${agent_id}:act:${data.agent_name}`;
		default:
			return null;
	}
}

/** Build a flat agentId-to-agentName map from the agent tree. */
function buildNameMap(node: AgentTreeNode): Map<string, string> {
	const map = new Map<string, string>();
	function walk(n: AgentTreeNode) {
		map.set(n.agentId, n.agentName);
		for (const child of n.children) walk(child);
	}
	walk(node);
	return map;
}

/**
 * Groups consecutive events from the same agent, inserting group boundaries
 * when the agent changes, event kind changes, a non-groupable event intervenes,
 * or >60 seconds pass between events.
 */
export function groupEvents(
	events: SessionEvent[],
	agentFilter?: string | null,
	tree?: AgentTreeNode,
): GroupedEvent[] {
	const allowedIds =
		agentFilter && tree ? getDescendantIds(tree, agentFilter) : null;
	const nameMap = tree ? buildNameMap(tree) : new Map<string, string>();
	const startTimes = new Map<string, number>();
	const streamBuffers = new Map<string, string>();
	const lastDeltaIdx = new Map<string, number>();
	const result: GroupedEvent[] = [];

	for (let i = 0; i < events.length; i++) {
		const event = events[i]!;

		// Duration tracking runs for all events (even filtered ones)
		// so that end events can find their start times.
		const key = durationKey(event);
		let durationMs: number | null = null;
		if (key) {
			const isEnd = event.kind.endsWith("_end");
			if (!isEnd) {
				startTimes.set(key, event.timestamp);
			} else {
				const startTime = startTimes.get(key);
				startTimes.delete(key);
				durationMs =
					startTime != null ? event.timestamp - startTime : null;
			}
		}

		// Accumulate streaming text for plan_delta events
		if (event.kind === "plan_delta") {
			const prev = streamBuffers.get(event.agent_id) ?? "";
			const text =
				typeof event.data.text === "string" ? event.data.text : "";
			streamBuffers.set(event.agent_id, prev + text);
		}
		if (event.kind === "plan_end" || event.kind === "plan_start") {
			streamBuffers.delete(event.agent_id);
			lastDeltaIdx.delete(event.agent_id);
		}

		// Apply agent filter (includes descendants)
		if (allowedIds && !allowedIds.has(event.agent_id)) continue;

		// Skip invisible events
		if (INVISIBLE_KINDS.has(event.kind)) continue;

		// Skip primitive_start (not displayed)
		if (event.kind === "primitive_start") continue;

		// Skip plan_start (not displayed)
		if (event.kind === "plan_start") continue;

		// Collapse plan_delta events: replace previous delta with latest accumulated text
		if (event.kind === "plan_delta") {
			const prevIdx = lastDeltaIdx.get(event.agent_id);
			const entry: GroupedEvent = {
				event,
				durationMs,
				isFirstInGroup: true,
				isLastInGroup: true,
				streamingText: streamBuffers.get(event.agent_id),
				agentName: nameMap.get(event.agent_id),
			};
			if (prevIdx !== undefined) {
				result[prevIdx] = entry;
			} else {
				lastDeltaIdx.set(event.agent_id, result.length);
				result.push(entry);
			}
			continue;
		}

		result.push({
			event,
			durationMs,
			isFirstInGroup: true,
			isLastInGroup: true,
			agentName: nameMap.get(event.agent_id),
		});
	}

	// Apply grouping metadata.
	// Walk result and mark consecutive groupable events of the same kind + agent.
	for (let i = 0; i < result.length; i++) {
		const curr = result[i]!;
		if (!GROUPABLE_KINDS.has(curr.event.kind)) continue;

		const next = result[i + 1];
		if (!next) continue;
		if (next.event.kind !== curr.event.kind) continue;
		if (next.event.agent_id !== curr.event.agent_id) continue;
		if (next.event.timestamp - curr.event.timestamp > 60_000) continue;

		// They belong to the same group
		curr.isLastInGroup = false;
		next.isFirstInGroup = false;
	}

	return result;
}
