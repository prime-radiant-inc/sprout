import type { ActResult, LearnSignal, PrimitiveResult, VerifyResult } from "../kernel/types.ts";

export function verifyActResult(
	actResult: ActResult,
	sessionId: string,
): { verify: VerifyResult; learnSignal?: LearnSignal } {
	const stumbled = !actResult.success || actResult.stumbles > 0;

	let learnSignal: LearnSignal | undefined;
	if (stumbled) {
		const kind = !actResult.success ? "failure" : "error";
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
	_toolName: string,
	_goal: string,
): { stumbled: boolean } {
	return { stumbled: !result.success };
}
