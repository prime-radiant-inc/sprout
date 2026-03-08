import { describe, expect, test } from "bun:test";
import { computeCost, formatCost, getModelPricing } from "./pricing";

describe("getModelPricing", () => {
	test("matches exact prefix", () => {
		const p = getModelPricing("o4-mini");
		expect(p).toEqual({ input: 1.1, output: 4.4 });
	});

	test("matches model with version suffix", () => {
		const p = getModelPricing("claude-sonnet-4-20250514");
		expect(p).toEqual({ input: 3, output: 15 });
	});

	test("returns null for unknown model", () => {
		expect(getModelPricing("unknown-model")).toBeNull();
	});

	test("matches longest prefix when multiple could match", () => {
		// "claude-sonnet-4" is longer than "claude-" if we ever had a shorter prefix
		const p = getModelPricing("claude-sonnet-4-latest");
		expect(p).toEqual({ input: 3, output: 15 });
	});
});

describe("computeCost", () => {
	test("computes cost for known model", () => {
		// 1M input * $3/M + 500K output * $15/M = $3 + $7.50 = $10.50
		const cost = computeCost("claude-sonnet-4-20250514", 1_000_000, 500_000);
		expect(cost).toBeCloseTo(10.5);
	});

	test("returns 0 for zero tokens", () => {
		expect(computeCost("claude-sonnet-4", 0, 0)).toBe(0);
	});

	test("returns null for unknown model", () => {
		expect(computeCost("unknown-model", 1000, 1000)).toBeNull();
	});
});

describe("formatCost", () => {
	test("formats sub-dollar amounts", () => {
		expect(formatCost(0.12)).toBe("$0.12");
	});

	test("formats dollar amounts with cents", () => {
		expect(formatCost(1.5)).toBe("$1.50");
	});

	test("formats large amounts without decimals", () => {
		expect(formatCost(150)).toBe("$150");
	});

	test("formats zero", () => {
		expect(formatCost(0)).toBe("$0.00");
	});

	test("rounds to 2 decimal places", () => {
		expect(formatCost(0.129)).toBe("$0.13");
	});
});
