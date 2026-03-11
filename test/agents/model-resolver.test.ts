import { describe, expect, test } from "bun:test";
import {
	defaultModelsByProvider,
	getAvailableModels,
	resolveModel,
} from "../../src/agents/model-resolver.ts";
import type { ModelRef, ProviderConfig, SproutSettings } from "../../src/host/settings/types.ts";
import type { ProviderCatalogEntry } from "../../src/llm/model-catalog.ts";
import type { ProviderModel } from "../../src/llm/types.ts";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "anthropic",
		kind: "anthropic",
		label: "Anthropic",
		enabled: true,
		discoveryStrategy: "remote-only",
		createdAt: "2026-03-11T12:00:00.000Z",
		updatedAt: "2026-03-11T12:00:00.000Z",
		...overrides,
	};
}

function settingsFor(providers: ProviderConfig[], providerPriority?: string[]): SproutSettings {
	return {
		version: 1,
		providers,
		defaults: { selection: { kind: "none" } },
		routing: {
			providerPriority: providerPriority ?? providers.filter((p) => p.enabled).map((p) => p.id),
			tierOverrides: {},
		},
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
	test("falls back from a tier override to the remaining global provider priority", () => {
		const settings = settingsFor(
			[
				provider({ id: "anthropic", kind: "anthropic" }),
				provider({ id: "openai", kind: "openai", label: "OpenAI" }),
			],
			["anthropic", "openai"],
		);
		settings.routing.tierOverrides.fast = ["anthropic"];
		const result = resolveModel(
			"fast",
			settings,
			catalog([
				{
					providerId: "anthropic",
					models: [model("claude-sonnet-4-6", { tierHint: "balanced", rank: 220 })],
				},
				{ providerId: "openai", models: [model("gpt-4.1-mini", { tierHint: "fast", rank: 100 })] },
			]),
		);

		expect(result).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
	});

	test("ignores disabled providers for tier routing", () => {
		const settings = settingsFor(
			[
				provider({ id: "anthropic", enabled: false }),
				provider({ id: "openai", kind: "openai", label: "OpenAI", enabled: true }),
			],
			["openai"],
		);
		const result = resolveModel(
			"fast",
			settings,
			catalog([
				{
					providerId: "anthropic",
					models: [model("claude-haiku-4-5-20251001", { tierHint: "fast", rank: 100 })],
				},
				{ providerId: "openai", models: [model("gpt-4.1-mini", { tierHint: "fast", rank: 100 })] },
			]),
		);

		expect(result).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
	});

	test("allows explicit ModelRef selection when the provider is enabled but the catalog is empty", () => {
		const settings = settingsFor(
			[provider({ id: "lmstudio", kind: "openai-compatible" })],
			["lmstudio"],
		);
		const result = resolveModel(
			{ providerId: "lmstudio", modelId: "qwen2.5-coder" } satisfies ModelRef,
			settings,
			catalog([{ providerId: "lmstudio", models: [] }]),
		);

		expect(result).toEqual({ provider: "lmstudio", model: "qwen2.5-coder" });
	});

	test("rejects ambiguous raw model ids across enabled providers", () => {
		const settings = settingsFor(
			[
				provider({ id: "lmstudio", kind: "openai-compatible" }),
				provider({ id: "openrouter", kind: "openrouter" }),
			],
			["lmstudio", "openrouter"],
		);

		expect(() =>
			resolveModel(
				"shared-model",
				settings,
				catalog([
					{ providerId: "lmstudio", models: [model("shared-model")] },
					{ providerId: "openrouter", models: [model("shared-model")] },
				]),
			),
		).toThrow(/ambiguous/i);
	});

	test("fails clearly when a saved explicit model points to a removed model", () => {
		const settings = settingsFor([provider({ id: "anthropic" })], ["anthropic"]);
		expect(() =>
			resolveModel(
				{ providerId: "anthropic", modelId: "claude-opus-4-6" } satisfies ModelRef,
				settings,
				catalog([{ providerId: "anthropic", models: [model("claude-sonnet-4-6")] }]),
			),
		).toThrow(/missing model/i);
	});

	test("orders provider candidates by descending rank then ascending id", () => {
		const settings = settingsFor([provider({ id: "openai", kind: "openai" })], ["openai"]);
		const result = resolveModel(
			"balanced",
			settings,
			catalog([
				{
					providerId: "openai",
					models: [
						model("gpt-4.1-b", { tierHint: "balanced", rank: 210 }),
						model("gpt-4.1-a", { tierHint: "balanced", rank: 210 }),
						model("gpt-4o", { tierHint: "balanced", rank: 205 }),
					],
				},
			]),
		);

		expect(result).toEqual({ provider: "openai", model: "gpt-4.1-a" });
	});

	test("classifies raw provider model metadata before tier routing", () => {
		const settings = settingsFor([provider({ id: "anthropic", kind: "anthropic" })], ["anthropic"]);
		const result = resolveModel(
			"best",
			settings,
			new Map([
				[
					"anthropic",
					[
						{ id: "claude-opus-4-6", label: "claude-opus-4-6", source: "remote" },
						{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", source: "remote" },
					],
				],
			]),
		);

		expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
	});
});

describe("getAvailableModels", () => {
	test("returns tier names plus all models from all providers", () => {
		const models = getAvailableModels(
			new Map([
				[
					"anthropic",
					[
						model("claude-opus-4-6", { tierHint: "best", rank: 300 }),
						model("claude-sonnet-4-6", { tierHint: "balanced", rank: 220 }),
					],
				],
				["openai", [model("gpt-5.1", { tierHint: "balanced", rank: 210 })]],
			]),
		);
		expect(models).toContain("best");
		expect(models).toContain("balanced");
		expect(models).toContain("fast");
		expect(models).toContain("claude-opus-4-6");
		expect(models).toContain("claude-sonnet-4-6");
		expect(models).toContain("gpt-5.1");
	});

	test("deduplicates models", () => {
		const models = getAvailableModels(
			new Map([
				["anthropic", [model("claude-opus-4-6", { tierHint: "best", rank: 300 })]],
				["openai", [model("gpt-5.1", { tierHint: "balanced", rank: 210 })]],
			]),
		);
		const opusCount = models.filter((m) => m === "claude-opus-4-6").length;
		expect(opusCount).toBe(1);
	});

	test("returns only tier names when map is empty", () => {
		const models = getAvailableModels(new Map());
		expect(models).toEqual(["best", "balanced", "fast"]);
	});
});

describe("defaultModelsByProvider", () => {
	test("returns provider-model metadata instead of raw strings", () => {
		const defaults = defaultModelsByProvider(["anthropic", "openai"]);
		expect(defaults.get("anthropic")?.[0]).toMatchObject({
			id: "claude-opus-4-6",
			tierHint: "best",
		});
		expect(defaults.get("openai")?.[0]).toMatchObject({
			id: "o3-pro",
			tierHint: "best",
		});
	});
});
