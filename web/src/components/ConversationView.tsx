import { useMemo } from "react";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import { type AgentTreeNode, getDescendantIds } from "../hooks/useAgentTree.ts";
import { EventLine } from "./EventLine.tsx";
import styles from "./ConversationView.module.css";

interface ConversationViewProps {
	events: SessionEvent[];
	/** When set, only show events from this agent and its descendants. */
	agentFilter?: string | null;
	/** Agent tree for descendant resolution. */
	tree: AgentTreeNode;
}

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

interface ResolvedEvent {
	event: SessionEvent;
	durationMs: number | null;
	key: number;
	streamingText?: string;
}

/** Resolve events with duration tracking. */
function resolveEvents(
	events: SessionEvent[],
	agentFilter: string | null | undefined,
	tree: AgentTreeNode,
): ResolvedEvent[] {
	const allowedIds = agentFilter ? getDescendantIds(tree, agentFilter) : null;
	const startTimes = new Map<string, number>();
	const resolved: ResolvedEvent[] = [];
	const streamBuffers = new Map<string, string>();
	const lastDeltaIdx = new Map<string, number>();

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
			const text = typeof event.data.text === "string" ? event.data.text : "";
			streamBuffers.set(event.agent_id, prev + text);
		}
		if (event.kind === "plan_end" || event.kind === "plan_start") {
			streamBuffers.delete(event.agent_id);
			lastDeltaIdx.delete(event.agent_id);
		}

		// Apply agent filter (includes descendants)
		if (allowedIds && !allowedIds.has(event.agent_id)) continue;

		// Collapse plan_delta events: replace previous delta with latest accumulated text
		if (event.kind === "plan_delta") {
			const prevIdx = lastDeltaIdx.get(event.agent_id);
			const entry = { event, durationMs, key: i, streamingText: streamBuffers.get(event.agent_id) };
			if (prevIdx !== undefined) {
				resolved[prevIdx] = entry;
			} else {
				lastDeltaIdx.set(event.agent_id, resolved.length);
				resolved.push(entry);
			}
			continue;
		}

		resolved.push({ event, durationMs, key: i });
	}

	return resolved;
}

/** Scrollable list of rendered session events. */
export function ConversationView({
	events,
	agentFilter,
	tree,
}: ConversationViewProps) {
	const resolved = useMemo(
		() => resolveEvents(events, agentFilter, tree),
		[events, agentFilter, tree],
	);

	return (
		<div className={styles.conversationView}>
			{resolved.map(({ event, durationMs, key, streamingText }) => (
				<EventLine key={key} event={event} durationMs={durationMs} streamingText={streamingText} />
			))}
		</div>
	);
}
