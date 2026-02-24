import { Box, Text } from "ink";

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
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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
	const compactDistance =
		contextWindowSize > 0 ? Math.max(0, Math.round(contextWindowSize * 0.8 - contextTokens)) : 0;

	return (
		<Box borderStyle="single" paddingX={1} justifyContent="space-between">
			<Text>
				ctx: {formatTokens(contextTokens)}/{formatTokens(contextWindowSize)} ({percentStr},{" "}
				{formatTokens(compactDistance)} to compact)
				{" | "}turn {turns}
				{status === "running" && ` | ↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)}`}
			</Text>
			<Text dimColor>
				{model} | {sessionId.slice(0, 8)}...
			</Text>
		</Box>
	);
}
