import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { EventBus } from "../host/event-bus.ts";
import type { SessionEvent } from "../kernel/types.ts";
import { InputArea } from "./input-area.tsx";
import { renderEvent } from "./render-event.ts";
import type { SlashCommand } from "./slash-commands.ts";
import { StatusBar } from "./status-bar.tsx";

interface Line {
	id: number;
	text: string;
}

export interface AppProps {
	bus: EventBus;
	sessionId: string;
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void;
	onExit: () => void;
	initialHistory?: string[];
}

interface StatusState {
	contextTokens: number;
	contextWindowSize: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
	status: "idle" | "running" | "interrupted";
}

const INITIAL_STATUS: StatusState = {
	contextTokens: 0,
	contextWindowSize: 0,
	turns: 0,
	inputTokens: 0,
	outputTokens: 0,
	model: "",
	status: "idle",
};

export function App({ bus, sessionId, onSubmit, onSlashCommand, onExit, initialHistory }: AppProps) {
	const [lines, setLines] = useState<Line[]>([]);
	const [statusState, setStatusState] = useState<StatusState>(INITIAL_STATUS);
	const nextId = useRef(0);

	useEffect(() => {
		return bus.onEvent((event: SessionEvent) => {
			const text = renderEvent(event);
			if (text !== null) {
				const id = nextId.current++;
				setLines((prev) => [...prev, { id, text }]);
			}

			switch (event.kind) {
				case "session_start":
					setStatusState((prev) => ({
						...prev,
						status: "running",
						model: (event.data.model as string) ?? prev.model,
					}));
					break;

				case "session_end":
					setStatusState((prev) => ({ ...prev, status: "idle" }));
					break;

				case "interrupted":
					setStatusState((prev) => ({ ...prev, status: "interrupted" }));
					break;

				case "context_update":
					setStatusState((prev) => ({
						...prev,
						contextTokens: (event.data.context_tokens as number) ?? prev.contextTokens,
						contextWindowSize: (event.data.context_window_size as number) ?? prev.contextWindowSize,
					}));
					break;

				case "plan_end": {
					const usage = event.data.usage as
						| { input_tokens: number; output_tokens: number }
						| undefined;
					setStatusState((prev) => ({
						...prev,
						turns: (event.data.turn as number) ?? prev.turns,
						inputTokens: usage?.input_tokens ?? prev.inputTokens,
						outputTokens: usage?.output_tokens ?? prev.outputTokens,
					}));
					break;
				}
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
			<StatusBar
				contextTokens={statusState.contextTokens}
				contextWindowSize={statusState.contextWindowSize}
				turns={statusState.turns}
				inputTokens={statusState.inputTokens}
				outputTokens={statusState.outputTokens}
				model={statusState.model}
				sessionId={sessionId}
				status={statusState.status}
			/>
			<InputArea
				onSubmit={onSubmit}
				onSlashCommand={onSlashCommand}
				isRunning={statusState.status === "running"}
				initialHistory={initialHistory}
				onInterrupt={() => {
					bus.emitCommand({ kind: "interrupt", data: {} });
				}}
				onExit={onExit}
			/>
		</Box>
	);
}
