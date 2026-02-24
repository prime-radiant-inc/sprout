import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { EventBus } from "../host/event-bus.ts";
import type { SessionEvent } from "../kernel/types.ts";
import { renderEvent } from "./render-event.ts";

interface Line {
	id: number;
	text: string;
}

export interface ConversationViewProps {
	bus: EventBus;
	/** Maximum number of lines to show. When exceeded, viewport scrolls. */
	maxHeight?: number;
}

export function ConversationView({ bus, maxHeight }: ConversationViewProps) {
	const [lines, setLines] = useState<Line[]>([]);
	const [scrollOffset, setScrollOffset] = useState<number | null>(null);
	const nextId = useRef(0);

	useEffect(() => {
		return bus.onEvent((event: SessionEvent) => {
			const text = renderEvent(event);
			if (text !== null) {
				const id = nextId.current++;
				setLines((prev) => [...prev, { id, text }]);
			}
		});
	}, [bus]);

	useInput((_input, key) => {
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

	let visible: Line[];
	if (!maxHeight) {
		visible = lines;
	} else if (scrollOffset === null) {
		visible = lines.slice(-maxHeight);
	} else {
		const start = Math.max(0, scrollOffset - maxHeight);
		visible = lines.slice(start, scrollOffset);
	}

	return (
		<Box flexDirection="column" flexGrow={1}>
			{visible.map((line) => (
				<Text key={line.id}>{line.text}</Text>
			))}
		</Box>
	);
}
