import { Box, Text } from "ink";
import type { SessionSelectionSnapshot, SettingsSnapshot } from "../kernel/types.ts";
import { type ActiveAgentWork, formatActiveAgentWork } from "../shared/agent-display.ts";
import { useWindowSize } from "./use-window-size.ts";

export interface StatusBarProps {
	activeWork?: ActiveAgentWork | null;
	contextTokens: number;
	contextWindowSize: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
	selection: SessionSelectionSnapshot;
	settings?: SettingsSnapshot | null;
	sessionId: string;
	status: "idle" | "running" | "interrupted";
}

const TIER_LABELS = {
	best: "Best",
	balanced: "Balanced",
	fast: "Fast",
} as const;

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** Shorten model names by stripping date suffixes (e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4"). */
export function shortModelName(model: string): string {
	return model.replace(/-\d{8}$/, "");
}

export function formatSelectionLabel(
	selection: SessionSelectionSnapshot,
	currentModel: string,
	settings?: SettingsSnapshot | null,
): string {
	const currentSelection = selection.selection;
	switch (currentSelection.kind) {
		case "inherit": {
			return currentModel
				? `Use agent default · ${shortModelName(currentModel)}`
				: "Use agent default";
		}
		case "tier": {
			const provider = selectionProvider(selection, settings);
			if (provider) {
				return `${provider.label} · ${TIER_LABELS[currentSelection.tier]}`;
			}
			return TIER_LABELS[currentSelection.tier];
		}
		case "model": {
			const provider = settings?.settings.providers.find(
				(candidate) => candidate.id === currentSelection.model.providerId,
			);
			const model = settings?.catalog
				.find((entry) => entry.providerId === currentSelection.model.providerId)
				?.models.find((candidate) => candidate.id === currentSelection.model.modelId);
			return `${provider?.label ?? currentSelection.model.providerId} · ${shortModelName(
				model?.label ?? currentSelection.model.modelId,
			)}`;
		}
	}
}

function selectionProvider(
	selection: SessionSelectionSnapshot,
	settings?: SettingsSnapshot | null,
) {
	const providerId =
		selection.selection.kind === "model"
			? selection.selection.model.providerId
			: (selection.resolved?.providerId ??
				settings?.settings.defaults[
					selection.selection.kind === "tier" ? selection.selection.tier : "best"
				]?.providerId);
	if (!providerId) return undefined;
	return settings?.settings.providers.find((candidate) => candidate.id === providerId);
}

export function StatusBar(props: StatusBarProps) {
	const {
		activeWork,
		contextTokens,
		contextWindowSize,
		turns,
		inputTokens,
		outputTokens,
		model,
		selection,
		settings,
		sessionId,
		status,
	} = props;
	const pressure = contextWindowSize > 0 ? contextTokens / contextWindowSize : 0;
	const percentStr = `${Math.round(pressure * 100)}%`;

	let ctxInfo = `ctx: ${formatTokens(contextTokens)}/${formatTokens(contextWindowSize)} (${percentStr})`;
	if (pressure >= 0.5) {
		const compactDistance = Math.max(0, Math.round(contextWindowSize * 0.8 - contextTokens));
		ctxInfo += ` ${formatTokens(compactDistance)} to compact`;
	}

	const turnLabel = `${turns} ${turns === 1 ? "turn" : "turns"}`;

	const { columns: cols } = useWindowSize();

	let left = `${ctxInfo} │ ${turnLabel}`;
	if (status === "running") {
		left += ` │ ↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)}`;
	}
	if (activeWork) {
		left += ` │ ${formatActiveAgentWork(activeWork)}`;
	}
	const right = `${formatSelectionLabel(selection, model, settings)} │ ${sessionId}`;
	const line = fitStatusLine(left, right, cols);

	return (
		<Box>
			<Text backgroundColor="gray" color="white">
				{line}
			</Text>
		</Box>
	);
}

function fitStatusLine(left: string, right: string, columns: number): string {
	if (columns <= 0) return left;
	const gap = columns - left.length - right.length;
	if (gap >= 1) return left + " ".repeat(gap) + right;
	if (left.length >= columns) return truncate(left, columns);

	const availableRight = Math.max(0, columns - left.length - 1);
	return `${left} ${truncate(right, availableRight)}`;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 0) return "";
	if (maxLength <= 3) return value.slice(0, maxLength);
	return `${value.slice(0, maxLength - 3)}...`;
}
