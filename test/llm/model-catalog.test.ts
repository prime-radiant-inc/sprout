import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../../src/host/settings/types.ts";
import {
	buildCatalogEntry,
	classifyTier,
	ModelCatalog,
	type ProviderCatalogEntry,
} from "../../src/llm/model-catalog.ts";
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

function model(id: string, overrides: Partial<ProviderModel> = {}): ProviderModel {
	return {
		id,
		label: id,
		source: "remote",
		...overrides,
	};
}

describe("classifyTier", () => {
	test("assigns deterministic tiers and ranks", () => {
		expect(classifyTier("claude-opus-4-6")).toEqual({ tierHint: "best", rank: 300 });
		expect(classifyTier("o3-pro")).toEqual({ tierHint: "best", rank: 280 });
		expect(classifyTier("claude-sonnet-4-6")).toEqual({ tierHint: "balanced", rank: 220 });
		expect(classifyTier("gpt-4.1")).toEqual({ tierHint: "balanced", rank: 210 });
		expect(classifyTier("gpt-4.1-mini")).toEqual({ tierHint: "fast", rank: 100 });
		expect(classifyTier("custom-model")).toBeNull();
	});
});

describe("buildCatalogEntry", () => {
	test("supports manual-only providers", () => {
		const entry = buildCatalogEntry(
			provider({
				id: "lmstudio",
				kind: "openai-compatible",
				discoveryStrategy: "manual-only",
				manualModels: [{ id: "qwen2.5-coder", label: "Qwen", tierHint: "fast", rank: 95 }],
			}),
			{},
		);

		expect(entry.models).toEqual([
			{ id: "qwen2.5-coder", label: "Qwen", tierHint: "fast", rank: 95, source: "manual" },
		]);
	});

	test("classifies remote-only provider models", () => {
		const entry = buildCatalogEntry(provider(), {
			remoteModels: [model("claude-sonnet-4-6"), model("claude-haiku-4-5-20251001")],
		});

		expect(entry.models).toEqual([
			{
				id: "claude-sonnet-4-6",
				label: "claude-sonnet-4-6",
				tierHint: "balanced",
				rank: 220,
				source: "remote",
			},
			{
				id: "claude-haiku-4-5-20251001",
				label: "claude-haiku-4-5-20251001",
				tierHint: "fast",
				rank: 100,
				source: "remote",
			},
		]);
	});

	test("remote-with-manual merges remote models first and fills missing metadata from manual entries", () => {
		const entry = buildCatalogEntry(
			provider({
				id: "openai",
				kind: "openai",
				discoveryStrategy: "remote-with-manual",
				manualModels: [
					{ id: "gpt-4.1", label: "GPT 4.1", tierHint: "balanced", rank: 215 },
					{ id: "custom-fast", label: "Custom Fast", tierHint: "fast", rank: 90 },
				],
			}),
			{
				remoteModels: [model("gpt-4.1", { rank: undefined, tierHint: undefined })],
			},
		);

		expect(entry.models).toEqual([
			{
				id: "gpt-4.1",
				label: "gpt-4.1",
				tierHint: "balanced",
				rank: 210,
				source: "remote",
			},
			{
				id: "custom-fast",
				label: "Custom Fast",
				tierHint: "fast",
				rank: 90,
				source: "manual",
			},
		]);
	});

	test("invalid providers expose no remote-discovered catalog entries", () => {
		const entry = buildCatalogEntry(provider(), {
			remoteModels: [model("claude-sonnet-4-6")],
			validationErrors: ["API key is required"],
		});

		expect(entry.models).toEqual([]);
	});

	test("disabled providers may retain cached or manual catalog entries for UI display", () => {
		const entry = buildCatalogEntry(
			provider({
				id: "lmstudio",
				kind: "openai-compatible",
				enabled: false,
				discoveryStrategy: "remote-with-manual",
				manualModels: [{ id: "custom-fast", label: "Custom Fast", tierHint: "fast", rank: 90 }],
			}),
			{
				cachedModels: [
					{
						id: "qwen2.5-coder",
						label: "Qwen 2.5 Coder",
						tierHint: "balanced",
						rank: 205,
						source: "remote",
					},
				],
			},
		);

		expect(entry.models).toEqual([
			{
				id: "qwen2.5-coder",
				label: "Qwen 2.5 Coder",
				tierHint: "balanced",
				rank: 205,
				source: "remote",
			},
			{
				id: "custom-fast",
				label: "Custom Fast",
				tierHint: "fast",
				rank: 90,
				source: "manual",
			},
		]);
	});
});

describe("ModelCatalog", () => {
	test("stores refreshed entries by provider id", () => {
		const catalog = new ModelCatalog();
		const entry = catalog.refreshProvider(
			provider({
				id: "gemini",
				kind: "gemini",
			}),
			[model("gemini-2.5-flash")],
			"2026-03-11T12:34:56.000Z",
		);

		expect(entry).toEqual<ProviderCatalogEntry>({
			providerId: "gemini",
			models: [
				{
					id: "gemini-2.5-flash",
					label: "gemini-2.5-flash",
					tierHint: "fast",
					rank: 100,
					source: "remote",
				},
			],
			lastRefreshAt: "2026-03-11T12:34:56.000Z",
		});
		expect(catalog.getEntry("gemini")).toEqual(entry);
	});
});
