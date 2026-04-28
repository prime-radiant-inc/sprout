import { describe, expect, test } from "bun:test";
import {
	resolveAgentModelSelection,
	resolveMemoryModel,
	resolveModel,
} from "../../src/agents/model-resolver.ts";
import type { ModelRef, ProviderConfig, SproutSettings } from "../../src/host/settings/types.ts";
import type { ProviderCatalogEntry } from "../../src/llm/model-catalog.ts";
import type { ProviderModel } from "../../src/llm/types.ts";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "anthropic-main",
		kind: "anthropic",
		label: "Anthropic",
		enabled: true,
		createdAt: "2026-03-11T12:00:00.000Z",
		updatedAt: "2026-03-11T12:00:00.000Z",
		...overrides,
	};
}

function settingsFor(
	providers: ProviderConfig[],
	defaults: SproutSettings["defaults"] = {},
	memoryModels: SproutSettings["memoryModels"] = {},
	agentModelOverrides: SproutSettings["agentModelOverrides"] = {},
): SproutSettings {
	return {
		version: 4,
		providers,
		defaults,
		memoryModels,
		agentModelOverrides,
	};
}

function model(id: string, overrides: Partial<ProviderModel> = {}): ProviderModel {
	return {
		id,
		label: id,
		source: "remote",
		...overrides,
	};
}

function catalog(
	entries: Array<{ providerId: string; models: ProviderModel[] }>,
): ProviderCatalogEntry[] {
	return entries.map((entry) => ({
		providerId: entry.providerId,
		models: entry.models,
	}));
}

describe("resolveModel", () => {
	test("resolves tiers from global provider-model defaults", () => {
		const settings = settingsFor(
			[
				provider({
					id: "openrouter-main",
					kind: "openrouter",
					label: "OpenRouter",
				}),
				provider({
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
				}),
			],
			{
				best: {
					providerId: "lmstudio",
					modelId: "qwen2.5-coder",
				},
			},
		);

		const result = resolveModel(
			"best",
			settings,
			catalog([
				{
					providerId: "openrouter-main",
					models: [model("anthropic/claude-opus-4.1")],
				},
				{
					providerId: "lmstudio",
					models: [model("qwen2.5-coder")],
				},
			]),
		);

		expect(result).toEqual({ provider: "lmstudio", model: "qwen2.5-coder" });
	});

	test("uses the configured global tier tuple regardless of the selected provider", () => {
		const settings = settingsFor(
			[
				provider({
					id: "openrouter-main",
					kind: "openrouter",
					label: "OpenRouter",
				}),
				provider({
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
				}),
			],
			{
				fast: {
					providerId: "lmstudio",
					modelId: "qwen2.5-coder",
				},
			},
		);

		const result = resolveModel(
			"fast",
			settings,
			catalog([
				{
					providerId: "openrouter-main",
					models: [model("openai/gpt-4o-mini")],
				},
				{
					providerId: "lmstudio",
					models: [model("qwen2.5-coder")],
				},
			]),
		);

		expect(result).toEqual({ provider: "lmstudio", model: "qwen2.5-coder" });
	});

	test("fails clearly when a global tier default is missing", () => {
		expect(() => resolveModel("best", settingsFor([provider()]), catalog([]))).toThrow(
			/global 'best' model/i,
		);
	});

	test("fails clearly when a global tier default references a disabled provider", () => {
		const settings = settingsFor(
			[
				provider({
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
					enabled: false,
				}),
			],
			{
				fast: {
					providerId: "lmstudio",
					modelId: "qwen2.5-coder",
				},
			},
		);

		expect(() => resolveModel("fast", settings, catalog([]))).toThrow(/disabled provider/i);
	});

	test("accepts explicit model refs when the provider is enabled", () => {
		const settings = settingsFor([provider({ id: "lmstudio", kind: "openai-compatible" })]);
		const result = resolveModel(
			{ providerId: "lmstudio", modelId: "qwen2.5-coder" } satisfies ModelRef,
			settings,
			catalog([{ providerId: "lmstudio", models: [] }]),
		);

		expect(result).toEqual({ provider: "lmstudio", model: "qwen2.5-coder" });
	});

	test("accepts provider-qualified exact model strings", () => {
		const settings = settingsFor([provider({ id: "lmstudio", kind: "openai-compatible" })]);

		expect(
			resolveModel(
				"lmstudio:qwen2.5-coder",
				settings,
				catalog([{ providerId: "lmstudio", models: [] }]),
			),
		).toEqual({ provider: "lmstudio", model: "qwen2.5-coder" });
	});

	test("rejects bare model ids without provider context", () => {
		expect(() =>
			resolveModel(
				"claude-sonnet-4-6",
				settingsFor([provider()]),
				catalog([{ providerId: "anthropic-main", models: [model("claude-sonnet-4-6")] }]),
			),
		).toThrow(/provider/i);
	});
});

describe("resolveAgentModelSelection", () => {
	test("resolves configured agent model overrides without falling back to defaults", () => {
		const settings = settingsFor(
			[provider()],
			{
				fast: {
					providerId: "anthropic-main",
					modelId: "claude-haiku-4-5",
				},
			},
			{},
			{
				metacognitive: {
					kind: "model",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
			},
		);

		expect(
			resolveAgentModelSelection(
				{
					agentKey: "metacognitive",
					agentName: "metacognitive",
					specModel: "fast",
					settings,
				},
				catalog([
					{
						providerId: "anthropic-main",
						models: [model("claude-sonnet-4-6")],
					},
				]),
			),
		).toEqual({ provider: "anthropic-main", model: "claude-sonnet-4-6" });
	});

	test("uses markdown default when an agent override is missing", () => {
		expect(() =>
			resolveAgentModelSelection(
				{
					agentKey: "metacognitive",
					agentName: "metacognitive",
					specModel: "fast",
					settings: settingsFor([provider()]),
				},
				catalog([]),
			),
		).toThrow("No global 'fast' model is configured");
	});
});

describe("resolveMemoryModel", () => {
	test("resolves every configured memory purpose to its exact provider and model", () => {
		const settings = settingsFor(
			[
				provider({
					id: "anthropic-main",
					kind: "anthropic",
				}),
				provider({
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
				}),
			],
			{},
			{
				summary: { providerId: "anthropic-main", modelId: "claude-opus-4-6" },
				extraction: { providerId: "anthropic-main", modelId: "claude-sonnet-4-6" },
				relationship: { providerId: "lmstudio", modelId: "qwen2.5-coder" },
				consolidation: { providerId: "anthropic-main", modelId: "claude-sonnet-4-6" },
				entityGc: { providerId: "lmstudio", modelId: "qwen2.5-coder" },
				subcortical: { providerId: "lmstudio", modelId: "qwen2.5-coder" },
			},
		);

		const models = catalog([
			{
				providerId: "anthropic-main",
				models: [model("claude-opus-4-6"), model("claude-sonnet-4-6")],
			},
			{
				providerId: "lmstudio",
				models: [model("qwen2.5-coder")],
			},
		]);

		expect(resolveMemoryModel("summary", settings, models)).toEqual({
			provider: "anthropic-main",
			model: "claude-opus-4-6",
		});
		expect(resolveMemoryModel("extraction", settings, models)).toEqual({
			provider: "anthropic-main",
			model: "claude-sonnet-4-6",
		});
		expect(resolveMemoryModel("relationship", settings, models)).toEqual({
			provider: "lmstudio",
			model: "qwen2.5-coder",
		});
		expect(resolveMemoryModel("consolidation", settings, models)).toEqual({
			provider: "anthropic-main",
			model: "claude-sonnet-4-6",
		});
		expect(resolveMemoryModel("entityGc", settings, models)).toEqual({
			provider: "lmstudio",
			model: "qwen2.5-coder",
		});
		expect(resolveMemoryModel("subcortical", settings, models)).toEqual({
			provider: "lmstudio",
			model: "qwen2.5-coder",
		});
	});

	test("fails clearly when a memory purpose is missing", () => {
		expect(() => resolveMemoryModel("summary", settingsFor([provider()]), catalog([]))).toThrow(
			"No memory 'summary' model is configured",
		);
	});

	test("does not fall back to global defaults for memory purposes", () => {
		const settings = settingsFor(
			[provider()],
			{
				best: {
					providerId: "anthropic-main",
					modelId: "claude-opus-4-6",
				},
			},
			{},
		);

		expect(() => resolveMemoryModel("extraction", settings, catalog([]))).toThrow(
			"No memory 'extraction' model is configured",
		);
	});

	test("rejects memory refs with unknown or disabled providers", () => {
		expect(() =>
			resolveMemoryModel(
				"extraction",
				settingsFor([], {}, { extraction: { providerId: "missing", modelId: "model" } }),
				catalog([]),
			),
		).toThrow("Unknown provider 'missing'");

		expect(() =>
			resolveMemoryModel(
				"extraction",
				settingsFor(
					[provider({ id: "anthropic-main", enabled: false })],
					{},
					{ extraction: { providerId: "anthropic-main", modelId: "model" } },
				),
				catalog([]),
			),
		).toThrow("Provider 'anthropic-main' is disabled");
	});

	test("allows exact memory refs before a provider catalog is loaded", () => {
		const settings = settingsFor(
			[provider()],
			{},
			{ extraction: { providerId: "anthropic-main", modelId: "operator-asserted-model" } },
		);

		expect(resolveMemoryModel("extraction", settings, catalog([]))).toEqual({
			provider: "anthropic-main",
			model: "operator-asserted-model",
		});
	});

	test("rejects memory refs missing from a populated provider catalog", () => {
		const settings = settingsFor(
			[provider()],
			{},
			{ extraction: { providerId: "anthropic-main", modelId: "missing-model" } },
		);

		expect(() =>
			resolveMemoryModel(
				"extraction",
				settings,
				catalog([{ providerId: "anthropic-main", models: [model("claude-sonnet-4-6")] }]),
			),
		).toThrow("Missing model 'missing-model' for provider 'anthropic-main'");
	});
});
