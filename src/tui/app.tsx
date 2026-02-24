import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { EventBus } from "../host/event-bus.ts";
import type { SessionEvent } from "../kernel/types.ts";
import { renderEvent } from "./render-event.ts";

interface Line {
	id: number;
	text: string;
}

interface AppProps {
	bus: EventBus;
	sessionId: string;
}

export function App({ bus, sessionId: _sessionId }: AppProps) {
	const [lines, setLines] = useState<Line[]>([]);
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

	return (
		<Box flexDirection="column">
			<Box flexDirection="column" flexGrow={1}>
				{lines.map((line) => (
					<Text key={line.id}>{line.text}</Text>
				))}
			</Box>
		</Box>
	);
}
