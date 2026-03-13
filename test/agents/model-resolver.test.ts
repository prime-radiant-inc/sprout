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
		discoveryStrategy: "remote-only",
		createdAt: "2026-03-11T12:00:00.000Z",
		updatedAt: "2026-03-11T12:00:00.000Z",
		...overrides,
	};
}

function settingsFor(providers: ProviderConfig[], defaultProviderId?: string): SproutSettings {
	return {
		version: 1,
		providers,
		defaults: defaultProviderId ? { defaultProviderId } : {},
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
	test("resolves tiers only from the selected provider tier defaults", () => {
		const settings = settingsFor(
			[
				provider({
					id: "openrouter-main",
					kind: "openrouter",
					label: "OpenRouter",
					tierDefaults: {
						best: "anthropic/claude-opus-4.1",
					},
				}),
				provider({
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
					tierDefaults: {
						best: "qwen2.5-coder",
					},
				}),
			],
			"openrouter-main",
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
			{ providerId: "lmstudio" },
		);

		expect(result).toEqual({ provider: "lmstudio", model: "qwen2.5-coder" });
	});

	test("falls back to the default provider when no provider context is supplied", () => {
		const settings = settingsFor(
			[
				provider({
					id: "openrouter-main",
					kind: "openrouter",
					label: "OpenRouter",
					tierDefaults: {
						fast: "openai/gpt-4o-mini",
					},
				}),
			],
			"openrouter-main",
		);

		const result = resolveModel(
			"fast",
			settings,
			catalog([
				{
					providerId: "openrouter-main",
					models: [model("openai/gpt-4o-mini")],
				},
			]),
		);

		expect(result).toEqual({ provider: "openrouter-main", model: "openai/gpt-4o-mini" });
	});

	test("fails clearly when no provider can be chosen for a tier", () => {
		expect(() => resolveModel("best", settingsFor([provider()]), catalog([]))).toThrow(/provider/i);
	});

	test("fails clearly when the selected provider does not define the requested tier", () => {
		const settings = settingsFor(
			[
				provider({
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
				}),
			],
			"lmstudio",
		);

		expect(() => resolveModel("fast", settings, catalog([]), { providerId: "lmstudio" })).toThrow(
			/does not define a 'fast' model/i,
		);
	});

	test("accepts explicit model refs when the provider is enabled", () => {
		const settings = settingsFor(
			[provider({ id: "lmstudio", kind: "openai-compatible" })],
			"lmstudio",
		);
		const result = resolveModel(
			{ providerId: "lmstudio", modelId: "qwen2.5-coder" } satisfies ModelRef,
			settings,
			catalog([{ providerId: "lmstudio", models: [] }]),
		);

		expect(result).toEqual({ provider: "lmstudio", model: "qwen2.5-coder" });
	});

	test("rejects bare model ids without provider context", () => {
		expect(() =>
			resolveModel(
				"claude-sonnet-4-6",
				settingsFor([provider()], "anthropic-main"),
				catalog([{ providerId: "anthropic-main", models: [model("claude-sonnet-4-6")] }]),
			),
		).toThrow(/provider/i);
	});
});
