import { useEffect, useMemo, useRef, useState } from "react";
import type {
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "@kernel/types.ts";
import { DefaultProviderPanel } from "./DefaultProviderPanel.tsx";
import { ProviderEditor } from "./ProviderEditor.tsx";
import styles from "./ProviderSettingsPanel.module.css";
import { ProviderList } from "./ProviderList.tsx";

type SelectedView = "defaults" | "create" | string;

export interface ProviderSettingsPanelProps {
	settings: SettingsSnapshot | null;
	lastResult: SettingsCommandResult | null;
	onCommand: (command: SettingsCommand) => void;
	onClose: () => void;
}

function selectInitialView(settings: SettingsSnapshot | null): SelectedView {
	if (!settings) return "create";
	if (settings.settings.providers.length === 0) return "create";
	return settings.settings.providers[0]?.id ?? "create";
}

export function ProviderSettingsPanel({
	settings,
	lastResult,
	onCommand,
	onClose,
}: ProviderSettingsPanelProps) {
	const [selectedView, setSelectedView] = useState<SelectedView>(() =>
		selectInitialView(settings),
	);
	const previousProviderIdsRef = useRef<string[]>(settings?.settings.providers.map((provider) => provider.id) ?? []);

	useEffect(() => {
		if (!settings) {
			setSelectedView("create");
			return;
		}
		const previousProviderIds = previousProviderIdsRef.current;
		const currentProviderIds = settings.settings.providers.map((provider) => provider.id);
		previousProviderIdsRef.current = currentProviderIds;
		const createdProviderId = currentProviderIds.find(
			(providerId) => !previousProviderIds.includes(providerId),
		);
		if (selectedView === "create" && createdProviderId) {
			setSelectedView(createdProviderId);
			return;
		}
		if (selectedView === "defaults" || selectedView === "create") return;
		if (!settings.settings.providers.some((provider) => provider.id === selectedView)) {
			setSelectedView(selectInitialView(settings));
		}
	}, [settings, selectedView]);

	const selectedProvider = useMemo(
		() =>
			settings?.settings.providers.find((provider) => provider.id === selectedView),
		[settings, selectedView],
	);
	const selectedStatus = settings?.providers.find(
		(status) => status.providerId === selectedProvider?.id,
	);
	const selectedCatalog = settings?.catalog.find(
		(entry) => entry.providerId === selectedProvider?.id,
	);
	const message = lastResult && !lastResult.ok ? lastResult.message : null;
	const fieldErrors = lastResult && !lastResult.ok ? lastResult.fieldErrors : undefined;

	if (!settings) {
		if (lastResult && !lastResult.ok) {
			return (
				<div className={styles.overlay} onClick={onClose}>
					<div className={styles.panel} onClick={(event) => event.stopPropagation()}>
						<div className={styles.header}>
							<div className={styles.titleGroup}>
								<h2 className={styles.title}>Provider settings</h2>
								<span className={styles.subtitle}>Provider settings are unavailable</span>
							</div>
							<button type="button" className={styles.close} onClick={onClose}>
								{"\u2715"}
							</button>
						</div>
						<div className={styles.detail}>
							<div className={styles.errorBanner}>{lastResult.message}</div>
						</div>
					</div>
				</div>
			);
		}
		return (
			<div className={styles.overlay} onClick={onClose}>
				<div className={styles.panel} onClick={(event) => event.stopPropagation()}>
					<div className={styles.header}>
						<div className={styles.titleGroup}>
							<h2 className={styles.title}>Provider settings</h2>
							<span className={styles.subtitle}>Loading provider settings…</span>
						</div>
						<button type="button" className={styles.close} onClick={onClose}>
							{"\u2715"}
						</button>
					</div>
					<div className={styles.detail}>
						<div className={styles.emptyState}>Loading provider settings</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className={styles.overlay} onClick={onClose}>
			<div className={styles.panel} onClick={(event) => event.stopPropagation()}>
				<div className={styles.header}>
					<div className={styles.titleGroup}>
						<h2 className={styles.title}>Provider settings</h2>
						<span className={styles.subtitle}>
							Manage providers, credentials, the default provider, and provider-owned tier
							defaults.
						</span>
					</div>
					<button type="button" className={styles.close} onClick={onClose}>
						{"\u2715"}
					</button>
				</div>

				<div className={styles.body}>
					<aside className={styles.sidebar}>
						<ProviderList
							settings={settings}
							selectedKey={selectedView}
							onSelectDefaults={() => setSelectedView("defaults")}
							onSelectProvider={(providerId) => setSelectedView(providerId)}
							onCreateProvider={() => setSelectedView("create")}
						/>
					</aside>

					<div className={styles.detail}>
						{settings.runtime.warnings.length > 0 && (
							<div className={styles.warningList}>
								{settings.runtime.warnings.map((warning) => (
									<div key={`${warning.code}-${warning.message}`} className={styles.messageBanner}>
										{warning.message}
									</div>
								))}
							</div>
						)}

						{settings.settings.providers.length === 0 && selectedView === "create" && (
							<div className={styles.emptyState}>No providers configured</div>
						)}

						{selectedView === "defaults" ? (
							<DefaultProviderPanel settings={settings} message={message} onCommand={onCommand} />
						) : selectedView === "create" ? (
							<ProviderEditor
								mode="create"
								message={message}
								fieldErrors={fieldErrors}
								onCommand={onCommand}
							/>
						) : (
							<ProviderEditor
								mode="edit"
								provider={selectedProvider}
								status={selectedStatus}
								catalogEntry={selectedCatalog}
								message={message}
								fieldErrors={fieldErrors}
								onCommand={onCommand}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
