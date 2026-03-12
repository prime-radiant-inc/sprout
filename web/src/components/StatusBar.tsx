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

export function formatSessionSelectionLabel(
	selection: SessionSelectionSnapshot,
	currentModel: string,
	settings: SettingsSnapshot | null | undefined,
): string {
	switch (selection.selection.kind) {
		case "inherit":
			return currentModel
				? `Default · ${shortModelName(currentModel)}`
				: "Default";
		case "tier":
			return TIER_LABELS[selection.selection.tier];
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
	const availableModelIds = new Set(
		status.availableModels.filter(
			(model): model is Exclude<typeof model, "best" | "balanced" | "fast"> =>
				model !== "best" && model !== "balanced" && model !== "fast",
		),
	);

	const pushOption = (selection: SessionModelSelection, label: string) => {
		const value = formatSessionSelectionRequest(selection);
		if (seenValues.has(value)) return;
		seenValues.add(value);
		options.push({ selection, value, label });
	};

	pushOption(
		{ kind: "inherit" },
		formatSessionSelectionLabel(
			{ selection: { kind: "inherit" }, source: status.currentSelection.source },
			status.model,
			settings,
		),
	);

	for (const tier of ["best", "balanced", "fast"] as const) {
		if (!status.availableModels.includes(tier)) continue;
		pushOption({ kind: "tier", tier }, TIER_LABELS[tier]);
	}

	for (const provider of settings?.settings.providers ?? []) {
		if (!provider.enabled) continue;
		const catalogEntry = settings?.catalog.find((entry) => entry.providerId === provider.id);
		for (const model of catalogEntry?.models ?? []) {
			if (!availableModelIds.has(model.id)) continue;
			pushOption(
				{
					kind: "model",
					model: {
						providerId: provider.id,
						modelId: model.id,
					},
				},
				`${provider.label} · ${shortModelName(model.label)}`,
			);
		}
	}

	if (status.currentSelection.selection.kind === "model") {
		pushOption(
			status.currentSelection.selection,
			formatProviderModelLabel(status.currentSelection.selection.model, settings),
		);
	}

	if (status.currentSelection.selection.kind === "tier") {
		pushOption(
			status.currentSelection.selection,
			TIER_LABELS[status.currentSelection.selection.tier],
		);
	}

	return options;
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
			{selectionOptions.length > 1 && onSwitchModel ? (
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
					{selectionOptions.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
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
