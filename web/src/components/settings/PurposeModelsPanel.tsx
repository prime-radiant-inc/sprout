import type { ModelRef, SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

interface PurposeModelOverride {
	envVar: string;
	model: ModelRef;
	catalogStatus: "not_loaded" | "matched" | "missing";
	displayLabel?: string;
	diagnostic?: string;
}

export interface PurposeModelControl {
	key: string;
	label: string;
	stored?: ModelRef;
	override?: PurposeModelOverride;
	fieldErrorKey: string;
	commandForValue: (value: string) => SettingsCommand;
}

export interface PurposeModelsPanelProps {
	settings: SettingsSnapshot;
	title: string;
	description: string;
	emptyMessage: string;
	controls: PurposeModelControl[];
	message?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

export function formatModelRef(model: ModelRef | undefined): string {
	return model ? `${model.providerId}:${model.modelId}` : "";
}

export function parseModelRef(value: string): ModelRef | undefined {
	if (!value) return undefined;
	const separatorIndex = value.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) return undefined;
	return {
		providerId: value.slice(0, separatorIndex),
		modelId: value.slice(separatorIndex + 1),
	};
}

export function PurposeModelsPanel({
	settings,
	title,
	description,
	emptyMessage,
	controls,
	message,
	fieldErrors,
	onCommand,
}: PurposeModelsPanelProps) {
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
				<h2 className={styles.sectionTitle}>{title}</h2>
				<p className={styles.sectionText}>{description}</p>
			</div>

			{message && <div className={styles.errorBanner}>{message}</div>}

			{!hasModelOptions && <div className={styles.emptyState}>{emptyMessage}</div>}

			<div className={styles.formGrid}>
				{controls.map((control) => {
					const storedValue = formatModelRef(control.stored);
					return (
						<div className={styles.field} key={control.key}>
							<label className={styles.fieldLabel} htmlFor={`purpose-model-${control.key}`}>
								{control.label}
							</label>
							<select
								id={`purpose-model-${control.key}`}
								className={styles.fieldSelect}
								value={storedValue}
								onChange={(event) => onCommand(control.commandForValue(event.target.value))}
							>
								<option value="">Not configured</option>
								{control.stored && !hasModelOption(providersWithModels, control.stored) && (
									<option value={storedValue}>Stored: {storedValue}</option>
								)}
								{providersWithModels.map(({ provider, catalogEntry }) => (
									<optgroup key={provider.id} label={provider.label}>
										{catalogEntry?.models.map((model) => (
											<option
												key={`${control.key}-${provider.id}-${model.id}`}
												value={`${provider.id}:${model.id}`}
											>
												{model.label}
											</option>
										))}
									</optgroup>
								))}
							</select>
							{control.override && <OverrideNote override={control.override} />}
							{describeStoredModelDiagnostic(settings, control.stored) && (
								<div className={styles.messageBanner}>
									{describeStoredModelDiagnostic(settings, control.stored)}
								</div>
							)}
							{fieldErrors?.[control.fieldErrorKey] && (
								<div className={styles.fieldError}>
									{fieldErrors[control.fieldErrorKey]}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
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

function OverrideNote({ override }: { override: PurposeModelOverride }) {
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
