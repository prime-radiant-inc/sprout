import type {
	ActResult,
	LearnSignal,
	LearnSignalKind,
	PrimitiveResult,
	VerifyResult,
} from "../kernel/types.ts";

/** Threshold: successful acts taking more turns than this are "inefficient" */
const INEFFICIENCY_TURN_THRESHOLD = 10;

export function verifyActResult(
	actResult: ActResult,
	sessionId: string,
): { verify: VerifyResult; learnSignal?: LearnSignal } {
	let kind: LearnSignalKind | undefined;

	if (!actResult.success) {
		kind = actResult.timed_out ? "timeout" : "failure";
	} else if (actResult.stumbles > 0) {
		kind = "error";
	} else if (actResult.turns > INEFFICIENCY_TURN_THRESHOLD) {
		kind = "inefficiency";
	}
	const stumbled = kind !== undefined;

	let learnSignal: LearnSignal | undefined;
	if (kind) {
		learnSignal = {
			kind,
			goal: actResult.goal,
			agent_name: actResult.agent_name,
			details: actResult,
			session_id: sessionId,
			timestamp: Date.now(),
		};
	}

	return {
		verify: {
			success: actResult.success,
			stumbled,
			output: actResult.output,
		},
		learnSignal,
	};
}

export function verifyPrimitiveResult(
	result: PrimitiveResult,
	toolName: string,
	goal: string,
	sessionId?: string,
): { stumbled: boolean; learnSignal?: LearnSignal } {
	const stumbled = !result.success;

	let learnSignal: LearnSignal | undefined;
	if (stumbled && sessionId) {
		learnSignal = {
			kind: "error",
			goal,
			agent_name: toolName,
			details: {
				agent_name: toolName,
				goal: `primitive: ${toolName}`,
				output: result.output,
				success: result.success,
				stumbles: 1,
				turns: 1,
				timed_out: false,
			},
			session_id: sessionId,
			timestamp: Date.now(),
		};
	}

	return { stumbled, learnSignal };
}

export interface CallRecord {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Detect retries: repeated identical tool calls (same name + same args).
 * Returns the count of redundant calls (i.e., if read_file("foo") is called
 * 3 times, that's 2 retries).
 */
export function detectRetries(calls: CallRecord[]): number {
	let retries = 0;
	const seen = new Map<string, number>();

	for (const call of calls) {
		const sig = JSON.stringify({ name: call.name, args: call.arguments });
		const prev = seen.get(sig) ?? 0;
		if (prev > 0) {
			retries++;
		}
		seen.set(sig, prev + 1);
	}

	return retries;
}
