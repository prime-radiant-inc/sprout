import { useEffect, useState } from "react";
import type { SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

type Tier = "best" | "balanced" | "fast";

const TIERS: Tier[] = ["best", "balanced", "fast"];

function formatModelValue(providerId: string, modelId: string): string {
	return `${providerId}:${modelId}`;
}

function parseModelValue(value: string): { providerId: string; modelId: string } | null {
	const separator = value.indexOf(":");
	if (separator <= 0 || separator >= value.length - 1) return null;
	return {
		providerId: value.slice(0, separator),
		modelId: value.slice(separator + 1),
	};
}

export function createDefaultSelectionCommand(
	mode: "none" | "tier" | "model",
	defaultTier: Tier,
	defaultModel: string,
): SettingsCommand | null {
	if (mode === "none") {
		return {
			kind: "set_default_selection",
			data: { selection: { kind: "none" } },
		};
	}

	if (mode === "tier") {
		return {
			kind: "set_default_selection",
			data: { selection: { kind: "tier", tier: defaultTier } },
		};
	}

	const parsedModel = parseModelValue(defaultModel);
	if (!parsedModel) return null;
	return {
		kind: "set_default_selection",
		data: {
			selection: {
				kind: "model",
				model: parsedModel,
			},
		},
	};
}

export function moveProviderPriority(
	providerIds: string[],
	providerId: string,
	direction: -1 | 1,
): string[] {
	const index = providerIds.indexOf(providerId);
	if (index < 0) return providerIds;
	const nextIndex = index + direction;
	if (nextIndex < 0 || nextIndex >= providerIds.length) return providerIds;
	const next = [...providerIds];
	const [entry] = next.splice(index, 1);
	if (!entry) return providerIds;
	next.splice(nextIndex, 0, entry);
	return next;
}

export function toggleTierProviderSelection(
	providerIds: string[],
	providerId: string,
): string[] {
	return providerIds.includes(providerId)
		? providerIds.filter((candidate) => candidate !== providerId)
		: [...providerIds, providerId];
}

export function createProviderPriorityCommand(providerIds: string[]): SettingsCommand {
	return {
		kind: "set_provider_priority",
		data: { providerIds },
	};
}

export function createTierPriorityCommand(
	tier: Tier,
	providerIds: string[],
): SettingsCommand {
	return {
		kind: "set_tier_priority",
		data: { tier, providerIds },
	};
}

export interface DefaultsPanelProps {
	settings: SettingsSnapshot;
	onCommand: (command: SettingsCommand) => void;
}

export function DefaultsPanel({ settings, onCommand }: DefaultsPanelProps) {
	const providers = settings.settings.providers;
	const enabledProviders = providers.filter((provider) => provider.enabled);
	const defaultSelection = settings.settings.defaults.selection;

	const [defaultMode, setDefaultMode] = useState(defaultSelection.kind);
	const [defaultTier, setDefaultTier] = useState<Tier>(
		defaultSelection.kind === "tier" ? defaultSelection.tier : "balanced",
	);
	const [defaultModel, setDefaultModel] = useState(
		defaultSelection.kind === "model"
			? formatModelValue(defaultSelection.model.providerId, defaultSelection.model.modelId)
			: "",
	);
	const [providerPriority, setProviderPriority] = useState<string[]>(
		settings.settings.routing.providerPriority,
	);
	const [tierOverrides, setTierOverrides] = useState<Record<Tier, string[]>>({
		best: settings.settings.routing.tierOverrides.best ?? [],
		balanced: settings.settings.routing.tierOverrides.balanced ?? [],
		fast: settings.settings.routing.tierOverrides.fast ?? [],
	});

	useEffect(() => {
		setDefaultMode(defaultSelection.kind);
		setDefaultTier(defaultSelection.kind === "tier" ? defaultSelection.tier : "balanced");
		setDefaultModel(
			defaultSelection.kind === "model"
				? formatModelValue(defaultSelection.model.providerId, defaultSelection.model.modelId)
				: "",
		);
		setProviderPriority(settings.settings.routing.providerPriority);
		setTierOverrides({
			best: settings.settings.routing.tierOverrides.best ?? [],
			balanced: settings.settings.routing.tierOverrides.balanced ?? [],
			fast: settings.settings.routing.tierOverrides.fast ?? [],
		});
	}, [settings, defaultSelection]);

	const modelOptions = enabledProviders.flatMap((provider) => {
		const catalogEntry = settings.catalog.find((entry) => entry.providerId === provider.id);
		return (catalogEntry?.models ?? []).map((model) => ({
			value: formatModelValue(provider.id, model.id),
			label: `${provider.label} · ${model.label}`,
		}));
	});

	const moveProvider = (providerId: string, direction: -1 | 1) => {
		setProviderPriority((current) =>
			moveProviderPriority(current, providerId, direction),
		);
	};

	const toggleTierProvider = (tier: Tier, providerId: string) => {
		setTierOverrides((current) => {
			const next = { ...current };
			next[tier] = toggleTierProviderSelection(next[tier], providerId);
			return next;
		});
	};

	const saveDefaultSelection = () => {
		const command = createDefaultSelectionCommand(defaultMode, defaultTier, defaultModel);
		if (command) onCommand(command);
	};

	return (
		<div className={styles.section}>
			<div>
				<h2 className={styles.sectionTitle}>Defaults and routing</h2>
				<p className={styles.sectionText}>
					Control the global fallback selection, provider order, and tier-specific routing.
				</p>
			</div>

			<div className={styles.section}>
				<h3 className={styles.sectionTitle}>Default selection</h3>
				<div className={styles.formGrid}>
					<div className={styles.field}>
						<label className={styles.fieldLabel} htmlFor="default-mode">
							Selection mode
						</label>
						<select
							id="default-mode"
							name="defaultMode"
							className={styles.fieldSelect}
							value={defaultMode}
							onChange={(event) =>
								setDefaultMode(event.target.value as "none" | "tier" | "model")
							}
						>
							<option value="none">No global default</option>
							<option value="tier">Tier</option>
							<option value="model">Explicit model</option>
						</select>
					</div>

					{defaultMode === "tier" && (
						<div className={styles.field}>
							<label className={styles.fieldLabel} htmlFor="default-tier">
								Default tier
							</label>
							<select
								id="default-tier"
								name="defaultTier"
								className={styles.fieldSelect}
								value={defaultTier}
								onChange={(event) => setDefaultTier(event.target.value as Tier)}
							>
								{TIERS.map((tier) => (
									<option key={tier} value={tier}>
										{tier}
									</option>
								))}
							</select>
						</div>
					)}

					{defaultMode === "model" && (
						<div className={styles.field}>
							<label className={styles.fieldLabel} htmlFor="default-model">
								Default model
							</label>
							<select
								id="default-model"
								name="defaultModel"
								className={styles.fieldSelect}
								value={defaultModel}
								onChange={(event) => setDefaultModel(event.target.value)}
							>
								<option value="">Select a model</option>
								{modelOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</div>
					)}
				</div>

				<div className={styles.actions}>
					<button
						type="button"
						className={styles.primaryButton}
						data-action="save-default-selection"
						onClick={saveDefaultSelection}
					>
						Save default selection
					</button>
				</div>
			</div>

			<div className={styles.section}>
				<h3 className={styles.sectionTitle}>Global provider priority</h3>
				<div className={styles.priorityList}>
					{providerPriority.map((providerId) => {
						const provider = providers.find((candidate) => candidate.id === providerId);
						if (!provider) return null;
						return (
							<div key={provider.id} className={styles.priorityItem}>
								<div className={styles.itemMeta}>
									<span className={styles.itemTitle}>{provider.label}</span>
									<span className={styles.itemSubtitle}>{provider.id}</span>
								</div>
								<div className={styles.compactActions}>
									<button
										type="button"
										className={styles.secondaryButton}
										data-action="move-provider-up"
										data-provider-id={provider.id}
										onClick={() => moveProvider(provider.id, -1)}
									>
										Move up
									</button>
									<button
										type="button"
										className={styles.secondaryButton}
										data-action="move-provider-down"
										data-provider-id={provider.id}
										onClick={() => moveProvider(provider.id, 1)}
									>
										Move down
									</button>
								</div>
							</div>
						);
					})}
				</div>
				<div className={styles.actions}>
					<button
						type="button"
						className={styles.primaryButton}
						data-action="save-provider-priority"
						onClick={() => onCommand(createProviderPriorityCommand(providerPriority))}
					>
						Save provider priority
					</button>
				</div>
			</div>

			<div className={styles.section}>
				<h3 className={styles.sectionTitle}>Tier overrides</h3>
				<div className={styles.split}>
					{TIERS.map((tier) => (
						<div key={tier} className={styles.section}>
							<h4 className={styles.sectionTitle}>{tier}</h4>
							<div className={styles.priorityList}>
								{providers.map((provider) => {
									const included = tierOverrides[tier].includes(provider.id);
									return (
										<div key={provider.id} className={styles.priorityItem}>
											<div className={styles.itemMeta}>
												<span className={styles.itemTitle}>{provider.label}</span>
												<span className={styles.itemSubtitle}>{provider.id}</span>
											</div>
											<div className={styles.compactActions}>
												<button
													type="button"
													className={included ? styles.primaryButton : styles.secondaryButton}
													data-action="toggle-tier-provider"
													data-provider-id={provider.id}
													data-tier={tier}
													onClick={() => toggleTierProvider(tier, provider.id)}
												>
													{included ? "Included" : "Include"}
												</button>
											</div>
										</div>
									);
								})}
							</div>
							<div className={styles.actions}>
								<button
									type="button"
									className={styles.primaryButton}
									data-action="save-tier-priority"
									data-tier={tier}
									onClick={() =>
										onCommand(
											createTierPriorityCommand(tier, tierOverrides[tier]),
										)
									}
								>
									Save {tier} routing
								</button>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
