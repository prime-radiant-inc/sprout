import { describe, expect, test } from "bun:test";
import { applyRetryAccounting, finalizeRunLoopResult } from "../../src/agents/run-loop-finalize.ts";

describe("applyRetryAccounting", () => {
	test("returns unchanged stumbles when there are no retries", () => {
		const result = applyRetryAccounting({
			callHistory: [
				{ name: "read_file", arguments: { path: "README.md" } },
				{ name: "grep", arguments: { pattern: "TODO" } },
			],
			stumbles: 2,
			goal: "summarize project",
			agentName: "root",
			turns: 3,
			sessionId: "s1",
		});

		expect(result.retryCount).toBe(0);
		expect(result.stumbles).toBe(2);
		expect(result.learnSignal).toBeUndefined();
	});

	test("adds retry stumbles and creates retry learn signal", () => {
		const result = applyRetryAccounting({
			callHistory: [
				{ name: "read_file", arguments: { path: "README.md" } },
				{ name: "read_file", arguments: { path: "README.md" } },
				{ name: "grep", arguments: { pattern: "TODO" } },
				{ name: "grep", arguments: { pattern: "TODO" } },
				{ name: "grep", arguments: { pattern: "TODO" } },
			],
			stumbles: 1,
			goal: "find todos",
			agentName: "root",
			turns: 4,
			sessionId: "s2",
		});

		expect(result.retryCount).toBe(3);
		expect(result.stumbles).toBe(4);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal?.kind).toBe("retry");
		expect(result.learnSignal?.goal).toBe("find todos");
		expect(result.learnSignal?.agent_name).toBe("root");
		expect(result.learnSignal?.details).toEqual({
			agent_name: "root",
			goal: "find todos",
			output: "3 retried tool calls detected",
			success: true,
			stumbles: 3,
			turns: 4,
			timed_out: false,
		});
		expect(result.learnSignal?.session_id).toBe("s2");
		expect(typeof result.learnSignal?.timestamp).toBe("number");
	});
});

describe("finalizeRunLoopResult", () => {
	test("builds successful session_end payload and result shape", () => {
		const result = finalizeRunLoopResult({
			turns: 2,
			stumbles: 1,
			maxTurns: 5,
			timedOut: false,
			interrupted: false,
			output: "done",
			sessionId: "session-1",
		});

		expect(result.stumbles).toBe(1);
		expect(result.sessionEndData).toEqual({
			session_id: "session-1",
			success: true,
			stumbles: 1,
			turns: 2,
			timed_out: false,
			output: "done",
		});
		expect(result.agentResult).toEqual({
			output: "done",
			success: true,
			stumbles: 1,
			turns: 2,
			timed_out: false,
		});
	});

	test("increments stumbles on timeout and exposes timed_out fields", () => {
		const result = finalizeRunLoopResult({
			turns: 3,
			stumbles: 2,
			maxTurns: 10,
			timedOut: true,
			interrupted: false,
			output: "partial",
			sessionId: "session-2",
		});

		expect(result.stumbles).toBe(3);
		expect(result.sessionEndData.success).toBe(false);
		expect(result.sessionEndData.timed_out).toBe(true);
		expect(result.sessionEndData.stumbles).toBe(3);
		expect(result.agentResult.success).toBe(false);
		expect(result.agentResult.timed_out).toBe(true);
		expect(result.agentResult.stumbles).toBe(3);
	});
});
