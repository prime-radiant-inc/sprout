import { describe, expect, test } from "bun:test";
import { detectProvider, resolveModel } from "../../src/agents/model-resolver.ts";

describe("detectProvider", () => {
	test("detects anthropic from claude model", () => {
		expect(detectProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
		expect(detectProvider("claude-opus-4-6")).toBe("anthropic");
	});

	test("detects openai from gpt/o-series models", () => {
		expect(detectProvider("gpt-4.1-mini")).toBe("openai");
		expect(detectProvider("gpt-4.1")).toBe("openai");
		expect(detectProvider("o3-pro")).toBe("openai");
	});

	test("detects gemini", () => {
		expect(detectProvider("gemini-2.5-flash")).toBe("gemini");
		expect(detectProvider("gemini-2.5-pro")).toBe("gemini");
	});

	test("returns undefined for unknown model", () => {
		expect(detectProvider("llama-3")).toBeUndefined();
	});
});

describe("resolveModel", () => {
	test("resolves 'fast' to first available provider", () => {
		const result = resolveModel("fast", ["anthropic", "openai", "gemini"]);
		expect(result.provider).toBe("anthropic");
		expect(result.model).toContain("claude");
	});

	test("resolves 'fast' skips unavailable providers", () => {
		const result = resolveModel("fast", ["openai"]);
		expect(result.provider).toBe("openai");
		expect(result.model).toContain("gpt");
	});

	test("resolves 'best' to best available", () => {
		const result = resolveModel("best", ["anthropic"]);
		expect(result.provider).toBe("anthropic");
	});

	test("passes through concrete model IDs unchanged", () => {
		const result = resolveModel("claude-haiku-4-5-20251001", ["anthropic"]);
		expect(result.model).toBe("claude-haiku-4-5-20251001");
		expect(result.provider).toBe("anthropic");
	});

	test("throws if no provider available for symbolic name", () => {
		expect(() => resolveModel("fast", [])).toThrow();
	});

	test("throws if concrete model provider not available", () => {
		expect(() => resolveModel("claude-opus-4-6", ["openai"])).toThrow();
	});
});
