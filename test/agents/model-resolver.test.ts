import { describe, expect, test } from "bun:test";
import { resolveModel } from "../../src/agents/model-resolver.ts";
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
): SproutSettings {
	return {
		version: 2,
		providers,
		defaults,
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
