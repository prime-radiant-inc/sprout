import { describe, expect, test } from "bun:test";
import { aggregateSapMetrics, type SapMetrics } from "../../src/genome/sap-metrics.ts";
import type { EventKind, SessionEvent } from "../../src/kernel/types.ts";

let clock = 1000;

function evt(kind: EventKind, data: Record<string, unknown>, timestamp?: number): SessionEvent {
	return {
		kind,
		timestamp: timestamp ?? clock++,
		agent_id: "a",
		depth: 0,
		data,
	};
}

function planEnd(usage: Record<string, number>): SessionEvent {
	return evt("plan_end", { turn: 1, finish_reason: "stop", usage });
}

describe("aggregateSapMetrics", () => {
	test("empty stream yields zeroed metrics", () => {
		const m = aggregateSapMetrics([]);
		expect(m.totalInputTokens).toBe(0);
		expect(m.tokensPerDelegatedByte).toBe(0);
		expect(m.stumbleByMode.code.rate).toBe(0);
		expect(m.fanOut.childCount).toBe(0);
		expect(m.promptCache.available).toBe(false);
	});

	test("tokens per delegated byte from a capture+splice sequence", () => {
		const events: SessionEvent[] = [
			planEnd({ input_tokens: 100, output_tokens: 50 }),
			evt("primitive_end", {
				name: "read_file",
				stumbled: false,
				bound_values: [{ name: "impl", ulid: "01", size: 4000 }],
			}),
			planEnd({ input_tokens: 200, output_tokens: 50 }),
			evt("primitive_end", {
				name: "write_file",
				stumbled: false,
				bound_values: [{ name: "out", ulid: "02", size: 1000 }],
			}),
		];
		const m = aggregateSapMetrics(events);
		expect(m.totalInputTokens).toBe(300);
		expect(m.totalOutputTokens).toBe(100);
		expect(m.delegatedBytesMoved).toBe(5000);
		// (300 + 100) / 5000
		expect(m.tokensPerDelegatedByte).toBeCloseTo(0.08, 10);
		expect(m.storeHitSizes).toEqual([1000, 4000]);
	});

	test("code-mode cell stumble raises code stumble rate, not tools", () => {
		const events: SessionEvent[] = [
			evt("primitive_end", { name: "cell", stumbled: true }),
			evt("primitive_end", { name: "cell", stumbled: false }),
			evt("primitive_end", { name: "read_file", stumbled: false }),
		];
		const m = aggregateSapMetrics(events);
		expect(m.stumbleByMode.code.actions).toBe(2);
		expect(m.stumbleByMode.code.stumbles).toBe(1);
		expect(m.stumbleByMode.code.rate).toBe(0.5);
		expect(m.stumbleByMode.tools.actions).toBe(1);
		expect(m.stumbleByMode.tools.stumbles).toBe(0);
		expect(m.stumbleByMode.tools.rate).toBe(0);
	});

	test("delegation failure counts as a tool-mode stumble", () => {
		const events: SessionEvent[] = [
			evt("act_start", { child_id: "c1" }),
			evt("act_end", { child_id: "c1", success: false }),
			evt("act_start", { child_id: "c2" }),
			evt("act_end", { child_id: "c2", success: true }),
		];
		const m = aggregateSapMetrics(events);
		expect(m.stumbleByMode.tools.actions).toBe(2);
		expect(m.stumbleByMode.tools.stumbles).toBe(1);
	});

	test("fan-out wall-clock is bounded by the slowest child, not the sum", () => {
		// Three concurrent children: start together, finish at +30, +50, +80.
		const events: SessionEvent[] = [
			evt("act_start", { child_id: "c1" }, 0),
			evt("act_start", { child_id: "c2" }, 0),
			evt("act_start", { child_id: "c3" }, 0),
			evt("act_end", { child_id: "c1", success: true }, 30),
			evt("act_end", { child_id: "c2", success: true }, 50),
			evt("act_end", { child_id: "c3", success: true }, 80),
		];
		const m = aggregateSapMetrics(events);
		expect(m.fanOut.childCount).toBe(3);
		expect(m.fanOut.slowestChildMs).toBe(80);
		expect(m.fanOut.totalWallClockMs).toBe(80);
		expect(m.fanOut.sumChildMs).toBe(160);
	});

	test("prompt-cache hit rate when the provider reports cache detail", () => {
		const events: SessionEvent[] = [
			planEnd({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 300 }),
		];
		const m = aggregateSapMetrics(events);
		expect(m.promptCache.available).toBe(true);
		expect(m.promptCache.cacheReadTokens).toBe(300);
		expect(m.promptCache.cacheableInputTokens).toBe(400);
		expect(m.promptCache.hitRate).toBeCloseTo(0.75, 10);
	});

	test("prompt-cache unavailable when provider omits cache detail", () => {
		const m: SapMetrics = aggregateSapMetrics([planEnd({ input_tokens: 100, output_tokens: 10 })]);
		expect(m.promptCache.available).toBe(false);
		expect(m.promptCache.hitRate).toBe(0);
	});
});
