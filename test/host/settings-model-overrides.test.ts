import { describe, expect, test } from "bun:test";
import {
	applyModelConfigOverrides,
	buildModelConfigOverrideSnapshot,
	findModelConfigOverridesForProvider,
	parseModelConfigOverrides,
	validateModelConfigOverrides,
} from "../../src/host/settings/model-overrides.ts";
import { createEmptySettings } from "../../src/host/settings/types.ts";

describe("model config env overrides", () => {
	test("parses global and memory model env vars without inferring memory defaults", () => {
		const overrides = parseModelConfigOverrides({
			SPROUT_DEFAULT_BEST_MODEL: "openrouter:openai/gpt-4o-mini",
			SPROUT_MEMORY_EXTRACTION_MODEL: "anthropic:claude-sonnet-4-6",
			SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
				metacognitive: "anthropic:claude-haiku-4-5",
				"utility/reader": "fast",
			}),
		});

		expect(overrides.defaults.best).toMatchObject({
			source: "env",
			envVar: "SPROUT_DEFAULT_BEST_MODEL",
			model: {
				providerId: "openrouter",
				modelId: "openai/gpt-4o-mini",
			},
			catalogStatus: "not_loaded",
		});
		expect(overrides.memoryModels.extraction).toMatchObject({
			source: "env",
			envVar: "SPROUT_MEMORY_EXTRACTION_MODEL",
			model: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
			},
		});
		expect(overrides.memoryModels.summary).toBeUndefined();
		expect(overrides.agentModelOverrides.metacognitive).toMatchObject({
			source: "env",
			envVar: "SPROUT_AGENT_MODEL_OVERRIDES",
			selection: {
				kind: "model",
				model: {
					providerId: "anthropic",
					modelId: "claude-haiku-4-5",
				},
			},
		});
		expect(overrides.agentModelOverrides["utility/reader"]?.selection).toEqual({
			kind: "tier",
			tier: "fast",
		});
	});

	test("rejects malformed env override values with the env var name", () => {
		expect(() =>
			parseModelConfigOverrides({
				SPROUT_MEMORY_SUMMARY_MODEL: "gpt-4o",
			}),
		).toThrow(/SPROUT_MEMORY_SUMMARY_MODEL/);
	});

	test("validates unknown and disabled override providers", () => {
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "openrouter",
					kind: "openrouter" as const,
					label: "OpenRouter",
					enabled: false,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			],
		};

		expect(() =>
			validateModelConfigOverrides(
				parseModelConfigOverrides({
					SPROUT_MEMORY_EXTRACTION_MODEL: "missing:claude-sonnet-4-6",
				}),
				settings,
			),
		).toThrow(/SPROUT_MEMORY_EXTRACTION_MODEL references unknown provider 'missing'/);

		expect(() =>
			validateModelConfigOverrides(
				parseModelConfigOverrides({
					SPROUT_DEFAULT_FAST_MODEL: "openrouter:openai/gpt-4o-mini",
				}),
				settings,
			),
		).toThrow(/SPROUT_DEFAULT_FAST_MODEL references disabled provider 'openrouter'/);
	});

	test("validates agent override keys and tier defaults", () => {
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "anthropic",
					kind: "anthropic" as const,
					label: "Anthropic",
					enabled: true,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			],
			defaults: {
				balanced: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
				},
			},
		};

		expect(() =>
			validateModelConfigOverrides(
				parseModelConfigOverrides({
					SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
						reader: "balanced",
					}),
				}),
				settings,
				{ agentKeys: ["utility/reader"] },
			),
		).toThrow(/SPROUT_AGENT_MODEL_OVERRIDES\.reader references unknown agent key 'reader'/);

		expect(() =>
			validateModelConfigOverrides(
				parseModelConfigOverrides({
					SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
						"utility/reader": "fast",
					}),
				}),
				settings,
				{ agentKeys: ["utility/reader"] },
			),
		).toThrow(
			/SPROUT_AGENT_MODEL_OVERRIDES\.utility\/reader references unconfigured global 'fast' model/,
		);

		expect(() =>
			validateModelConfigOverrides(
				parseModelConfigOverrides({
					SPROUT_DEFAULT_FAST_MODEL: "anthropic:claude-haiku-4-5",
					SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
						"utility/reader": "fast",
					}),
				}),
				settings,
				{ agentKeys: ["utility/reader"] },
			),
		).not.toThrow();
	});

	test("applies env overrides to effective settings without mutating stored settings", () => {
		const settings = {
			...createEmptySettings(),
			defaults: {
				best: { providerId: "anthropic", modelId: "claude-opus-4-6" },
			},
			memoryModels: {
				extraction: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
			},
			agentModelOverrides: {
				metacognitive: {
					kind: "model" as const,
					model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
				},
			},
		};
		const overrides = parseModelConfigOverrides({
			SPROUT_DEFAULT_BEST_MODEL: "openrouter:openai/gpt-4o-mini",
			SPROUT_MEMORY_EXTRACTION_MODEL: "openrouter:openai/gpt-4o-mini",
			SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
				metacognitive: "openrouter:openai/gpt-4o-mini",
			}),
		});

		const effective = applyModelConfigOverrides(settings, overrides);

		expect(effective.defaults.best).toEqual({
			providerId: "openrouter",
			modelId: "openai/gpt-4o-mini",
		});
		expect(effective.memoryModels.extraction).toEqual({
			providerId: "openrouter",
			modelId: "openai/gpt-4o-mini",
		});
		expect(effective.memoryModels.subcortical).toBeUndefined();
		expect(effective.agentModelOverrides.metacognitive).toEqual({
			kind: "model",
			model: {
				providerId: "openrouter",
				modelId: "openai/gpt-4o-mini",
			},
		});
		expect(settings.defaults.best).toEqual({
			providerId: "anthropic",
			modelId: "claude-opus-4-6",
		});
		expect(settings.memoryModels.extraction).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		expect(settings.agentModelOverrides.metacognitive).toEqual({
			kind: "model",
			model: {
				providerId: "anthropic",
				modelId: "claude-haiku-4-5",
			},
		});
	});

	test("annotates override catalog status for runtime snapshots", () => {
		const overrides = parseModelConfigOverrides({
			SPROUT_DEFAULT_BEST_MODEL: "openrouter:openai/gpt-4o-mini",
			SPROUT_MEMORY_RELATIONSHIP_MODEL: "anthropic:missing-model",
			SPROUT_MEMORY_SUBCORTICAL_MODEL: "local:qwen2.5-coder",
			SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
				metacognitive: "anthropic:missing-model",
			}),
		});

		const snapshot = buildModelConfigOverrideSnapshot(overrides, [
			{
				providerId: "openrouter",
				models: [{ id: "openai/gpt-4o-mini", label: "GPT-4o mini", source: "remote" }],
			},
			{
				providerId: "anthropic",
				models: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", source: "remote" }],
			},
		]);

		expect(snapshot.defaults.best).toMatchObject({
			catalogStatus: "matched",
			displayLabel: "GPT-4o mini",
		});
		expect(snapshot.memoryModels.relationship).toMatchObject({
			catalogStatus: "missing",
			diagnostic: "Model 'missing-model' is not in the loaded catalog for provider 'anthropic'",
		});
		expect(snapshot.memoryModels.subcortical).toMatchObject({
			catalogStatus: "not_loaded",
		});
		expect(snapshot.agentModelOverrides.metacognitive).toMatchObject({
			selection: {
				kind: "model",
				model: { providerId: "anthropic", modelId: "missing-model" },
			},
			diagnostic: "Model 'missing-model' is not in the loaded catalog for provider 'anthropic'",
		});
	});

	test("finds env overrides that block provider lifecycle actions", () => {
		const overrides = parseModelConfigOverrides({
			SPROUT_DEFAULT_FAST_MODEL: "lmstudio:qwen2.5-coder",
			SPROUT_MEMORY_SUBCORTICAL_MODEL: "lmstudio:qwen2.5-coder",
			SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
				metacognitive: "lmstudio:qwen2.5-coder",
			}),
		});

		expect(
			findModelConfigOverridesForProvider(overrides, "lmstudio").map((override) => override.envVar),
		).toEqual([
			"SPROUT_DEFAULT_FAST_MODEL",
			"SPROUT_MEMORY_SUBCORTICAL_MODEL",
			"SPROUT_AGENT_MODEL_OVERRIDES",
		]);
		expect(findModelConfigOverridesForProvider(overrides, "anthropic")).toEqual([]);
	});
});
