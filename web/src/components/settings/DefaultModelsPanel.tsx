import type { ModelRef, SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

export interface DefaultModelsPanelProps {
	settings: SettingsSnapshot;
	message?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

const TIER_LABELS = {
	best: "Best model",
	balanced: "Balanced model",
	fast: "Fast model",
} as const;

type DefaultModelTier = keyof typeof TIER_LABELS;

function formatModelRef(model: ModelRef | undefined): string {
	return model ? `${model.providerId}:${model.modelId}` : "";
}

function parseModelRef(value: string): ModelRef | undefined {
	if (!value) return undefined;
	const separatorIndex = value.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
		return undefined;
	}
	return {
		providerId: value.slice(0, separatorIndex),
		modelId: value.slice(separatorIndex + 1),
	};
}

export function DefaultModelsPanel({
	settings,
	message,
	fieldErrors,
	onCommand,
}: DefaultModelsPanelProps) {
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
				<h2 className={styles.sectionTitle}>Default models</h2>
				<p className={styles.sectionText}>
					Choose the global provider-model tuples that Sprout should use for best,
					balanced, and fast.
				</p>
			</div>

			{message && <div className={styles.errorBanner}>{message}</div>}

			{!hasModelOptions && (
				<div className={styles.emptyState}>Refresh models to configure default models.</div>
			)}

			<div className={styles.formGrid}>
				{(["best", "balanced", "fast"] as const).map((tier) => {
					const stored = settings.settings.defaults[tier];
					const storedValue = formatModelRef(stored);
					return (
						<div className={styles.field} key={tier}>
							<label className={styles.fieldLabel} htmlFor={`default-model-${tier}`}>
								{TIER_LABELS[tier]}
							</label>
							<select
								id={`default-model-${tier}`}
								className={styles.fieldSelect}
								value={formatModelRef(settings.settings.defaults[tier])}
								onChange={(event) =>
									onCommand({
										kind: "set_default_model",
										data: {
											slot: tier,
											model: parseModelRef(event.target.value),
										},
									})
								}
							>
								<option value="">Not configured</option>
								{stored && !hasModelOption(providersWithModels, stored) && (
									<option value={storedValue}>Stored: {storedValue}</option>
								)}
								{providersWithModels.map(({ provider, catalogEntry }) => (
									<optgroup key={provider.id} label={provider.label}>
										{catalogEntry?.models.map((model) => (
											<option
												key={`${tier}-${provider.id}-${model.id}`}
												value={`${provider.id}:${model.id}`}
											>
												{model.label}
											</option>
										))}
									</optgroup>
								))}
							</select>
							{settings.runtime.modelOverrides.defaults[tier] && (
								<OverrideNote override={settings.runtime.modelOverrides.defaults[tier]} />
							)}
							{fieldErrors?.[tier] && (
								<div className={styles.fieldError}>{fieldErrors[tier]}</div>
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

function OverrideNote({
	override,
}: {
	override: SettingsSnapshot["runtime"]["modelOverrides"]["defaults"][DefaultModelTier];
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
