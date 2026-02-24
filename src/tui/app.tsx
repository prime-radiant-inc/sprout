import { Box, useStdout } from "ink";
import { useEffect, useState } from "react";
import type { EventBus } from "../host/event-bus.ts";
import type { SessionEvent } from "../kernel/types.ts";
import { ConversationView } from "./conversation-view.tsx";
import { InputArea } from "./input-area.tsx";
import { ModelPicker } from "./model-picker.tsx";
import type { SlashCommand } from "./slash-commands.ts";
import { StatusBar } from "./status-bar.tsx";

export interface AppProps {
	bus: EventBus;
	sessionId: string;
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void;
	onExit: () => void;
	initialHistory?: string[];
	onSteer?: (text: string) => void;
	/** List of known model names for the /model picker. */
	knownModels?: string[];
	/** Historical events to display in conversation view on resume. */
	initialEvents?: SessionEvent[];
}

const DEFAULT_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "gpt-4o", "gemini-2.5-pro"];

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

export function App({
	bus,
	sessionId,
	onSubmit,
	onSlashCommand,
	onExit,
	initialHistory,
	onSteer,
	knownModels,
	initialEvents,
}: AppProps) {
	const { stdout } = useStdout();
	const terminalRows = stdout?.rows ?? 40;
	const conversationHeight = Math.max(5, terminalRows - 4);

	const [statusState, setStatusState] = useState<StatusState>(INITIAL_STATUS);
	const [currentSessionId, setCurrentSessionId] = useState(sessionId);
	const [showModelPicker, setShowModelPicker] = useState(false);

	useEffect(() => {
		return bus.onEvent((event: SessionEvent) => {
			switch (event.kind) {
				case "session_start":
					setStatusState((prev) => ({
						...prev,
						status: "running",
						model: (event.data.model as string) ?? prev.model,
					}));
					break;

				case "session_end":
					setStatusState((prev) => ({ ...prev, status: "idle", inputTokens: 0, outputTokens: 0 }));
					break;

				case "interrupted":
					setStatusState((prev) => ({ ...prev, status: "interrupted" }));
					break;

				case "session_clear":
					setCurrentSessionId((event.data.new_session_id as string) ?? sessionId);
					setStatusState(INITIAL_STATUS);
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
						inputTokens: prev.inputTokens + (usage?.input_tokens ?? 0),
						outputTokens: prev.outputTokens + (usage?.output_tokens ?? 0),
					}));
					break;
				}
			}
		});
	}, [bus, sessionId]);

	const models = knownModels ?? DEFAULT_MODELS;

	const handleSlash = (cmd: SlashCommand) => {
		if (cmd.kind === "switch_model" && !cmd.model) {
			setShowModelPicker(true);
			return;
		}
		onSlashCommand(cmd);
	};

	return (
		<Box flexDirection="column">
			<ConversationView bus={bus} maxHeight={conversationHeight} initialEvents={initialEvents} />
			<StatusBar
				contextTokens={statusState.contextTokens}
				contextWindowSize={statusState.contextWindowSize}
				turns={statusState.turns}
				inputTokens={statusState.inputTokens}
				outputTokens={statusState.outputTokens}
				model={statusState.model}
				sessionId={currentSessionId}
				status={statusState.status}
			/>
			{showModelPicker ? (
				<ModelPicker
					models={models}
					onSelect={(model) => {
						setShowModelPicker(false);
						bus.emitCommand({ kind: "switch_model", data: { model } });
						bus.emitEvent("warning", "cli", 0, {
							message: `Model set to: ${model}`,
						});
					}}
					onCancel={() => {
						setShowModelPicker(false);
					}}
				/>
			) : (
				<InputArea
					onSubmit={onSubmit}
					onSlashCommand={handleSlash}
					isRunning={statusState.status === "running"}
					initialHistory={initialHistory}
					onInterrupt={() => {
						bus.emitCommand({ kind: "interrupt", data: {} });
					}}
					onSteer={(text) => {
						onSteer?.(text);
						bus.emitCommand({ kind: "steer", data: { text } });
					}}
					onExit={onExit}
				/>
			)}
		</Box>
	);
}
