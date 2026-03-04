import type { LearnSignal } from "../kernel/types.ts";
import type { LearnMutation } from "../learn/learn-process.ts";

export interface MutationLearnRequest {
	kind: "learn_request";
	request_id: string;
	payload: {
		kind: "mutation";
		mutation: LearnMutation;
	};
}

export interface SignalLearnRequest {
	kind: "learn_request";
	request_id: string;
	payload: {
		kind: "signal";
		signal: LearnSignal;
	};
}

export type LearnRequest = MutationLearnRequest | SignalLearnRequest;

export function createMutationLearnRequest(
	mutation: LearnMutation,
	requestId: string,
): MutationLearnRequest {
	return {
		kind: "learn_request",
		request_id: requestId,
		payload: {
			kind: "mutation",
			mutation,
		},
	};
}

export function createSignalLearnRequest(
	signal: LearnSignal,
	requestId: string,
): SignalLearnRequest {
	return {
		kind: "learn_request",
		request_id: requestId,
		payload: {
			kind: "signal",
			signal,
		},
	};
}

/** Parse and validate a learn request payload from the bus. */
export function parseLearnRequest(payload: string): LearnRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;

	const msg = parsed as Record<string, unknown>;
	if (msg.kind !== "learn_request") return null;
	if (typeof msg.request_id !== "string" || msg.request_id.length === 0) return null;
	if (!msg.payload || typeof msg.payload !== "object") return null;

	const payloadObj = msg.payload as Record<string, unknown>;
	if (payloadObj.kind === "mutation") {
		if (!payloadObj.mutation || typeof payloadObj.mutation !== "object") return null;
		return {
			kind: "learn_request",
			request_id: msg.request_id,
			payload: {
				kind: "mutation",
				mutation: payloadObj.mutation as LearnMutation,
			},
		};
	}

	if (payloadObj.kind === "signal") {
		if (!payloadObj.signal || typeof payloadObj.signal !== "object") return null;
		return {
			kind: "learn_request",
			request_id: msg.request_id,
			payload: {
				kind: "signal",
				signal: payloadObj.signal as LearnSignal,
			},
		};
	}

	return null;
}

/** Resolve a learn request to a concrete mutation that can be applied to the genome. */
export function resolveLearnMutation(request: LearnRequest): LearnMutation {
	if (request.payload.kind === "mutation") {
		return request.payload.mutation;
	}
	return mutationFromSignal(request.payload.signal);
}

function mutationFromSignal(signal: LearnSignal): LearnMutation {
	return {
		type: "create_memory",
		content:
			`Learn signal (${signal.kind}) from ${signal.agent_name}.\n` +
			`Goal: ${signal.goal}\n` +
			`Output: ${signal.details.output}`,
		tags: ["learn-signal", signal.kind, signal.agent_name],
	};
}
