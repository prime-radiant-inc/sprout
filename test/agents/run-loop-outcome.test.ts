import { describe, expect, test } from "bun:test";
import { finalizeRunLoopOutcome } from "../../src/agents/run-loop-outcome.ts";

describe("finalizeRunLoopOutcome", () => {
	test("reports success when no limits are hit and not interrupted", () => {
		const outcome = finalizeRunLoopOutcome({
			turns: 2,
			stumbles: 1,
			maxTurns: 5,
			timedOut: false,
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
			timedOut: false,
			interrupted: false,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.hitTurnLimit).toBe(true);
		expect(outcome.stumbles).toBe(1);
	});

	test("increments stumbles and marks timed out when timedOut is true", () => {
		const outcome = finalizeRunLoopOutcome({
			turns: 1,
			stumbles: 3,
			maxTurns: 10,
			timedOut: true,
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
			timedOut: false,
			interrupted: true,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.hitTurnLimit).toBe(false);
		expect(outcome.stumbles).toBe(2);
	});

	test("active long-running agent is not timed out even with high elapsed time", () => {
		const outcome = finalizeRunLoopOutcome({
			turns: 50,
			stumbles: 2,
			maxTurns: 100,
			timedOut: false,
			interrupted: false,
		});

		expect(outcome.success).toBe(true);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.stumbles).toBe(2);
	});
});
