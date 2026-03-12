import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { SessionBus } from "../host/event-bus.ts";
import {
	createDefaultSessionSelectionSnapshot,
	defaultResolveSessionSelectionRequest,
	resolveSessionSelectionRequest,
	type SessionSelectionSnapshot,
} from "../host/session-selection.ts";
import type {
	SessionEvent,
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "../kernel/types.ts";
import { formatSessionSelectionRequest } from "../shared/session-selection.ts";
import { ConversationView } from "./conversation-view.tsx";
import { InputArea } from "./input-area.tsx";
import { buildModelPickerOptions, ModelPicker } from "./model-picker.tsx";
import { SettingsPanel } from "./settings-panel.tsx";
import type { SlashCommand } from "./slash-commands.ts";
import { StatusBar } from "./status-bar.tsx";

export interface AppProps {
	bus: SessionBus;
	sessionId: string;
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void | Promise<void>;
	onExit: () => void;
	initialHistory?: string[];
	onSteer?: (text: string) => void;
	/** List of known model names for the /model picker. */
	knownModels?: string[];
	initialSelection?: SessionSelectionSnapshot;
	settingsControlPlane?: {
		execute(command: SettingsCommand): Promise<SettingsCommandResult>;
	};
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

function selectionSnapshotFromRequest(
	selection: Parameters<typeof defaultResolveSessionSelectionRequest>[0],
	settings: SettingsSnapshot | null,
): SessionSelectionSnapshot {
	if (settings) {
		return resolveSessionSelectionRequest(selection, {
			settings: settings.settings,
			catalog: settings.catalog,
		});
	}
	return defaultResolveSessionSelectionRequest(selection);
}

export function App({
	bus,
	sessionId,
	onSubmit,
	onSlashCommand,
	onExit,
	initialHistory,
	onSteer,
	knownModels,
	initialSelection,
	settingsControlPlane,
	initialEvents,
}: AppProps) {
	const [statusState, setStatusState] = useState<StatusState>(INITIAL_STATUS);
	const [selectionSnapshot, setSelectionSnapshot] = useState<SessionSelectionSnapshot>(
		initialSelection ?? createDefaultSessionSelectionSnapshot(),
	);
	const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | null>(null);
	const [lastSettingsResult, setLastSettingsResult] = useState<SettingsCommandResult | null>(null);
	const [currentSessionId, setCurrentSessionId] = useState(sessionId);
	const [showModelPicker, setShowModelPicker] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [exitHintVisible, setExitHintVisible] = useState(false);
	const [toolsCollapsed, setToolsCollapsed] = useState(false);

	useEffect(() => {
		if (!settingsControlPlane) return;
		void settingsControlPlane.execute({ kind: "get_settings", data: {} }).then((result) => {
			setLastSettingsResult(result);
			if (result.ok) {
				setSettingsSnapshot(result.snapshot);
			}
		});
	}, [settingsControlPlane]);

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

				case "exit_hint":
					setExitHintVisible((event.data.visible as boolean) ?? false);
					break;
			}
		});
	}, [bus, sessionId]);

	const models = knownModels ?? DEFAULT_MODELS;
	const modelOptions = buildModelPickerOptions({
		availableModels: models,
		settings: settingsSnapshot,
		currentSelection: selectionSnapshot,
		currentModel: statusState.model,
	});

	const runSettingsCommand = async (command: SettingsCommand) => {
		if (!settingsControlPlane) return;
		const result = await settingsControlPlane.execute(command);
		setLastSettingsResult(result);
		if (result.ok) {
			setSettingsSnapshot(result.snapshot);
		}
	};

	const handleSlash = (cmd: SlashCommand) => {
		if (cmd.kind === "collapse_tools") {
			setToolsCollapsed((prev) => !prev);
			bus.emitEvent("warning", "cli", 0, {
				message: toolsCollapsed ? "Tool details visible" : "Tool details hidden",
			});
			return;
		}
		if (cmd.kind === "settings") {
			if (!settingsControlPlane) {
				bus.emitEvent("warning", "cli", 0, {
					message: "Provider settings are unavailable in this session.",
				});
				return;
			}
			void settingsControlPlane.execute({ kind: "get_settings", data: {} }).then((result) => {
				setLastSettingsResult(result);
				if (result.ok) {
					setSettingsSnapshot(result.snapshot);
				}
				setShowSettings(true);
			});
			return;
		}
		if (cmd.kind === "switch_model" && !cmd.selection) {
			setShowModelPicker(true);
			return;
		}
		if (cmd.kind === "switch_model" && cmd.selection) {
			try {
				setSelectionSnapshot(selectionSnapshotFromRequest(cmd.selection, settingsSnapshot));
			} catch {}
		}
		Promise.resolve(onSlashCommand(cmd)).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			bus.emitEvent("warning", "cli", 0, { message: `Slash command error: ${message}` });
		});
	};

	return (
		<Box flexDirection="column">
			<ConversationView bus={bus} initialEvents={initialEvents} toolsCollapsed={toolsCollapsed} />
			<StatusBar
				contextTokens={statusState.contextTokens}
				contextWindowSize={statusState.contextWindowSize}
				turns={statusState.turns}
				inputTokens={statusState.inputTokens}
				outputTokens={statusState.outputTokens}
				model={statusState.model}
				selection={selectionSnapshot}
				settings={settingsSnapshot}
				sessionId={currentSessionId}
				status={statusState.status}
			/>
			{exitHintVisible && <Text color="yellow">Press Ctrl+C again to exit</Text>}
			{showSettings ? (
				<SettingsPanel
					settings={settingsSnapshot}
					lastResult={lastSettingsResult}
					onCommand={(command) => {
						void runSettingsCommand(command);
					}}
					onClose={() => {
						setShowSettings(false);
					}}
				/>
			) : showModelPicker ? (
				<ModelPicker
					options={modelOptions}
					onSelect={(selection) => {
						setShowModelPicker(false);
						setSelectionSnapshot(
							selection.kind === "inherit"
								? createDefaultSessionSelectionSnapshot()
								: selection.kind === "model"
									? {
											selection,
											resolved: selection.model,
											source: "session",
										}
									: {
											selection,
											source: "session",
										},
						);
						bus.emitCommand({ kind: "switch_model", data: { selection } });
						bus.emitEvent("warning", "cli", 0, {
							message: `Model set to: ${formatSessionSelectionRequest(selection)}`,
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
					exitPending={exitHintVisible}
					onInterrupt={() => {
						bus.emitCommand({ kind: "interrupt", data: {} });
					}}
					onIdleCtrlC={() => {
						bus.emitEvent("exit_hint", "cli", 0, { visible: true });
					}}
					onCancelExit={() => {
						bus.emitEvent("exit_hint", "cli", 0, { visible: false });
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
