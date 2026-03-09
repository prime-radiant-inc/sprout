import type { LearnSignal } from "../kernel/types.ts";
import { finalizeRunLoopOutcome } from "./run-loop-outcome.ts";
import { type CallRecord, detectRetries } from "./verify.ts";

export interface RetryAccountingInput {
	callHistory: CallRecord[];
	stumbles: number;
	goal: string;
	agentName: string;
	turns: number;
	sessionId: string;
}

export interface RetryAccountingResult {
	retryCount: number;
	stumbles: number;
	learnSignal?: LearnSignal;
}

/**
 * Applies retry stumble accounting and builds a retry learn signal when repeated
 * identical tool calls are detected.
 */
export function applyRetryAccounting(input: RetryAccountingInput): RetryAccountingResult {
	const retryCount = detectRetries(input.callHistory);
	if (retryCount === 0) {
		return {
			retryCount,
			stumbles: input.stumbles,
		};
	}

	return {
		retryCount,
		stumbles: input.stumbles + retryCount,
		learnSignal: {
			kind: "retry",
			goal: input.goal,
			agent_name: input.agentName,
			details: {
				agent_name: input.agentName,
				goal: input.goal,
				output: `${retryCount} retried tool calls detected`,
				success: true,
				stumbles: retryCount,
				turns: input.turns,
				timed_out: false,
			},
			session_id: input.sessionId,
			timestamp: Date.now(),
		},
	};
}

export interface FinalizeRunLoopResultInput {
	turns: number;
	stumbles: number;
	maxTurns: number;
	timedOut: boolean;
	interrupted: boolean;
	output: string;
	sessionId: string;
}

export interface SessionEndData extends Record<string, unknown> {
	session_id: string;
	success: boolean;
	stumbles: number;
	turns: number;
	timed_out: boolean;
	output: string;
}

export interface FinalizeRunLoopResult {
	stumbles: number;
	sessionEndData: SessionEndData;
	agentResult: {
		output: string;
		success: boolean;
		stumbles: number;
		turns: number;
		timed_out: boolean;
	};
}

/**
 * Builds the final run-loop outcome and mirrors it into both session_end payload
 * data and the AgentResult return shape.
 */
export function finalizeRunLoopResult(input: FinalizeRunLoopResultInput): FinalizeRunLoopResult {
	const outcome = finalizeRunLoopOutcome({
		turns: input.turns,
		stumbles: input.stumbles,
		maxTurns: input.maxTurns,
		timedOut: input.timedOut,
		interrupted: input.interrupted,
	});

	const finalStumbles = outcome.stumbles;
	const sessionEndData: SessionEndData = {
		session_id: input.sessionId,
		success: outcome.success,
		stumbles: finalStumbles,
		turns: input.turns,
		timed_out: outcome.timedOut,
		output: input.output,
	};

	return {
		stumbles: finalStumbles,
		sessionEndData,
		agentResult: {
			output: input.output,
			success: outcome.success,
			stumbles: finalStumbles,
			turns: input.turns,
			timed_out: outcome.timedOut,
		},
	};
}
