import { describe, expect, test } from "bun:test";
import { detectProvider, getAvailableModels, resolveModel } from "../../src/agents/model-resolver.ts";

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
	test("resolves 'best' to opus-class models", () => {
		const anthropic = resolveModel("best", ["anthropic"]);
		expect(anthropic.model).toBe("claude-opus-4-6");
		expect(anthropic.provider).toBe("anthropic");

		const openai = resolveModel("best", ["openai"]);
		expect(openai.model).toBe("gpt-4.1");
		expect(openai.provider).toBe("openai");

		const gemini = resolveModel("best", ["gemini"]);
		expect(gemini.model).toBe("gemini-2.5-pro");
		expect(gemini.provider).toBe("gemini");
	});

	test("resolves 'balanced' to sonnet-class models", () => {
		const anthropic = resolveModel("balanced", ["anthropic"]);
		expect(anthropic.model).toBe("claude-sonnet-4-6");
		expect(anthropic.provider).toBe("anthropic");

		const openai = resolveModel("balanced", ["openai"]);
		expect(openai.model).toBe("gpt-4.1");
		expect(openai.provider).toBe("openai");

		const gemini = resolveModel("balanced", ["gemini"]);
		expect(gemini.model).toBe("gemini-2.5-flash");
		expect(gemini.provider).toBe("gemini");
	});

	test("resolves 'fast' to haiku-class models", () => {
		const anthropic = resolveModel("fast", ["anthropic", "openai", "gemini"]);
		expect(anthropic.model).toBe("claude-haiku-4-5-20251001");
		expect(anthropic.provider).toBe("anthropic");

		const openai = resolveModel("fast", ["openai"]);
		expect(openai.model).toBe("gpt-4.1-mini");
		expect(openai.provider).toBe("openai");

		const gemini = resolveModel("fast", ["gemini"]);
		expect(gemini.model).toBe("gemini-2.5-flash");
		expect(gemini.provider).toBe("gemini");
	});

	test("resolves tiers using provider priority order", () => {
		const result = resolveModel("fast", ["gemini", "openai", "anthropic"]);
		expect(result.provider).toBe("anthropic");
		expect(result.model).toBe("claude-haiku-4-5-20251001");
	});

	test("skips unavailable providers", () => {
		const result = resolveModel("fast", ["openai"]);
		expect(result.provider).toBe("openai");
		expect(result.model).toBe("gpt-4.1-mini");
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

describe("getAvailableModels", () => {
	test("returns tier names plus concrete models for given providers", () => {
		const models = getAvailableModels(["anthropic"]);
		expect(models).toContain("best");
		expect(models).toContain("balanced");
		expect(models).toContain("fast");
		expect(models).toContain("claude-opus-4-6");
		expect(models).toContain("claude-sonnet-4-6");
		expect(models).toContain("claude-haiku-4-5-20251001");
		expect(models).not.toContain("gpt-4.1");
		expect(models).not.toContain("gemini-2.5-pro");
	});

	test("collects models from multiple providers, deduped", () => {
		const models = getAvailableModels(["anthropic", "openai"]);
		expect(models).toContain("claude-opus-4-6");
		expect(models).toContain("gpt-4.1");
		expect(models).toContain("gpt-4.1-mini");
		// gpt-4.1 appears in both "best" and "balanced" tiers — should not be duplicated
		const gpt41Count = models.filter((m) => m === "gpt-4.1").length;
		expect(gpt41Count).toBe(1);
	});

	test("returns only tier names when no providers given", () => {
		const models = getAvailableModels([]);
		expect(models).toEqual(["best", "balanced", "fast"]);
	});

	test("includes all providers when all are available", () => {
		const models = getAvailableModels(["anthropic", "openai", "gemini"]);
		expect(models).toContain("claude-opus-4-6");
		expect(models).toContain("gpt-4.1");
		expect(models).toContain("gemini-2.5-pro");
		expect(models).toContain("gemini-2.5-flash");
	});
});
