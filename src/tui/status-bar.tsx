import { Box, Text } from "ink";
import { useWindowSize } from "./use-window-size.ts";

export interface StatusBarProps {
	contextTokens: number;
	contextWindowSize: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
	sessionId: string;
	status: "idle" | "running" | "interrupted";
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** Shorten model names by stripping date suffixes (e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4"). */
export function shortModelName(model: string): string {
	return model.replace(/-\d{8}$/, "");
}

export function StatusBar(props: StatusBarProps) {
	const {
		contextTokens,
		contextWindowSize,
		turns,
		inputTokens,
		outputTokens,
		model,
		sessionId,
		status,
	} = props;
	const pressure = contextWindowSize > 0 ? contextTokens / contextWindowSize : 0;
	const percentStr = `${Math.round(pressure * 100)}%`;

	// Only show compact distance when context pressure is above 50%
	let ctxInfo = `ctx: ${formatTokens(contextTokens)}/${formatTokens(contextWindowSize)} (${percentStr})`;
	if (pressure >= 0.5) {
		const compactDistance = Math.max(0, Math.round(contextWindowSize * 0.8 - contextTokens));
		ctxInfo += ` ${formatTokens(compactDistance)} to compact`;
	}

	const turnLabel = `${turns} ${turns === 1 ? "turn" : "turns"}`;

	const { columns: cols } = useWindowSize();

	let left = `${ctxInfo} \u2502 ${turnLabel}`;
	if (status === "running") {
		left += ` \u2502 \u2191${formatTokens(inputTokens)} \u2193${formatTokens(outputTokens)}`;
	}
	const right = `${shortModelName(model)} \u2502 ${sessionId}`;
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
