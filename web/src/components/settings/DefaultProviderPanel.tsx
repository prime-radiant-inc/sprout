import type { SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

export interface DefaultProviderPanelProps {
	settings: SettingsSnapshot;
	message?: string | null;
	onCommand: (command: SettingsCommand) => void;
}

export function DefaultProviderPanel({
	settings,
	message,
	onCommand,
}: DefaultProviderPanelProps) {
	const enabledProviders = settings.settings.providers.filter((provider) => provider.enabled);
	const defaultProviderId = settings.settings.defaults.defaultProviderId ?? "";

	return (
		<div className={styles.section}>
			<div>
				<h2 className={styles.sectionTitle}>Default provider</h2>
				<p className={styles.sectionText}>
					Session tier selections resolve within the chosen provider. When a session has no
					explicit provider selected, Sprout uses this default provider.
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

			{enabledProviders.length === 0 && (
				<div className={styles.emptyState}>
					Enable a provider to make it available as the default provider.
				</div>
			)}
		</div>
	);
}
