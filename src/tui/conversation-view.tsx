import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { EventBus } from "../host/event-bus.ts";
import type { EventKind, SessionEvent } from "../kernel/types.ts";
import { renderEvent } from "./render-event.ts";

interface Line {
	id: number;
	text: string;
	kind: EventKind;
}

export const EVENT_COLORS: Partial<Record<EventKind, string>> = {
	error: "red",
	warning: "yellow",
	session_start: "green",
	session_end: "green",
	session_resume: "cyan",
	steering: "magenta",
	compaction: "cyan",
	interrupted: "red",
};

const TOOL_DETAIL_KINDS: Set<EventKind> = new Set(["primitive_end", "act_end"]);

export interface ConversationViewProps {
	bus: EventBus;
	/** Maximum number of lines to show. When exceeded, viewport scrolls. */
	maxHeight?: number;
}

export function ConversationView({ bus, maxHeight }: ConversationViewProps) {
	const [lines, setLines] = useState<Line[]>([]);
	const [scrollOffset, setScrollOffset] = useState<number | null>(null);
	const [toolsCollapsed, setToolsCollapsed] = useState(false);
	const nextId = useRef(0);

	useEffect(() => {
		return bus.onEvent((event: SessionEvent) => {
			const text = renderEvent(event);
			if (text !== null) {
				const id = nextId.current++;
				setLines((prev) => [...prev, { id, text, kind: event.kind }]);
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
			{visible.map((line) => {
				const color = EVENT_COLORS[line.kind];
				return (
					<Text key={line.id} color={color}>
						{line.text}
					</Text>
				);
			})}
		</Box>
	);
}
