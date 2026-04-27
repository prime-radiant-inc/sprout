import {
	MEMORY_MODEL_LABELS,
	MEMORY_MODEL_PURPOSES,
	type MemoryModelPurpose,
} from "@shared/provider-settings.ts";
import type { ModelRef, SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

export interface MemoryModelsPanelProps {
	settings: SettingsSnapshot;
	message?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

function formatModelRef(model: ModelRef | undefined): string {
	return model ? `${model.providerId}:${model.modelId}` : "";
}

function parseModelRef(value: string): ModelRef | undefined {
	if (!value) return undefined;
	const separatorIndex = value.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) return undefined;
	return {
		providerId: value.slice(0, separatorIndex),
		modelId: value.slice(separatorIndex + 1),
	};
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
				<h2 className={styles.sectionTitle}>Memory models</h2>
				<p className={styles.sectionText}>
					Choose exact provider-model tuples for hidden memory work. Unset purposes are
					allowed, but that feature will fail when invoked.
				</p>
			</div>

			{message && <div className={styles.errorBanner}>{message}</div>}

			{!hasModelOptions ? (
				<div className={styles.emptyState}>Refresh models to configure memory models.</div>
			) : (
				<div className={styles.formGrid}>
					{MEMORY_MODEL_PURPOSES.map((purpose) => {
						const stored = settings.settings.memoryModels[purpose];
						const override = settings.runtime.modelOverrides.memoryModels[purpose];
						const storedDiagnostic = describeStoredModelDiagnostic(settings, stored);
						return (
							<div className={styles.field} key={purpose}>
								<label className={styles.fieldLabel} htmlFor={`memory-model-${purpose}`}>
									{MEMORY_MODEL_LABELS[purpose]}
								</label>
								<select
									id={`memory-model-${purpose}`}
									className={styles.fieldSelect}
									value={formatModelRef(stored)}
									onChange={(event) =>
										onCommand(createSetMemoryModelCommand(purpose, event.target.value))
									}
								>
									<option value="">Not configured</option>
									{providersWithModels.map(({ provider, catalogEntry }) => (
										<optgroup key={provider.id} label={provider.label}>
											{catalogEntry?.models.map((model) => (
												<option
													key={`${purpose}-${provider.id}-${model.id}`}
													value={`${provider.id}:${model.id}`}
												>
													{model.label}
												</option>
											))}
										</optgroup>
									))}
								</select>
								{override && <OverrideNote override={override} />}
								{storedDiagnostic && (
									<div className={styles.messageBanner}>{storedDiagnostic}</div>
								)}
								{fieldErrors?.[`memoryModels.${purpose}`] && (
									<div className={styles.fieldError}>
										{fieldErrors[`memoryModels.${purpose}`]}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function OverrideNote({
	override,
}: {
	override: SettingsSnapshot["runtime"]["modelOverrides"]["memoryModels"][MemoryModelPurpose];
}) {
	if (!override) return null;
	const label = override.displayLabel
		? `${override.model.providerId}:${override.displayLabel}`
		: formatModelRef(override.model);
	return (
		<div className={styles.hint}>
			Env override {override.envVar}: {label}
			{override.catalogStatus === "missing" && override.diagnostic
				? ` (${override.diagnostic})`
				: ""}
		</div>
	);
}

function describeStoredModelDiagnostic(
	settings: SettingsSnapshot,
	modelRef: ModelRef | undefined,
): string | undefined {
	if (!modelRef) return undefined;
	const provider = settings.settings.providers.find(
		(candidate) => candidate.id === modelRef.providerId,
	);
	if (!provider) return `Stored provider '${modelRef.providerId}' no longer exists.`;
	if (!provider.enabled) return `Stored provider '${modelRef.providerId}' is disabled.`;
	const catalogEntry = settings.catalog.find((entry) => entry.providerId === modelRef.providerId);
	if (!catalogEntry || catalogEntry.models.length === 0) return undefined;
	if (catalogEntry.models.some((model) => model.id === modelRef.modelId)) return undefined;
	return `Stored model '${modelRef.modelId}' is not in the loaded catalog for provider '${modelRef.providerId}'.`;
}
