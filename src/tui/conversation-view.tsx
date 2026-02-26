import { Box, Static } from "ink";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { SessionBus } from "../host/event-bus.ts";
import type { EventKind, SessionEvent } from "../kernel/types.ts";
import { renderEventComponent } from "./event-components.tsx";

interface StaticLine {
	id: number;
	node: ReactNode;
}

const TOOL_DETAIL_KINDS: Set<EventKind> = new Set([
	"primitive_start",
	"primitive_end",
	"act_start",
	"act_end",
]);

export interface ConversationViewProps {
	bus: SessionBus;
	/** Historical events to display before new events (for resume). */
	initialEvents?: SessionEvent[];
	/** When true, tool detail events (primitive_start/end, act_start/end) are hidden. */
	toolsCollapsed?: boolean;
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

/**
 * Track start times and compute duration for end events.
 * Mutates the provided Map to record start timestamps and remove them on match.
 */
function trackDuration(event: SessionEvent, startTimes: Map<string, number>): number | null {
	const key = durationKey(event);
	if (!key) return null;
	const isEnd = event.kind.endsWith("_end");
	if (!isEnd) {
		startTimes.set(key, event.timestamp);
		return null;
	}
	const startTime = startTimes.get(key);
	startTimes.delete(key);
	return startTime != null ? event.timestamp - startTime : null;
}

export function ConversationView({ bus, initialEvents, toolsCollapsed }: ConversationViewProps) {
	const nextId = useRef(0);
	const startTimes = useRef(new Map<string, number>());
	const toolsCollapsedRef = useRef(toolsCollapsed ?? false);

	// Keep ref in sync with prop for use inside event callback
	useEffect(() => {
		toolsCollapsedRef.current = toolsCollapsed ?? false;
	}, [toolsCollapsed]);

	const [committedLines, setCommittedLines] = useState<StaticLine[]>(() => {
		if (!initialEvents) return [];
		const initial: StaticLine[] = [];
		for (const event of initialEvents) {
			const durationMs = trackDuration(event, startTimes.current);
			const node = renderEventComponent(event, durationMs);
			if (node !== null) {
				initial.push({ id: nextId.current++, node });
			}
		}
		return initial;
	});

	useEffect(() => {
		return bus.onEvent((event: SessionEvent) => {
			if (event.kind === "session_clear") {
				startTimes.current.clear();
				const node = renderEventComponent(event, null);
				if (node !== null) {
					const id = nextId.current++;
					setCommittedLines((prev) => [...prev, { id, node }]);
				}
				return;
			}
			if (event.kind === "exit_hint") return;

			const durationMs = trackDuration(event, startTimes.current);
			const node = renderEventComponent(event, durationMs);
			if (node !== null) {
				if (toolsCollapsedRef.current && TOOL_DETAIL_KINDS.has(event.kind)) return;
				const id = nextId.current++;
				setCommittedLines((prev) => [...prev, { id, node }]);
			}
		});
	}, [bus]);

	return <Static items={committedLines}>{(line) => <Box key={line.id}>{line.node}</Box>}</Static>;
}
