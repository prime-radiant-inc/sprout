import { describe, expect, test } from "bun:test";
import { transformPrices } from "./llm-prices";

describe("transformPrices", () => {
	test("converts entries to prefix-pricing pairs", () => {
		const result = transformPrices([
			{ id: "o3-pro", vendor: "openai", name: "o3 Pro", input: 20, output: 80 },
		]);
		expect(result).toEqual([["o3-pro", { input: 20, output: 80 }]]);
	});

	test("adds dot-truncated prefix for dotted IDs", () => {
		const result = transformPrices([
			{ id: "claude-sonnet-4.5", vendor: "anthropic", name: "Claude Sonnet 4.5", input: 3, output: 15 },
		]);
		expect(result).toEqual([
			["claude-sonnet-4.5", { input: 3, output: 15 }],
			["claude-sonnet-4", { input: 3, output: 15 }],
		]);
	});

	test("gemini version dots also produce shorter prefix", () => {
		const result = transformPrices([
			{ id: "gemini-2.5-pro", vendor: "google", name: "Gemini 2.5 Pro", input: 1.25, output: 10 },
		]);
		// "gemini-2.5-pro" has last dot at position 7, prefix "gemini-2" also added
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(["gemini-2.5-pro", { input: 1.25, output: 10 }]);
	});

	test("non-dotted IDs produce exactly one entry", () => {
		const result = transformPrices([
			{ id: "o4-mini", vendor: "openai", name: "o4-mini", input: 1.1, output: 4.4 },
		]);
		expect(result).toHaveLength(1);
	});
});
