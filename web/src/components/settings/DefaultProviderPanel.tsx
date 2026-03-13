import type { ModelRef, SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

export interface DefaultProviderPanelProps {
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

export function DefaultProviderPanel({
	settings,
	message,
	fieldErrors,
	onCommand,
}: DefaultProviderPanelProps) {
	const enabledProviders = settings.settings.providers.filter((provider) => provider.enabled);
	const defaultProviderId = settings.settings.defaults.defaultProviderId ?? "";
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
				<h2 className={styles.sectionTitle}>Default provider</h2>
				<p className={styles.sectionText}>
					Sprout uses this provider when a session has no exact-model selection. Tier defaults
					are global provider-model tuples and can point at any enabled provider.
				</p>
			</div>

			{message && <div className={styles.errorBanner}>{message}</div>}

			<div className={styles.formGrid}>
				<div className={styles.field}>
					<label className={styles.fieldLabel} htmlFor="default-provider">
						Default provider
					</label>
					<select
						id="default-provider"
						className={styles.fieldSelect}
						value={defaultProviderId}
						disabled={enabledProviders.length === 0}
						onChange={(event) =>
							onCommand({
								kind: "set_default_provider",
								data: {
									providerId: event.target.value || undefined,
								},
							})
						}
					>
						<option value="">No default provider</option>
						{enabledProviders.map((provider) => (
							<option key={provider.id} value={provider.id}>
								{provider.label}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className={styles.section}>
				<div>
					<h3 className={styles.sectionTitle}>Tier defaults</h3>
					<p className={styles.sectionText}>
						Choose the exact provider-model tuple that each global tier should use.
					</p>
				</div>

				{fieldErrors?.tierDefaults && (
					<div className={styles.fieldError}>{fieldErrors.tierDefaults}</div>
				)}

				{!hasModelOptions ? (
					<div className={styles.emptyState}>Refresh models to configure tier defaults.</div>
				) : (
					<div className={styles.formGrid}>
						{(["best", "balanced", "fast"] as const).map((tier) => (
							<div className={styles.field} key={tier}>
								<label className={styles.fieldLabel} htmlFor={`tier-default-${tier}`}>
									{TIER_LABELS[tier]}
								</label>
								<select
									id={`tier-default-${tier}`}
									className={styles.fieldSelect}
									value={formatModelRef(settings.settings.defaults.tierDefaults?.[tier])}
									onChange={(event) =>
										onCommand({
											kind: "set_global_tier_default",
											data: {
												tier,
												model: parseModelRef(event.target.value),
											},
										})
									}
								>
									<option value="">Not configured</option>
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
							</div>
						))}
					</div>
				)}
			</div>

			{enabledProviders.length === 0 && (
				<div className={styles.emptyState}>
					Enable a provider to make it available as the default provider.
				</div>
			)}
		</div>
	);
}
