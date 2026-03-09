export interface RunLoopOutcomeInput {
	turns: number;
	stumbles: number;
	maxTurns: number;
	timedOut: boolean;
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
	const timedOut = input.timedOut;
	const stumbles = hitTurnLimit || timedOut ? input.stumbles + 1 : input.stumbles;
	const success = !hitTurnLimit && !timedOut && !input.interrupted;

	return {
		success,
		stumbles,
		timedOut,
		hitTurnLimit,
	};
}
