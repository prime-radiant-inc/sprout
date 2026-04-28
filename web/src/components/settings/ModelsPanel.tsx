import type { SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import { AgentModelsPanel } from "./AgentModelsPanel.tsx";
import { DefaultModelsPanel } from "./DefaultModelsPanel.tsx";
import { MemoryModelsPanel } from "./MemoryModelsPanel.tsx";
import styles from "./ProviderSettingsPanel.module.css";

export interface ModelsPanelProps {
	settings: SettingsSnapshot;
	message?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

export function ModelsPanel({
	settings,
	message,
	fieldErrors,
	onCommand,
}: ModelsPanelProps) {
	return (
		<div className={styles.sectionStack}>
			{message && <div className={styles.errorBanner}>{message}</div>}
			<DefaultModelsPanel
				settings={settings}
				fieldErrors={fieldErrors}
				onCommand={onCommand}
			/>
			<MemoryModelsPanel
				settings={settings}
				fieldErrors={fieldErrors}
				onCommand={onCommand}
			/>
			<AgentModelsPanel
				settings={settings}
				fieldErrors={fieldErrors}
				onCommand={onCommand}
			/>
		</div>
	);
}
