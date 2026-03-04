export interface RunLoopOutcomeInput {
	turns: number;
	stumbles: number;
	maxTurns: number;
	timeoutMs: number;
	elapsedMs: number;
	interrupted: boolean;
}

export interface RunLoopOutcome {
	success: boolean;
	stumbles: number;
	timedOut: boolean;
	hitTurnLimit: boolean;
}

export function finalizeRunLoopOutcome(input: RunLoopOutcomeInput): RunLoopOutcome {
	const hitTurnLimit = input.turns >= input.maxTurns;
	const timedOut = input.timeoutMs > 0 && input.elapsedMs >= input.timeoutMs;
	const stumbles = hitTurnLimit || timedOut ? input.stumbles + 1 : input.stumbles;
	const success = !hitTurnLimit && !timedOut && !input.interrupted;

	return {
		success,
		stumbles,
		timedOut,
		hitTurnLimit,
	};
}
