import { shouldCompact } from "../core/compaction.ts";

export const MIN_TURNS_BETWEEN_COMPACTIONS = 3;

export interface EvaluateCompactionInput {
	turnsSinceCompaction: number;
	compactionRequested: boolean;
	inputTokens: number;
	contextWindowSize: number;
}

export interface EvaluateCompactionResult {
	shouldCompact: boolean;
	reason: "manual" | "threshold" | null;
	turnsSinceCompaction: number;
	compactionRequested: boolean;
}

/**
 * Decides whether to compact this turn and returns the next compaction state.
 * This keeps run-loop state transitions explicit and testable.
 */
export function evaluateCompaction(input: EvaluateCompactionInput): EvaluateCompactionResult {
	const nextTurnsSinceCompaction = input.turnsSinceCompaction + 1;

	if (input.compactionRequested) {
		return {
			shouldCompact: true,
			reason: "manual",
			turnsSinceCompaction: 0,
			compactionRequested: false,
		};
	}

	if (
		nextTurnsSinceCompaction >= MIN_TURNS_BETWEEN_COMPACTIONS &&
		shouldCompact(input.inputTokens, input.contextWindowSize)
	) {
		return {
			shouldCompact: true,
			reason: "threshold",
			turnsSinceCompaction: 0,
			compactionRequested: false,
		};
	}

	return {
		shouldCompact: false,
		reason: null,
		turnsSinceCompaction: nextTurnsSinceCompaction,
		compactionRequested: false,
	};
}
