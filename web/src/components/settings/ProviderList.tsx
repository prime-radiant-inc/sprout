import type { SettingsSnapshot } from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

export interface ProviderListProps {
	settings: SettingsSnapshot;
	selectedKey: string;
	onSelectDefaults: () => void;
	onSelectProvider: (providerId: string) => void;
	onCreateProvider: () => void;
}

function providerStateTones(
	status: SettingsSnapshot["providers"][number] | undefined,
): Array<{ label: string; tone?: "error" | "warning" | "success" }> {
	if (!status) return [];
	const tones: Array<{ label: string; tone?: "error" | "warning" | "success" }> = [];
	if (status.validationErrors.length > 0) {
		tones.push({ label: "invalid", tone: "error" });
	}
	if (status.connectionStatus === "error") {
		tones.push({ label: "unreachable", tone: "error" });
	}
	if (status.catalogStatus === "stale") {
		tones.push({ label: "stale", tone: "warning" });
	}
	if (status.catalogStatus === "current" && status.connectionStatus !== "error") {
		tones.push({ label: "ready", tone: "success" });
	}
	return tones;
}

export function ProviderList({
	settings,
	selectedKey,
	onSelectDefaults,
	onSelectProvider,
	onCreateProvider,
}: ProviderListProps) {
	return (
		<div className={styles.list}>
			<button
				type="button"
				className={`${styles.listItem} ${selectedKey === "defaults" ? styles.listItemActive : ""}`}
				data-action="select-defaults"
				onClick={onSelectDefaults}
			>
				<span className={styles.listTitle}>Default models</span>
				<span className={styles.listMeta}>Global best, balanced, and fast model choices</span>
			</button>

			{settings.settings.providers.map((provider) => {
				const status = settings.providers.find(
					(candidate) => candidate.providerId === provider.id,
				);
				const catalogEntry = settings.catalog.find(
					(entry) => entry.providerId === provider.id,
				);
				return (
					<button
						key={provider.id}
						type="button"
						className={`${styles.listItem} ${
							selectedKey === provider.id ? styles.listItemActive : ""
						}`}
						data-action="select-provider"
						data-provider-id={provider.id}
						onClick={() => onSelectProvider(provider.id)}
					>
						<span className={styles.listTitle}>{provider.label}</span>
						<span className={styles.listMeta}>
							<span>{provider.kind}</span>
							<span>{provider.enabled ? "Enabled" : "Disabled"}</span>
							<span>{status?.hasSecret ? "Secret stored" : "No secret"}</span>
							{catalogEntry?.lastRefreshAt && <span>Refreshed {catalogEntry.lastRefreshAt}</span>}
						</span>
						<div className={styles.badges}>
							{providerStateTones(status).map((badge) => (
								<span
									key={badge.label}
									className={styles.badge}
									data-tone={badge.tone}
								>
									{badge.label}
								</span>
							))}
						</div>
					</button>
				);
			})}

			<button
				type="button"
				className={styles.ghostButton}
				data-action="create-provider"
				onClick={onCreateProvider}
			>
				New provider
			</button>
		</div>
	);
}
