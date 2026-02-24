import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { EventBus } from "../host/event-bus.ts";
import type { EventKind, SessionEvent } from "../kernel/types.ts";
import { renderEventComponent } from "./event-components.tsx";

interface Line {
	id: number;
	node: ReactNode;
	kind: EventKind;
}

const TOOL_DETAIL_KINDS: Set<EventKind> = new Set([
	"primitive_start",
	"primitive_end",
	"act_start",
	"act_end",
]);

export interface ConversationViewProps {
	bus: EventBus;
	/** Maximum number of lines to show. When exceeded, viewport scrolls. */
	maxHeight?: number;
	/** Historical events to display before new events (for resume). */
	initialEvents?: SessionEvent[];
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

export function ConversationView({ bus, maxHeight, initialEvents }: ConversationViewProps) {
	const nextId = useRef(0);
	const startTimes = useRef(new Map<string, number>());

	// Compute initial lines from initialEvents (runs once via lazy initializer)
	const [lines, setLines] = useState<Line[]>(() => {
		if (!initialEvents) return [];
		const initial: Line[] = [];
		for (const event of initialEvents) {
			const durationMs = trackDuration(event, startTimes.current);
			const node = renderEventComponent(event, durationMs);
			if (node !== null) {
				initial.push({ id: nextId.current++, node, kind: event.kind });
			}
		}
		return initial;
	});
	const [scrollOffset, setScrollOffset] = useState<number | null>(null);
	const [toolsCollapsed, setToolsCollapsed] = useState(false);

	useEffect(() => {
		return bus.onEvent((event: SessionEvent) => {
			if (event.kind === "session_clear") {
				setLines([]);
				setScrollOffset(null);
				startTimes.current.clear();
				return;
			}
			const durationMs = trackDuration(event, startTimes.current);
			const node = renderEventComponent(event, durationMs);
			if (node !== null) {
				const id = nextId.current++;
				setLines((prev) => [...prev, { id, node, kind: event.kind }]);
			}
		});
	}, [bus]);

	useInput((_input, key) => {
		if (key.tab) {
			setToolsCollapsed((prev) => !prev);
			return;
		}

		if (!maxHeight) return;

		if (key.pageUp) {
			setScrollOffset((prev) => {
				const current = prev ?? lines.length;
				return Math.max(maxHeight, current - maxHeight);
			});
		}

		if (key.pageDown) {
			setScrollOffset((prev) => {
				if (prev === null) return null;
				const next = prev + maxHeight;
				if (next >= lines.length) return null;
				return next;
			});
		}
	});

	const filtered = toolsCollapsed ? lines.filter((l) => !TOOL_DETAIL_KINDS.has(l.kind)) : lines;

	let visible: Line[];
	if (!maxHeight) {
		visible = filtered;
	} else if (scrollOffset === null) {
		visible = filtered.slice(-maxHeight);
	} else {
		const start = Math.max(0, scrollOffset - maxHeight);
		visible = filtered.slice(start, scrollOffset);
	}

	return (
		<Box flexDirection="column" flexGrow={1}>
			{visible.map((line) => (
				<Box key={line.id}>{line.node}</Box>
			))}
			{scrollOffset !== null && (
				<Text dimColor>-- SCROLL (PgDown to continue, PgDown past end to resume) --</Text>
			)}
		</Box>
	);
}
