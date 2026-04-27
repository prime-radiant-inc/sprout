import {
	MEMORY_MODEL_LABELS,
	MEMORY_MODEL_PURPOSES,
	type MemoryModelPurpose,
} from "@shared/provider-settings.ts";
import type { SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import { parseModelRef, PurposeModelsPanel } from "./PurposeModelsPanel.tsx";

export interface MemoryModelsPanelProps {
	settings: SettingsSnapshot;
	message?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

export function createSetMemoryModelCommand(
	purpose: MemoryModelPurpose,
	value: string,
): SettingsCommand {
	return {
		kind: "set_memory_model",
		data: {
			purpose,
			model: parseModelRef(value),
		},
	};
}

export function MemoryModelsPanel({
	settings,
	message,
	fieldErrors,
	onCommand,
}: MemoryModelsPanelProps) {
	return (
		<PurposeModelsPanel
			settings={settings}
			title="Memory models"
			description="Choose exact provider-model tuples for hidden memory work. Unset purposes are allowed, but that feature will fail when invoked."
			emptyMessage="Refresh models to configure memory models."
			controls={MEMORY_MODEL_PURPOSES.map((purpose) => ({
				key: purpose,
				label: MEMORY_MODEL_LABELS[purpose],
				stored: settings.settings.memoryModels[purpose],
				override: settings.runtime.modelOverrides.memoryModels[purpose],
				fieldErrorKey: `memoryModels.${purpose}`,
				commandForValue: (value) => createSetMemoryModelCommand(purpose, value),
			}))}
			message={message}
			fieldErrors={fieldErrors}
			onCommand={onCommand}
		/>
	);
}
