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

// `hitTurnLimit` means the loop exited *because of* the turn limit — not merely that turns
// reached maxTurns. A natural completion, a timeout, or an interrupt on the final turn each
// exited for its own reason (the abort check runs after turns++, so an abort after the last
// turn's tools is counted at turns == maxTurns); none of those is a turn-limit hit. Timeouts
// still stumble via `timedOut`; interrupts are unsuccessful without a stumble regardless of
// which turn they land on.

export interface RunLoopOutcome {
	success: boolean;
	stumbles: number;
	timedOut: boolean;
	hitTurnLimit: boolean;
}

export function finalizeRunLoopOutcome(input: RunLoopOutcomeInput): RunLoopOutcome {
	const hitTurnLimit =
		input.turns >= input.maxTurns &&
		!input.completedNaturally &&
		!input.timedOut &&
		!input.interrupted;
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
