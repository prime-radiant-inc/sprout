import { describe, expect, test } from "bun:test";
import {
	classifyTier,
	detectProvider,
	getAvailableModels,
	resolveModel,
} from "../../src/agents/model-resolver.ts";

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

describe("classifyTier", () => {
	test("classifies opus/pro models as best", () => {
		expect(classifyTier("claude-opus-4-6")).toBe("best");
		expect(classifyTier("gemini-2.5-pro")).toBe("best");
		expect(classifyTier("o3-pro")).toBe("best");
	});

	test("classifies sonnet models as balanced", () => {
		expect(classifyTier("claude-sonnet-4-6")).toBe("balanced");
		expect(classifyTier("claude-sonnet-4-5-20251001")).toBe("balanced");
	});

	test("classifies haiku/mini/flash/nano models as fast", () => {
		expect(classifyTier("claude-haiku-4-5-20251001")).toBe("fast");
		expect(classifyTier("gpt-4.1-mini")).toBe("fast");
		expect(classifyTier("o4-mini")).toBe("fast");
		expect(classifyTier("gemini-2.5-flash")).toBe("fast");
		expect(classifyTier("gpt-4.1-nano")).toBe("fast");
	});

	test("returns null for unclassifiable models", () => {
		expect(classifyTier("gpt-4.1")).toBeNull();
		expect(classifyTier("some-custom-model")).toBeNull();
	});
});

// Helper to build a models-by-provider map for tests
function modelsMap(entries: Record<string, string[]>): Map<string, string[]> {
	return new Map(Object.entries(entries));
}

describe("resolveModel", () => {
	const allModels = modelsMap({
		anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
		openai: ["gpt-5.1", "gpt-5.1-mini", "o4-mini"],
		gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
	});

	test("resolves 'best' using classifyTier and provider priority", () => {
		const result = resolveModel("best", allModels);
		expect(result.provider).toBe("anthropic");
		expect(result.model).toBe("claude-opus-4-6");
	});

	test("resolves 'best' to gemini pro when only gemini available", () => {
		const geminiOnly = modelsMap({ gemini: ["gemini-2.5-pro", "gemini-2.5-flash"] });
		const result = resolveModel("best", geminiOnly);
		expect(result.provider).toBe("gemini");
		expect(result.model).toBe("gemini-2.5-pro");
	});

	test("resolves 'balanced' to sonnet", () => {
		const result = resolveModel("balanced", allModels);
		expect(result.provider).toBe("anthropic");
		expect(result.model).toBe("claude-sonnet-4-6");
	});

	test("resolves 'fast' to haiku with provider priority", () => {
		const result = resolveModel("fast", allModels);
		expect(result.provider).toBe("anthropic");
		expect(result.model).toBe("claude-haiku-4-5-20251001");
	});

	test("resolves 'fast' to mini when only openai available", () => {
		const openaiOnly = modelsMap({ openai: ["gpt-5.1", "gpt-5.1-mini"] });
		const result = resolveModel("fast", openaiOnly);
		expect(result.provider).toBe("openai");
		expect(result.model).toBe("gpt-5.1-mini");
	});

	test("passes through concrete model IDs unchanged", () => {
		const result = resolveModel("claude-haiku-4-5-20251001", allModels);
		expect(result.model).toBe("claude-haiku-4-5-20251001");
		expect(result.provider).toBe("anthropic");
	});

	test("throws if no model matches the requested tier", () => {
		const noBalanced = modelsMap({ openai: ["gpt-5.1", "gpt-5.1-mini"] });
		expect(() => resolveModel("balanced", noBalanced)).toThrow();
	});

	test("throws if concrete model provider not in map", () => {
		const geminiOnly = modelsMap({ gemini: ["gemini-2.5-pro"] });
		expect(() => resolveModel("claude-opus-4-6", geminiOnly)).toThrow();
	});

	test("throws on empty map for tier", () => {
		expect(() => resolveModel("fast", new Map())).toThrow();
	});
});

describe("getAvailableModels", () => {
	test("returns tier names plus all models from all providers", () => {
		const map = modelsMap({
			anthropic: ["claude-opus-4-6", "claude-sonnet-4-6"],
			openai: ["gpt-5.1"],
		});
		const models = getAvailableModels(map);
		expect(models).toContain("best");
		expect(models).toContain("balanced");
		expect(models).toContain("fast");
		expect(models).toContain("claude-opus-4-6");
		expect(models).toContain("claude-sonnet-4-6");
		expect(models).toContain("gpt-5.1");
	});

	test("deduplicates models", () => {
		const map = modelsMap({
			anthropic: ["claude-opus-4-6"],
			openai: ["gpt-5.1"],
		});
		const models = getAvailableModels(map);
		const opusCount = models.filter((m) => m === "claude-opus-4-6").length;
		expect(opusCount).toBe(1);
	});

	test("returns only tier names when map is empty", () => {
		const models = getAvailableModels(new Map());
		expect(models).toEqual(["best", "balanced", "fast"]);
	});
});
