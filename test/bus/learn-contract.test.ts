import { describe, expect, test } from "bun:test";
import {
	createMutationLearnRequest,
	createSignalLearnRequest,
	parseLearnRequest,
	resolveLearnMutation,
} from "../../src/bus/learn-contract.ts";
import type { LearnSignal } from "../../src/kernel/types.ts";

function makeSignal(): LearnSignal {
	return {
		kind: "error",
		goal: "write test",
		agent_name: "worker",
		details: {
			agent_name: "worker",
			goal: "write test",
			output: "tool failed",
			success: false,
			stumbles: 1,
			turns: 2,
			timed_out: false,
		},
		session_id: "sess-1",
		timestamp: 12345,
	};
}

describe("learn contract", () => {
	test("parses mutation request and resolves mutation unchanged", () => {
		const request = createMutationLearnRequest(
			{
				type: "create_memory",
				content: "remember this",
				tags: ["learned"],
			},
			"req-1",
		);

		const parsed = parseLearnRequest(JSON.stringify(request));
		expect(parsed).toEqual(request);
		if (!parsed) throw new Error("expected request");
		expect(resolveLearnMutation(parsed)).toEqual(request.payload.mutation);
	});

	test("parses signal request and resolves to create_memory mutation", () => {
		const request = createSignalLearnRequest(makeSignal(), "req-2");

		const parsed = parseLearnRequest(JSON.stringify(request));
		expect(parsed).toEqual(request);
		if (!parsed) throw new Error("expected request");
		const mutation = resolveLearnMutation(parsed);

		expect(mutation.type).toBe("create_memory");
		if (mutation.type === "create_memory") {
			expect(mutation.content).toContain("Learn signal (error)");
			expect(mutation.content).toContain("Goal: write test");
			expect(mutation.tags).toEqual(["learn-signal", "error", "worker"]);
		}
	});

	test("returns null for malformed payload", () => {
		expect(parseLearnRequest("not json")).toBeNull();
		expect(parseLearnRequest(JSON.stringify({ kind: "learn_request" }))).toBeNull();
		expect(
			parseLearnRequest(
				JSON.stringify({
					kind: "learn_request",
					request_id: "x",
					payload: { kind: "unknown" },
				}),
			),
		).toBeNull();
	});
});
