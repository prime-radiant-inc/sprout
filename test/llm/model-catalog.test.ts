import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../../src/host/settings/types.ts";
import {
	buildCatalogEntry,
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

describe("buildCatalogEntry", () => {
	test("normalizes remote provider models", () => {
		const entry = buildCatalogEntry(provider(), {
			remoteModels: [
				model("claude-sonnet-4-6", { label: undefined, source: undefined }),
				model("claude-haiku-4-5-20251001"),
			],
		});

		expect(entry.models).toEqual([
			{
				id: "claude-sonnet-4-6",
				label: "claude-sonnet-4-6",
				source: "remote",
			},
			{
				id: "claude-haiku-4-5-20251001",
				label: "claude-haiku-4-5-20251001",
				source: "remote",
			},
		]);
	});

	test("invalid providers retain the last cached remote models", () => {
		const entry = buildCatalogEntry(provider(), {
			cachedModels: [model("claude-sonnet-4-6")],
			validationErrors: ["API key is required"],
		});

		expect(entry.models).toEqual([
			{
				id: "claude-sonnet-4-6",
				label: "claude-sonnet-4-6",
				source: "remote",
			},
		]);
	});

	test("disabled providers retain cached remote models for UI display", () => {
		const entry = buildCatalogEntry(
			provider({
				id: "lmstudio",
				kind: "openai-compatible",
				enabled: false,
			}),
			{
				cachedModels: [
					{
						id: "qwen2.5-coder",
						label: "Qwen 2.5 Coder",
						source: "remote",
					},
				],
			},
		);

		expect(entry.models).toEqual([
			{
				id: "qwen2.5-coder",
				label: "Qwen 2.5 Coder",
				source: "remote",
			},
		]);
	});

	test("enabled providers prefer fresh remote models over cached ones", () => {
		const entry = buildCatalogEntry(provider(), {
			cachedModels: [model("claude-sonnet-4-6")],
			remoteModels: [model("claude-opus-4-1")],
		});

		expect(entry.models).toEqual([
			{
				id: "claude-opus-4-1",
				label: "claude-opus-4-1",
				source: "remote",
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
					source: "remote",
				},
			],
			lastRefreshAt: "2026-03-11T12:34:56.000Z",
		});
		expect(catalog.getEntry("gemini")).toEqual(entry);
	});
});
