import { Box, Text } from "ink";
import type { SessionSelectionSnapshot, SettingsSnapshot } from "../kernel/types.ts";
import { useWindowSize } from "./use-window-size.ts";

export interface StatusBarProps {
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
		case "inherit":
			return currentModel ? `Default · ${shortModelName(currentModel)}` : "Default";
		case "tier":
			return TIER_LABELS[currentSelection.tier];
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

export function StatusBar(props: StatusBarProps) {
	const {
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
	const right = `${formatSelectionLabel(selection, model, settings)} │ ${sessionId}`;
	const gap = Math.max(1, cols - left.length - right.length);
	const line = left + " ".repeat(gap) + right;

	return (
		<Box>
			<Text backgroundColor="gray" color="white">
				{line}
			</Text>
		</Box>
	);
}
