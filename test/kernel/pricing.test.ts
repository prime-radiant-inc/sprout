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

	test("adds semantic hyphen alias for dotted Claude versions without bare-major alias", () => {
		const result = transformPrices([
			{
				id: "claude-opus-4.7",
				vendor: "anthropic",
				name: "Claude Opus 4.7",
				input: 5,
				output: 25,
			},
		]);
		expect(result).toEqual([
			[
				"claude-opus-4.7",
				{
					input: 5,
					output: 25,
					cached_input: 0.5,
					cache_write_5m: 6.25,
					cache_write_1h: 10,
				},
			],
			[
				"claude-opus-4-7",
				{
					input: 5,
					output: 25,
					cached_input: 0.5,
					cache_write_5m: 6.25,
					cache_write_1h: 10,
				},
			],
		]);
		expect(result.map(([id]) => id)).not.toContain("claude-opus-4");
	});

	test("non-dotted IDs produce exactly one entry", () => {
		const result = transformPrices([
			{ id: "o4-mini", vendor: "openai", name: "o4-mini", input: 1.1, output: 4.4 },
		]);
		expect(result).toHaveLength(1);
	});

	test("preserves cached input pricing when present", () => {
		const result = transformPrices([
			{
				id: "gpt-4o",
				vendor: "openai",
				name: "GPT-4o",
				input: 2.5,
				output: 10,
				input_cached: 1.25,
			},
		]);
		expect(result).toEqual([["gpt-4o", { input: 2.5, output: 10, cached_input: 1.25 }]]);
	});

	test("derives Anthropic cache pricing from documented multipliers", () => {
		const result = transformPrices([
			{
				id: "claude-sonnet-4-6",
				vendor: "anthropic",
				name: "Claude Sonnet 4.6",
				input: 3,
				output: 15,
			},
		]);
		expect(result[0]).toEqual([
			"claude-sonnet-4-6",
			{ input: 3, output: 15, cached_input: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
		]);
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
			cached_input: 0.3,
			cache_write_5m: 3.75,
			cache_write_1h: 6,
		});
	});

	test("matches hyphenated Opus semantic version to current dotted pricing", () => {
		expect(longestPrefixMatch("claude-opus-4-7", FALLBACK_PRICING_TABLE)).toEqual({
			input: 5,
			output: 25,
			cached_input: 0.5,
			cache_write_5m: 6.25,
			cache_write_1h: 10,
		});
	});

	test("does not price unknown Claude semantic minors from bare major fallback", () => {
		expect(longestPrefixMatch("claude-opus-4-8", FALLBACK_PRICING_TABLE)).toBeNull();
	});

	test("still prices dated base-model snapshots from bare major fallback", () => {
		expect(longestPrefixMatch("claude-opus-4-20250514", FALLBACK_PRICING_TABLE)).toEqual({
			input: 15,
			output: 75,
			cached_input: 1.5,
			cache_write_5m: 18.75,
			cache_write_1h: 30,
		});
	});

	test("returns null for unknown model", () => {
		expect(longestPrefixMatch("unknown-model", FALLBACK_PRICING_TABLE)).toBeNull();
	});

	test("does not invent pricing for local models", () => {
		expect(longestPrefixMatch("ollama/qwen3-coder", FALLBACK_PRICING_TABLE)).toBeNull();
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
		expect(result).toHaveLength(4);
		const expected = {
			input: 3,
			output: 15,
			cached_input: 0.3,
			cache_write_5m: 3.75,
			cache_write_1h: 6,
		};
		expect(result[0]).toEqual(["anthropic/claude-sonnet-4-6", expected]);
		expect(result[1]).toEqual(["anthropic/claude-sonnet-4.6", expected]);
		expect(result[2]).toEqual(["claude-sonnet-4-6", expected]);
		expect(result[3]).toEqual(["claude-sonnet-4.6", expected]);
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
