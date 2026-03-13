import { useEffect, useState } from "react";
import type {
	SessionModelSelection,
	SessionSelectionSnapshot,
	SettingsSnapshot,
} from "@kernel/types.ts";
import { formatSessionSelectionRequest } from "@shared/session-selection.ts";
import type { SessionStatus } from "../hooks/useEvents.ts";
import { formatTokens, shortModelName } from "./format.ts";
import styles from "./StatusBar.module.css";
import { pressureColor } from "../utils/pressureColor.ts";

interface SessionSelectionOption {
	selection: SessionModelSelection;
	value: string;
	label: string;
	group?: string;
}

export interface StatusBarProps {
	status: SessionStatus;
	settings?: SettingsSnapshot | null;
	connected: boolean;
	connectionError?: string | null;
	onInterrupt?: () => void;
	onSwitchModel?: (selection: SessionModelSelection) => void;
	onOpenSettings?: () => void;
	onToggleTheme?: () => void;
	theme?: string;
}

const TIER_LABELS = {
	best: "Best",
	balanced: "Balanced",
	fast: "Fast",
} as const;

function formatProviderModelLabel(
	selection: { providerId: string; modelId: string },
	settings: SettingsSnapshot | null | undefined,
): string {
	const provider = settings?.settings.providers.find(
		(candidate) => candidate.id === selection.providerId,
	);
	const catalogEntry = settings?.catalog.find(
		(entry) => entry.providerId === selection.providerId,
	);
	const catalogModel = catalogEntry?.models.find(
		(candidate) => candidate.id === selection.modelId,
	);
	const providerLabel = provider?.label ?? selection.providerId;
	const modelLabel = shortModelName(catalogModel?.label ?? selection.modelId);
	return `${providerLabel} · ${modelLabel}`;
}

function formatTierLabel(
	tier: keyof typeof TIER_LABELS,
	settings: SettingsSnapshot | null | undefined,
): string {
	const modelRef = settings?.settings.defaults[tier];
	const provider = modelRef
		? settings?.settings.providers.find((candidate) => candidate.id === modelRef.providerId)
		: undefined;
	const catalogModel = modelRef
		? settings?.catalog
				.find((entry) => entry.providerId === modelRef.providerId)
				?.models.find((candidate) => candidate.id === modelRef.modelId)
		: undefined;
	return provider
		? `${TIER_LABELS[tier]} · ${provider.label} · ${shortModelName(
				catalogModel?.label ?? modelRef?.modelId ?? "",
			)}`.trim()
		: TIER_LABELS[tier];
}

export function formatSessionSelectionLabel(
	selection: SessionSelectionSnapshot,
	currentModel: string,
	settings: SettingsSnapshot | null | undefined,
): string {
	switch (selection.selection.kind) {
		case "inherit":
			return currentModel
				? `Use agent default · ${shortModelName(currentModel)}`
				: "Use agent default";
		case "tier":
			return formatTierLabel(selection.selection.tier, settings);
		case "model":
			return formatProviderModelLabel(selection.selection.model, settings);
	}
}

export function buildSessionSelectionOptions(
	status: SessionStatus,
	settings: SettingsSnapshot | null | undefined,
): SessionSelectionOption[] {
	const options: SessionSelectionOption[] = [];
	const seenValues = new Set<string>();

	const pushOption = (
		selection: SessionModelSelection,
		label: string,
		group?: string,
	) => {
		const value = formatSessionSelectionRequest(selection);
		if (seenValues.has(value)) return;
		seenValues.add(value);
		options.push({ selection, value, label, group });
	};

	pushOption(
		{ kind: "inherit" },
		formatSessionSelectionLabel(
			{
				selection: { kind: "inherit" },
				source: status.currentSelection.source,
			},
			status.model,
			settings,
		),
	);

	for (const tier of ["best", "balanced", "fast"] as const) {
		if (!settings?.settings.defaults[tier]) continue;
		pushOption({ kind: "tier", tier }, formatTierLabel(tier, settings), "Default models");
	}

	for (const provider of settings?.settings.providers.filter((candidate) => candidate.enabled) ?? []) {
		const providerCatalog = settings?.catalog.find((entry) => entry.providerId === provider.id);
		for (const model of providerCatalog?.models ?? []) {
			const selectionKey = `${provider.id}:${model.id}`;
			if (status.availableModels.length > 0 && !status.availableModels.includes(selectionKey)) {
				continue;
			}
			pushOption(
				{
					kind: "model",
					model: {
						providerId: provider.id,
						modelId: model.id,
					},
				},
				shortModelName(model.label),
				provider.label,
			);
		}
	}

	if (status.currentSelection.selection.kind === "model") {
		const selectedModel = status.currentSelection.selection.model;
		const provider = settings?.settings.providers.find(
			(candidate) => candidate.id === selectedModel.providerId,
		);
		pushOption(
			status.currentSelection.selection,
			shortModelName(
				settings?.catalog
					.find((entry) => entry.providerId === selectedModel.providerId)
					?.models.find((candidate) => candidate.id === selectedModel.modelId)?.label ??
					selectedModel.modelId,
			),
			provider?.label ?? selectedModel.providerId,
		);
	}

	if (status.currentSelection.selection.kind === "tier") {
		pushOption(
			status.currentSelection.selection,
			formatTierLabel(status.currentSelection.selection.tier, settings),
			"Default models",
		);
	}

	return options;
}

function groupSessionSelectionOptions(
	options: SessionSelectionOption[],
): Array<{ label?: string; options: SessionSelectionOption[] }> {
	const groups: Array<{ label?: string; options: SessionSelectionOption[] }> = [];
	for (const option of options) {
		const lastGroup = groups[groups.length - 1];
		if (lastGroup && lastGroup.label === option.group) {
			lastGroup.options.push(option);
			continue;
		}
		groups.push({
			label: option.group,
			options: [option],
		});
	}
	return groups;
}

/** Format elapsed seconds as "M:SS". */
export function formatElapsedTime(startedAt: number | null): string | null {
	if (startedAt === null) return null;
	const elapsed = Math.floor((Date.now() - startedAt) / 1000);
	const mins = Math.floor(elapsed / 60);
	const secs = elapsed % 60;
	return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Hook that ticks every second to update elapsed time display. */
function useElapsedTime(startedAt: number | null): string | null {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (startedAt === null) return;
		const interval = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(interval);
	}, [startedAt]);

	return formatElapsedTime(startedAt);
}

/** Top status bar with session info, context pressure, model, and controls. */
export function StatusBar({
	status,
	settings,
	connected,
	connectionError,
	onInterrupt,
	onSwitchModel,
	onOpenSettings,
	onToggleTheme,
	theme,
}: StatusBarProps) {
	const {
		contextTokens,
		contextWindowSize,
		turns,
		inputTokens,
		outputTokens,
		model,
		sessionId,
		status: runStatus,
	} = status;

	const pressure =
		contextWindowSize > 0 ? contextTokens / contextWindowSize : 0;
	const percentRound = Math.round(pressure * 100);
	const percentStr = `${percentRound}%`;

	const elapsed = useElapsedTime(status.sessionStartedAt);
	const selectionOptions = buildSessionSelectionOptions(status, settings);
	const selectionGroups = groupSessionSelectionOptions(selectionOptions);
	const selectionValue = formatSessionSelectionRequest(status.currentSelection.selection);
	const selectionMap = new Map(
		selectionOptions.map((option) => [option.value, option.selection]),
	);

	const handleCopySessionId = () => {
		navigator.clipboard.writeText(sessionId).catch(() => {});
	};

	return (
		<div className={styles.statusBar}>
			{/* Connection + status */}
			<div className={styles.group}>
				<span className={styles.connectionDot} data-connected={String(connected)} />
				<span className={styles.statusLabel} data-status={runStatus}>
					{runStatus === "running" ? "Running" : runStatus === "interrupted" ? "Interrupted" : "Idle"}
				</span>
				{connectionError && (
					<span className={styles.connectionError} data-testid="connection-error">
						{connectionError}
					</span>
				)}
			</div>

			{/* Context pressure */}
			<div className={styles.group}>
				<span className={styles.label}>Context</span>
				<div
					className={styles.pressureBarTrack}
					data-testid="context-pressure-bar"
				>
					<div
						className={styles.pressureBarFill}
						style={{
							width: percentStr,
							background: pressureColor(percentRound),
						}}
					/>
				</div>
				<span className={styles.value}>{percentStr}</span>
			</div>

			{/* Token usage */}
			<div className={styles.group}>
				<span className={styles.label}>Tokens</span>
				<span className={styles.value}>
					{formatTokens(contextTokens)}/{formatTokens(contextWindowSize)}
				</span>
			</div>

			{/* Turns */}
			<div className={styles.group}>
				<span className={styles.label}>Turns</span>
				<span className={styles.value}>{turns}</span>
			</div>

			{/* Session duration */}
			{elapsed && (
				<div className={styles.group}>
					<span className={styles.label}>Time</span>
					<span className={styles.value}>{elapsed}</span>
				</div>
			)}

			{/* I/O tokens during run */}
			{runStatus === "running" && (
				<div className={styles.group}>
					<span className={styles.ioUp}>{"\u2191"}{formatTokens(inputTokens)}</span>
					<span className={styles.ioDown}>{"\u2193"}{formatTokens(outputTokens)}</span>
				</div>
			)}

			<span className={styles.spacer} />

			{/* Model selector */}
			{selectionOptions.length > 0 && onSwitchModel ? (
				<select
					className={styles.modelSelect}
					value={selectionValue}
					onChange={(e) => {
						const nextSelection = selectionMap.get(e.target.value);
						if (nextSelection) {
							onSwitchModel(nextSelection);
						}
					}}
				>
					{selectionGroups.map((group, groupIndex) =>
						group.label ? (
							<optgroup
								key={`${group.label}-${groupIndex}`}
								label={group.label}
							>
								{group.options.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</optgroup>
						) : (
							group.options.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))
						),
					)}
				</select>
			) : (
				<span className={styles.modelLabel}>
					{formatSessionSelectionLabel(status.currentSelection, model, settings)}
				</span>
			)}

			{/* Interrupt button */}
			{runStatus === "running" && (
				<button
					type="button"
					className={styles.interruptBtn}
					onClick={onInterrupt}
					title="Interrupt (Esc)"
				>
					Stop
				</button>
			)}

			{onOpenSettings && (
				<button
					type="button"
					className={styles.settingsButton}
					data-action="open-settings"
					onClick={onOpenSettings}
				>
					Settings
				</button>
			)}

			{/* Theme toggle */}
			{onToggleTheme && (
				<button
					type="button"
					className={styles.themeToggle}
					data-action="toggle-theme"
					onClick={onToggleTheme}
					title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
				>
					{theme === "dark" ? "\u2600" : "\u263E"}
				</button>
			)}

			{/* Session ID */}
			<button
				type="button"
				className={styles.sessionId}
				data-action="copy-session-id"
				onClick={handleCopySessionId}
				title="Click to copy session ID"
			>
				{sessionId.slice(0, 8)}
			</button>
		</div>
	);
}
