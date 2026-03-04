import { describe, expect, test } from "bun:test";
import { finalizeRunLoopOutcome } from "../../src/agents/run-loop-outcome.ts";

describe("finalizeRunLoopOutcome", () => {
	test("reports success when no limits are hit and not interrupted", () => {
		const outcome = finalizeRunLoopOutcome({
			turns: 2,
			stumbles: 1,
			maxTurns: 5,
			timeoutMs: 10_000,
			elapsedMs: 500,
			interrupted: false,
		});

		expect(outcome.success).toBe(true);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.hitTurnLimit).toBe(false);
		expect(outcome.stumbles).toBe(1);
	});

	test("increments stumbles and marks failure on turn limit", () => {
		const outcome = finalizeRunLoopOutcome({
			turns: 5,
			stumbles: 0,
			maxTurns: 5,
			timeoutMs: 0,
			elapsedMs: 0,
			interrupted: false,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.hitTurnLimit).toBe(true);
		expect(outcome.stumbles).toBe(1);
	});

	test("increments stumbles and marks timed out when elapsed exceeds timeout", () => {
		const outcome = finalizeRunLoopOutcome({
			turns: 1,
			stumbles: 3,
			maxTurns: 10,
			timeoutMs: 200,
			elapsedMs: 200,
			interrupted: false,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.timedOut).toBe(true);
		expect(outcome.hitTurnLimit).toBe(false);
		expect(outcome.stumbles).toBe(4);
	});

	test("interrupted run is unsuccessful without adding a stumble by itself", () => {
		const outcome = finalizeRunLoopOutcome({
			turns: 2,
			stumbles: 2,
			maxTurns: 10,
			timeoutMs: 1_000,
			elapsedMs: 100,
			interrupted: true,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.hitTurnLimit).toBe(false);
		expect(outcome.stumbles).toBe(2);
	});
});
