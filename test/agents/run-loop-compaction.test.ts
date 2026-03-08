import { describe, expect, test } from "bun:test";
import {
	evaluateCompaction,
	MIN_TURNS_BETWEEN_COMPACTIONS,
} from "../../src/agents/run-loop-compaction.ts";

describe("evaluateCompaction", () => {
	test("no manual request and below cooldown does not compact", () => {
		const result = evaluateCompaction({
			turnsSinceCompaction: 0,
			compactionRequested: false,
			inputTokens: 100,
			contextWindowSize: 1000,
		});

		expect(result).toEqual({
			shouldCompact: false,
			reason: null,
			turnsSinceCompaction: 1,
			compactionRequested: false,
		});
	});

	test("manual compaction request compacts immediately and resets state", () => {
		const result = evaluateCompaction({
			turnsSinceCompaction: 0,
			compactionRequested: true,
			inputTokens: 1,
			contextWindowSize: 1_000_000,
		});

		expect(result).toEqual({
			shouldCompact: true,
			reason: "manual",
			turnsSinceCompaction: 0,
			compactionRequested: false,
		});
	});

	test("automatic threshold compaction respects cooldown", () => {
		const readyTurns = MIN_TURNS_BETWEEN_COMPACTIONS - 1;
		const result = evaluateCompaction({
			turnsSinceCompaction: readyTurns,
			compactionRequested: false,
			inputTokens: 800,
			contextWindowSize: 1000,
		});

		expect(result).toEqual({
			shouldCompact: true,
			reason: "threshold",
			turnsSinceCompaction: 0,
			compactionRequested: false,
		});
	});
});
