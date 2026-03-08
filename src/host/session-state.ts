import type { SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import { Msg } from "../llm/types.ts";

export interface SubmitGoalTransitionInput {
	hasRun: boolean;
	historyLength: number;
}

export interface SubmitGoalTransition {
	hasRun: true;
	shouldEmitResume: boolean;
}

export interface ClearedSessionShadowState {
	sessionId: string;
	history: Message[];
	hasRun: false;
	suppressEvents: true;
}

/**
 * Applies root-level event effects to the controller's history shadow.
 * Returns the same array reference when no history transition occurs.
 */
export function applyHistoryShadowUpdate(history: Message[], event: SessionEvent): Message[] {
	if (event.depth !== 0) return history;

	switch (event.kind) {
		case "perceive": {
			const goal = event.data.goal as string | undefined;
			return goal ? [...history, Msg.user(goal)] : history;
		}
		case "steering": {
			const text = event.data.text as string | undefined;
			return text ? [...history, Msg.user(text)] : history;
		}
		case "plan_end": {
			const msg = event.data.assistant_message as Message | undefined;
			return msg ? [...history, msg] : history;
		}
		case "primitive_end": {
			const msg = event.data.tool_result_message as Message | undefined;
			return msg ? [...history, msg] : history;
		}
		case "act_end": {
			const msg = event.data.tool_result_message as Message | undefined;
			return msg ? [...history, msg] : history;
		}
		case "compaction": {
			const summary = event.data.summary as string | undefined;
			return summary ? [Msg.user(summary)] : history;
		}
		default:
			return history;
	}
}

/**
 * Computes the hasRun/session_resume transition when a goal is submitted.
 */
export function beginSubmitGoalTransition(input: SubmitGoalTransitionInput): SubmitGoalTransition {
	return {
		hasRun: true,
		shouldEmitResume: !input.hasRun && input.historyLength > 0,
	};
}

/**
 * Returns the history/session fields after /clear resets controller state.
 */
export function clearSessionShadowState(sessionId: string): ClearedSessionShadowState {
	return {
		sessionId,
		history: [],
		hasRun: false,
		suppressEvents: true,
	};
}
