export interface RunLoopOutcomeInput {
	turns: number;
	stumbles: number;
	maxTurns: number;
	timedOut: boolean;
	interrupted: boolean;
	/** True when the loop ended because the agent produced its final answer, not because it
	 * ran out of turns. An agent that completes on turn == maxTurns has succeeded. */
	completedNaturally: boolean;
}

export interface RunLoopOutcome {
	success: boolean;
	stumbles: number;
	timedOut: boolean;
	hitTurnLimit: boolean;
}

export function finalizeRunLoopOutcome(input: RunLoopOutcomeInput): RunLoopOutcome {
	const hitTurnLimit = input.turns >= input.maxTurns && !input.completedNaturally;
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
