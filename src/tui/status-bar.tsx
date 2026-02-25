import { Box, Text, useStdout } from "ink";

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

	const turnLabel = turns === 1 ? "1 turn" : `${turns} turns`;

	const { stdout } = useStdout();
	const cols = stdout?.columns ?? 100;

	let left = `${ctxInfo} | ${turnLabel}`;
	if (status === "running") {
		left += ` | ↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)}`;
	}
	const right = `${model} | ${sessionId}`;
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
