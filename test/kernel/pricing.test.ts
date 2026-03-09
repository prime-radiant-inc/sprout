import { describe, expect, test } from "bun:test";
import {
	FALLBACK_PRICING_TABLE,
	longestPrefixMatch,
	transformOpenRouterPrices,
	transformPrices,
} from "../../src/kernel/pricing.ts";

describe("transformPrices", () => {
	test("converts entries to prefix-pricing pairs", () => {
		const result = transformPrices([
			{ id: "o3-pro", vendor: "openai", name: "o3 Pro", input: 20, output: 80 },
		]);
		expect(result).toEqual([["o3-pro", { input: 20, output: 80 }]]);
	});

	test("adds dot-truncated prefix for dotted IDs", () => {
		const result = transformPrices([
			{
				id: "claude-sonnet-4.5",
				vendor: "anthropic",
				name: "Claude Sonnet 4.5",
				input: 3,
				output: 15,
			},
		]);
		expect(result).toEqual([
			["claude-sonnet-4.5", { input: 3, output: 15 }],
			["claude-sonnet-4", { input: 3, output: 15 }],
		]);
	});

	test("non-dotted IDs produce exactly one entry", () => {
		const result = transformPrices([
			{ id: "o4-mini", vendor: "openai", name: "o4-mini", input: 1.1, output: 4.4 },
		]);
		expect(result).toHaveLength(1);
	});
});

describe("longestPrefixMatch", () => {
	test("matches exact prefix", () => {
		expect(longestPrefixMatch("o4-mini", FALLBACK_PRICING_TABLE)).toEqual({
			input: 1.1,
			output: 4.4,
		});
	});

	test("matches model with version suffix", () => {
		expect(longestPrefixMatch("claude-sonnet-4-6", FALLBACK_PRICING_TABLE)).toEqual({
			input: 3,
			output: 15,
		});
	});

	test("returns null for unknown model", () => {
		expect(longestPrefixMatch("unknown-model", FALLBACK_PRICING_TABLE)).toBeNull();
	});
});

describe("transformOpenRouterPrices", () => {
	test("converts per-token pricing to per-million", () => {
		const result = transformOpenRouterPrices([
			{
				id: "anthropic/claude-sonnet-4-6",
				pricing: { prompt: "0.000003", completion: "0.000015" },
			},
		]);
		// Should have 2 entries: full ID and stripped
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(["anthropic/claude-sonnet-4-6", { input: 3, output: 15 }]);
		expect(result[1]).toEqual(["claude-sonnet-4-6", { input: 3, output: 15 }]);
	});

	test("skips models with zero pricing", () => {
		const result = transformOpenRouterPrices([
			{ id: "free/model", pricing: { prompt: "0", completion: "0" } },
		]);
		expect(result).toHaveLength(0);
	});

	test("skips models with invalid pricing", () => {
		const result = transformOpenRouterPrices([
			{ id: "bad/model", pricing: { prompt: "not-a-number", completion: "0.001" } },
		]);
		expect(result).toHaveLength(0);
	});

	test("handles model without provider prefix", () => {
		const result = transformOpenRouterPrices([
			{ id: "o4-mini", pricing: { prompt: "0.0000011", completion: "0.0000044" } },
		]);
		// No slash in ID, so only 1 entry
		expect(result).toHaveLength(1);
		expect(result[0]![0]).toBe("o4-mini");
	});
});
