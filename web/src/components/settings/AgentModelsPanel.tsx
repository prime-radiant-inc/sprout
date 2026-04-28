import type { AgentModelOverride, ModelRef } from "@shared/provider-settings.ts";
import type { SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import { formatModelRef, parseModelRef } from "./PurposeModelsPanel.tsx";
import styles from "./ProviderSettingsPanel.module.css";

export interface AgentModelsPanelProps {
	settings: SettingsSnapshot;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

export function createSetAgentModelCommand(
	agentKey: string,
	value: string,
): SettingsCommand {
	const override = parseAgentModelOverride(value);
	return {
		kind: "set_agent_model_override",
		data: {
			agentKey,
			...(override ? { override } : {}),
		},
	};
}

export function AgentModelsPanel({
	settings,
	fieldErrors,
	onCommand,
}: AgentModelsPanelProps) {
	const enabledProviders = settings.settings.providers.filter((provider) => provider.enabled);
	const providersWithModels = enabledProviders
		.map((provider) => ({
			provider,
			catalogEntry: settings.catalog.find((entry) => entry.providerId === provider.id),
		}))
		.filter((entry) => (entry.catalogEntry?.models.length ?? 0) > 0);
	const hasModelOptions = providersWithModels.length > 0;

	return (
		<div className={styles.section}>
			<div>
				<h2 className={styles.sectionTitle}>Agent types</h2>
				<p className={styles.sectionText}>
					Choose whether each agent uses its markdown default, one of the global
					tiers, or an exact provider-model tuple.
				</p>
			</div>

			{settings.agentModels.length === 0 && (
				<div className={styles.emptyState}>No agent types discovered.</div>
			)}
			{!hasModelOptions && (
				<div className={styles.emptyState}>Refresh models to configure exact agent models.</div>
			)}

			<div className={styles.formGrid}>
				{settings.agentModels.map((agent) => {
					const storedValue = formatAgentOverride(agent.storedOverride);
					return (
						<div className={styles.field} key={agent.key}>
							<label className={styles.fieldLabel} htmlFor={`agent-model-${agent.key}`}>
								{agent.key}
							</label>
							<select
								id={`agent-model-${agent.key}`}
								className={styles.fieldSelect}
								value={storedValue}
								onChange={(event) =>
									onCommand(createSetAgentModelCommand(agent.key, event.target.value))
								}
							>
								<option value="">Use agent default ({agent.defaultModel})</option>
								<option value="best">Best</option>
								<option value="balanced">Balanced</option>
								<option value="fast">Fast</option>
								{agent.storedOverride?.kind === "model" &&
									!hasModelOption(providersWithModels, agent.storedOverride.model) && (
										<option value={storedValue}>Stored: {storedValue}</option>
									)}
								{providersWithModels.map(({ provider, catalogEntry }) => (
									<optgroup key={provider.id} label={provider.label}>
										{catalogEntry?.models.map((model) => (
											<option
												key={`${agent.key}-${provider.id}-${model.id}`}
												value={`${provider.id}:${model.id}`}
											>
												{model.label}
											</option>
										))}
									</optgroup>
								))}
							</select>
							<div className={styles.hint}>
								{agent.description ? `${agent.name}: ${agent.description}` : agent.name}
							</div>
							<div className={agent.effective.error ? styles.messageBanner : styles.hint}>
								Effective: {agent.effective.label}
								{agent.effective.model
									? ` -> ${formatModelRef(agent.effective.model)}`
									: ""}
								{agent.effective.error ? ` (${agent.effective.error})` : ""}
							</div>
							{agent.runtimeOverride && (
								<div className={styles.hint}>
									Env override {agent.runtimeOverride.envVar}:{" "}
									{formatAgentOverride(agent.runtimeOverride.selection)}
									{agent.runtimeOverride.diagnostic
										? ` (${agent.runtimeOverride.diagnostic})`
										: ""}
								</div>
							)}
							{fieldErrors?.[`agentModelOverrides.${agent.key}`] && (
								<div className={styles.fieldError}>
									{fieldErrors[`agentModelOverrides.${agent.key}`]}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function parseAgentModelOverride(value: string): AgentModelOverride | undefined {
	if (!value) return undefined;
	if (value === "best" || value === "balanced" || value === "fast") {
		return { kind: "tier", tier: value };
	}
	const model = parseModelRef(value);
	return model ? { kind: "model", model } : undefined;
}

function formatAgentOverride(override: AgentModelOverride | undefined): string {
	if (!override) return "";
	if (override.kind === "tier") return override.tier;
	return formatModelRef(override.model);
}

function hasModelOption(
	providersWithModels: Array<{
		provider: SettingsSnapshot["settings"]["providers"][number];
		catalogEntry: SettingsSnapshot["catalog"][number] | undefined;
	}>,
	modelRef: ModelRef,
): boolean {
	return providersWithModels.some(
		({ provider, catalogEntry }) =>
			provider.id === modelRef.providerId &&
			(catalogEntry?.models.some((model) => model.id === modelRef.modelId) ?? false),
	);
}
