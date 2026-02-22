import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearnSignal } from "../../src/kernel/types.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";
import { shouldLearn } from "../../src/learn/should-learn.ts";

function makeSignal(overrides: Partial<LearnSignal> = {}): LearnSignal {
	return {
		kind: overrides.kind ?? "error",
		goal: overrides.goal ?? "test goal",
		agent_name: overrides.agent_name ?? "test-agent",
		details: overrides.details ?? {
			agent_name: "test-agent",
			goal: "test goal",
			output: "error output",
			success: false,
			stumbles: 1,
			turns: 3,
		},
		session_id: overrides.session_id ?? "session-1",
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

describe("shouldLearn", () => {
	let tempDir: string;
	let metrics: MetricsStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-should-learn-"));
		metrics = new MetricsStore(join(tempDir, "metrics.jsonl"));
		await metrics.load();
	});

	test("always returns true for failure signals", async () => {
		const signal = makeSignal({ kind: "failure" });
		expect(await shouldLearn(signal, metrics)).toBe(true);
	});

	test("returns true for repeated errors (>= 3 prior occurrences)", async () => {
		const signal = makeSignal({ kind: "error" });
		await metrics.recordStumble("test-agent", "error");
		await metrics.recordStumble("test-agent", "error");
		await metrics.recordStumble("test-agent", "error");

		expect(await shouldLearn(signal, metrics)).toBe(true);
	});

	test("returns false for one-off errors (0 prior occurrences)", async () => {
		const signal = makeSignal({ kind: "error" });
		expect(await shouldLearn(signal, metrics)).toBe(false);
	});

	test("returns false for errors with exactly 1 prior occurrence", async () => {
		const signal = makeSignal({ kind: "error" });
		await metrics.recordStumble("test-agent", "error");

		expect(await shouldLearn(signal, metrics)).toBe(false);
	});

	test("returns true for timeout with >= 3 occurrences", async () => {
		const signal = makeSignal({ kind: "timeout" });
		await metrics.recordStumble("test-agent", "timeout");
		await metrics.recordStumble("test-agent", "timeout");
		await metrics.recordStumble("test-agent", "timeout");

		expect(await shouldLearn(signal, metrics)).toBe(true);
	});

	test("returns true for inefficiency with >= 3 occurrences", async () => {
		const signal = makeSignal({ kind: "inefficiency" });
		await metrics.recordStumble("test-agent", "inefficiency");
		await metrics.recordStumble("test-agent", "inefficiency");
		await metrics.recordStumble("test-agent", "inefficiency");

		expect(await shouldLearn(signal, metrics)).toBe(true);
	});

	test("returns false for retry with < 3 occurrences", async () => {
		const signal = makeSignal({ kind: "retry" });
		await metrics.recordStumble("test-agent", "retry");
		await metrics.recordStumble("test-agent", "retry");

		expect(await shouldLearn(signal, metrics)).toBe(false);
	});

	test("returns false for errors with exactly 2 prior occurrences", async () => {
		const signal = makeSignal({ kind: "error" });
		await metrics.recordStumble("test-agent", "error");
		await metrics.recordStumble("test-agent", "error");

		// Count 2 is between the one-off skip (< 2) and the repeated threshold (>= 3)
		expect(await shouldLearn(signal, metrics)).toBe(false);
	});

	test("checks agent-specific counts", async () => {
		// agent-a has 3 errors, agent-b has 1
		await metrics.recordStumble("agent-a", "error");
		await metrics.recordStumble("agent-a", "error");
		await metrics.recordStumble("agent-a", "error");
		await metrics.recordStumble("agent-b", "error");

		const signalA = makeSignal({ kind: "error", agent_name: "agent-a" });
		const signalB = makeSignal({ kind: "error", agent_name: "agent-b" });

		expect(await shouldLearn(signalA, metrics)).toBe(true);
		expect(await shouldLearn(signalB, metrics)).toBe(false);
	});
});
