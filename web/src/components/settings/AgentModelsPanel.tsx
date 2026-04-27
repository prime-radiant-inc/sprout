import {
	AGENT_MODEL_LABELS,
	AGENT_MODEL_PURPOSES,
	type AgentModelPurpose,
} from "@shared/provider-settings.ts";
import type { SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import { parseModelRef, PurposeModelsPanel } from "./PurposeModelsPanel.tsx";

export interface AgentModelsPanelProps {
	settings: SettingsSnapshot;
	message?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

export function createSetAgentModelCommand(
	purpose: AgentModelPurpose,
	value: string,
): SettingsCommand {
	return {
		kind: "set_agent_model",
		data: {
			purpose,
			model: parseModelRef(value),
		},
	};
}

export function AgentModelsPanel({
	settings,
	message,
	fieldErrors,
	onCommand,
}: AgentModelsPanelProps) {
	return (
		<PurposeModelsPanel
			settings={settings}
			title="Agent models"
			description="Choose exact provider-model tuples for runtime-started internal agents, including observers."
			emptyMessage="Refresh models to configure agent models."
			controls={AGENT_MODEL_PURPOSES.map((purpose) => ({
				key: purpose,
				label: AGENT_MODEL_LABELS[purpose],
				stored: settings.settings.agentModels[purpose],
				override: settings.runtime.modelOverrides.agentModels[purpose],
				fieldErrorKey: `agentModels.${purpose}`,
				commandForValue: (value) => createSetAgentModelCommand(purpose, value),
			}))}
			message={message}
			fieldErrors={fieldErrors}
			onCommand={onCommand}
		/>
	);
}
