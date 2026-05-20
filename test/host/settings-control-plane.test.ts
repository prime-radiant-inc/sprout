import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SettingsControlPlane,
	type SettingsSnapshot,
} from "../../src/host/settings/control-plane.ts";
import {
	type ModelConfigOverrides,
	parseModelConfigOverrides,
} from "../../src/host/settings/model-overrides.ts";
import { createProviderCredentialRef } from "../../src/host/settings/provider-credentials.ts";
import {
	createProviderSecretRef,
	createSecretStore,
	type SecretStore,
} from "../../src/host/settings/secret-store.ts";
import { SettingsStore } from "../../src/host/settings/store.ts";
import {
	createEmptySettings,
	MEMORY_MODEL_PURPOSES,
	type SproutSettings,
} from "../../src/host/settings/types.ts";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

async function makePlane(
	options: {
		initialSettings?: SproutSettings;
		secretStore?: SecretStore;
		secretBackend?: ConstructorParameters<typeof SettingsControlPlane>[0]["secretBackend"];
		secretBackendState?: ConstructorParameters<
			typeof SettingsControlPlane
		>[0]["secretBackendState"];
		initialValidationErrors?: ConstructorParameters<
			typeof SettingsControlPlane
		>[0]["initialValidationErrors"];
		runtimeWarnings?: ConstructorParameters<typeof SettingsControlPlane>[0]["runtimeWarnings"];
		modelOverrides?: ModelConfigOverrides;
		initialCatalog?: ConstructorParameters<typeof SettingsControlPlane>[0]["initialCatalog"];
		onSettingsUpdated?: (snapshot: SettingsSnapshot) => void;
		checkConnection?: ConstructorParameters<typeof SettingsControlPlane>[0]["checkConnection"];
		refreshModels?: ConstructorParameters<typeof SettingsControlPlane>[0]["refreshModels"];
		loadAgentModelCatalog?: ConstructorParameters<
			typeof SettingsControlPlane
		>[0]["loadAgentModelCatalog"];
		settingsStore?: Pick<SettingsStore, "save">;
	} = {},
) {
	tempDir = await mkdtemp(join(tmpdir(), "sprout-settings-control-plane-"));
	const settingsStore =
		options.settingsStore ??
		new SettingsStore({
			settingsPath: join(tempDir, "settings.json"),
			now: () => "2026-03-11T12-34-56Z",
		});

	return new SettingsControlPlane({
		settingsStore,
		secretStore:
			options.secretStore ?? createSecretStore({ backend: "memory", platform: "darwin" }),
		secretBackend: options.secretBackend ?? "memory",
		secretBackendState: options.secretBackendState,
		initialValidationErrors: options.initialValidationErrors,
		runtimeWarnings: options.runtimeWarnings,
		modelOverrides: options.modelOverrides,
		initialCatalog: options.initialCatalog,
		initialSettings: options.initialSettings ?? createEmptySettings(),
		onSettingsUpdated: options.onSettingsUpdated,
		checkConnection: options.checkConnection,
		refreshModels: options.refreshModels,
		loadAgentModelCatalog:
			options.loadAgentModelCatalog ??
			(() => [
				{
					key: "metacognitive",
					name: "metacognitive",
					source: "tree" as const,
					path: "metacognitive",
					defaultModel: "balanced",
				},
				{
					key: "utility/reader",
					name: "reader",
					source: "tree" as const,
					path: "utility/reader",
					defaultModel: "fast",
				},
			]),
		now: () => "2026-03-11T12:34:56.000Z",
	});
}

describe("SettingsControlPlane", () => {
	test("creates providers enabled by default and clears validation errors when secrets are added", async () => {
		const snapshots: SettingsSnapshot[] = [];
		const plane = await makePlane({
			onSettingsUpdated: (snapshot) => snapshots.push(snapshot),
		});

		const created = await plane.execute({
			kind: "create_provider",
			data: {
				kind: "openai",
				label: "OpenAI",
			},
		});
		expect(created.ok).toBe(true);
		const providerId = created.ok ? created.snapshot.settings.providers[0]?.id : undefined;
		expect(providerId).toBe("openai");
		if (!providerId) throw new Error("expected provider id");
		expect(created).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					providers: [{ id: "openai", enabled: true }],
				},
				providers: [
					{
						providerId: "openai",
						hasSecret: false,
						validationErrors: ["API key is required"],
					},
				],
			},
		});

		const secretResult = await plane.execute({
			kind: "set_provider_secret",
			data: {
				providerId,
				secret: "openai-secret",
			},
		});
		expect(secretResult).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					providers: [{ id: "openai", enabled: true }],
				},
			},
		});

		const current = await plane.execute({ kind: "get_settings", data: {} });
		expect(current).toMatchObject({
			ok: true,
			snapshot: {
				providers: [
					{
						providerId: "openai",
						hasSecret: true,
						validationErrors: [],
					},
				],
			},
		});
		expect(snapshots).toHaveLength(2);
	});

	test("setting a secret re-enables providers disabled by startup validation errors", async () => {
		const plane = await makePlane({
			initialValidationErrors: {
				openai: ["API key is required"],
			},
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: false,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const result = await plane.execute({
			kind: "set_provider_secret",
			data: {
				providerId: "openai",
				secret: "openai-secret",
			},
		});

		expect(result).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					providers: [{ id: "openai", enabled: true }],
				},
				providers: [
					{
						providerId: "openai",
						validationErrors: [],
					},
				],
			},
		});
	});

	test("does not report OpenAI Codex ready from a legacy api-key credential ref", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(
			createProviderSecretRef("openai-codex", "memory"),
			"api-key-secret",
		);
		const plane = await makePlane({
			secretStore,
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai-codex",
						kind: "openai-codex",
						label: "OpenAI Codex",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const result = await plane.execute({ kind: "get_settings", data: {} });

		expect(result).toMatchObject({
			ok: true,
			snapshot: {
				providers: [
					{
						providerId: "openai-codex",
						hasSecret: false,
						validationErrors: ["ChatGPT OAuth login is required for OpenAI Codex"],
					},
				],
			},
		});
	});

	test("rejects generic secret commands for OpenAI Codex providers", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(
			createProviderCredentialRef("openai-codex", "oauth", "memory"),
			"oauth-secret",
		);
		const plane = await makePlane({
			secretStore,
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai-codex",
						kind: "openai-codex",
						label: "OpenAI Codex",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const setResult = await plane.execute({
			kind: "set_provider_secret",
			data: {
				providerId: "openai-codex",
				secret: "api-key-secret",
			},
		});
		const deleteResult = await plane.execute({
			kind: "delete_provider_secret",
			data: {
				providerId: "openai-codex",
			},
		});

		expect(setResult).toEqual({
			ok: false,
			code: "unsupported_provider_auth",
			message:
				"OpenAI Codex uses ChatGPT OAuth. Generic provider secret commands are not supported.",
			fieldErrors: {
				secret:
					"OpenAI Codex uses ChatGPT OAuth. Generic provider secret commands are not supported.",
			},
		});
		expect(deleteResult).toEqual(setResult);
		expect(
			await secretStore.getSecret(createProviderCredentialRef("openai-codex", "oauth", "memory")),
		).toBe("oauth-secret");
		expect(await secretStore.hasSecret(createProviderSecretRef("openai-codex", "memory"))).toBe(
			false,
		);
	});

	test("provider deletion cleans up every declared credential ref", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		const oauthRef = createProviderCredentialRef("openai-codex", "oauth", "memory");
		await secretStore.setSecret(oauthRef, "oauth-secret");
		const plane = await makePlane({
			secretStore,
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai-codex",
						kind: "openai-codex",
						label: "OpenAI Codex",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const result = await plane.execute({
			kind: "delete_provider",
			data: { providerId: "openai-codex" },
		});

		expect(result).toMatchObject({ ok: true });
		expect(await secretStore.hasSecret(oauthRef)).toBe(false);
	});

	test("warns when enabled providers exist without explicit memory models", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {
					fast: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
					},
				},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const result = await plane.execute({ kind: "get_settings", data: {} });

		expect(result).toMatchObject({
			ok: true,
			snapshot: {
				runtime: {
					warnings: [
						{
							code: "memory_models_incomplete",
							message:
								"Memory model settings incomplete. Configure exact models for: summary, extraction, relationship, consolidation, entityGc, subcortical",
						},
					],
				},
			},
		});
	});

	test("does not warn about internal models covered by env overrides", async () => {
		const plane = await makePlane({
			modelOverrides: parseModelConfigOverrides({
				SPROUT_MEMORY_SUMMARY_MODEL: "anthropic:claude-sonnet-4-6",
				SPROUT_MEMORY_EXTRACTION_MODEL: "anthropic:claude-sonnet-4-6",
				SPROUT_MEMORY_RELATIONSHIP_MODEL: "anthropic:claude-sonnet-4-6",
				SPROUT_MEMORY_CONSOLIDATION_MODEL: "anthropic:claude-sonnet-4-6",
				SPROUT_MEMORY_ENTITY_GC_MODEL: "anthropic:claude-sonnet-4-6",
				SPROUT_MEMORY_SUBCORTICAL_MODEL: "anthropic:claude-sonnet-4-6",
			}),
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {
					fast: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
					},
				},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const result = await plane.execute({ kind: "get_settings", data: {} });

		if (!result.ok) throw new Error(result.message);
		expect(
			result.snapshot.runtime.warnings.some(
				(warning) => warning.code === "memory_models_incomplete",
			),
		).toBe(false);
	});

	test("sets default models, clears them on delete, and removes stored secrets", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(createProviderSecretRef("openai", "memory"), "openai-secret");
		const plane = await makePlane({
			secretStore,
			refreshModels: async (provider) => {
				if (provider.id === "openai") {
					return [{ id: "gpt-4.1", label: "GPT-4.1", source: "remote" }];
				}
				if (provider.id === "lmstudio") {
					return [{ id: "qwen2.5-coder", label: "Qwen 2.5 Coder", source: "remote" }];
				}
				return [];
			},
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
					{
						id: "lmstudio",
						kind: "openai-compatible",
						label: "LM Studio",
						enabled: true,
						baseUrl: "http://127.0.0.1:1234/v1",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		await plane.execute({
			kind: "refresh_provider_models",
			data: { providerId: "openai" },
		});

		const setBestDefault = await plane.execute({
			kind: "set_default_model",
			data: {
				slot: "best",
				model: {
					providerId: "openai",
					modelId: "gpt-4.1",
				},
			},
		});
		expect(setBestDefault).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					defaults: {
						best: {
							providerId: "openai",
							modelId: "gpt-4.1",
						},
					},
				},
			},
		});

		const deleted = await plane.execute({
			kind: "delete_provider",
			data: { providerId: "openai" },
		});
		expect(deleted).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					defaults: {},
				},
			},
		});
		expect(await secretStore.hasSecret(createProviderSecretRef("openai", "memory"))).toBe(false);
	});

	test("clears global tier defaults that reference a disabled or deleted provider", async () => {
		const plane = await makePlane({
			refreshModels: async (provider) => {
				if (provider.id === "openrouter") {
					return [{ id: "anthropic/claude-opus-4.1", label: "Claude Opus 4.1", source: "remote" }];
				}
				if (provider.id === "lmstudio") {
					return [{ id: "qwen2.5-coder", label: "Qwen 2.5 Coder", source: "remote" }];
				}
				return [];
			},
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openrouter",
						kind: "openrouter",
						label: "OpenRouter",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
					{
						id: "lmstudio",
						kind: "openai-compatible",
						label: "LM Studio",
						enabled: true,
						baseUrl: "http://127.0.0.1:1234/v1",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {
					best: {
						providerId: "openrouter",
						modelId: "anthropic/claude-opus-4.1",
					},
					fast: {
						providerId: "lmstudio",
						modelId: "qwen2.5-coder",
					},
				},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const disabled = await plane.execute({
			kind: "set_provider_enabled",
			data: { providerId: "lmstudio", enabled: false },
		});
		expect(disabled).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					defaults: {
						best: {
							providerId: "openrouter",
							modelId: "anthropic/claude-opus-4.1",
						},
					},
				},
			},
		});

		const deleted = await plane.execute({
			kind: "delete_provider",
			data: { providerId: "openrouter" },
		});
		expect(deleted).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					defaults: {},
				},
			},
		});
	});

	test("clears stored memory models that reference a disabled or deleted provider", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
					{
						id: "lmstudio",
						kind: "openai-compatible",
						label: "LM Studio",
						enabled: true,
						baseUrl: "http://127.0.0.1:1234/v1",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {
					extraction: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
					},
					subcortical: {
						providerId: "lmstudio",
						modelId: "qwen2.5-coder",
					},
				},
				agentModelOverrides: {
					metacognitive: {
						kind: "model",
						model: {
							providerId: "lmstudio",
							modelId: "qwen2.5-coder",
						},
					},
				},
			},
		});

		const disabled = await plane.execute({
			kind: "set_provider_enabled",
			data: { providerId: "lmstudio", enabled: false },
		});
		expect(disabled).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					memoryModels: {
						extraction: {
							providerId: "anthropic",
							modelId: "claude-sonnet-4-6",
						},
					},
					agentModelOverrides: {},
				},
			},
		});

		const deleted = await plane.execute({
			kind: "delete_provider",
			data: { providerId: "anthropic" },
		});
		expect(deleted).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					memoryModels: {},
					agentModelOverrides: {},
				},
			},
		});
	});

	test("rejects provider delete or disable when an env model override references it", async () => {
		const modelOverrides = parseModelConfigOverrides({
			SPROUT_DEFAULT_FAST_MODEL: "lmstudio:qwen2.5-coder",
			SPROUT_MEMORY_EXTRACTION_MODEL: "lmstudio:qwen2.5-coder",
			SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
				metacognitive: "lmstudio:qwen2.5-coder",
			}),
		});
		const plane = await makePlane({
			modelOverrides,
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "lmstudio",
						kind: "openai-compatible",
						label: "LM Studio",
						enabled: true,
						baseUrl: "http://127.0.0.1:1234/v1",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const disabled = await plane.execute({
			kind: "set_provider_enabled",
			data: { providerId: "lmstudio", enabled: false },
		});
		expect(disabled).toEqual({
			ok: false,
			code: "env_override_active",
			message:
				"Cannot disable provider 'lmstudio' while env override SPROUT_AGENT_MODEL_OVERRIDES, SPROUT_DEFAULT_FAST_MODEL, SPROUT_MEMORY_EXTRACTION_MODEL references it",
			fieldErrors: {
				providerId:
					"Unset SPROUT_AGENT_MODEL_OVERRIDES, SPROUT_DEFAULT_FAST_MODEL, SPROUT_MEMORY_EXTRACTION_MODEL before disabling this provider",
			},
		});

		const deleted = await plane.execute({
			kind: "delete_provider",
			data: { providerId: "lmstudio" },
		});
		expect(deleted).toEqual({
			ok: false,
			code: "env_override_active",
			message:
				"Cannot delete provider 'lmstudio' while env override SPROUT_AGENT_MODEL_OVERRIDES, SPROUT_DEFAULT_FAST_MODEL, SPROUT_MEMORY_EXTRACTION_MODEL references it",
			fieldErrors: {
				providerId:
					"Unset SPROUT_AGENT_MODEL_OVERRIDES, SPROUT_DEFAULT_FAST_MODEL, SPROUT_MEMORY_EXTRACTION_MODEL before deleting this provider",
			},
		});
	});

	test("exposes env model overrides in runtime snapshots with catalog diagnostics", async () => {
		const plane = await makePlane({
			modelOverrides: parseModelConfigOverrides({
				SPROUT_DEFAULT_BEST_MODEL: "openrouter:openai/gpt-4o-mini",
				SPROUT_MEMORY_RELATIONSHIP_MODEL: "openrouter:missing-model",
				SPROUT_AGENT_MODEL_OVERRIDES: JSON.stringify({
					metacognitive: "openrouter:openai/gpt-4o-mini",
				}),
			}),
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openrouter",
						kind: "openrouter",
						label: "OpenRouter",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			initialCatalog: [
				{
					providerId: "openrouter",
					models: [
						{
							id: "openai/gpt-4o-mini",
							label: "GPT-4o mini",
							source: "remote",
						},
					],
				},
			],
		});

		const snapshot = await plane.execute({ kind: "get_settings", data: {} });

		expect(snapshot).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					defaults: {},
					memoryModels: {},
					agentModelOverrides: {},
				},
				runtime: {
					modelOverrides: {
						defaults: {
							best: {
								envVar: "SPROUT_DEFAULT_BEST_MODEL",
								catalogStatus: "matched",
								displayLabel: "GPT-4o mini",
							},
						},
						memoryModels: {
							relationship: {
								envVar: "SPROUT_MEMORY_RELATIONSHIP_MODEL",
								catalogStatus: "missing",
								diagnostic:
									"Model 'missing-model' is not in the loaded catalog for provider 'openrouter'",
							},
						},
						agentModelOverrides: {
							metacognitive: {
								envVar: "SPROUT_AGENT_MODEL_OVERRIDES",
								selection: {
									kind: "model",
									model: {
										providerId: "openrouter",
										modelId: "openai/gpt-4o-mini",
									},
								},
								displayLabel: "GPT-4o mini",
							},
						},
					},
				},
			},
		});
	});

	test("sets and unsets stored memory models through the control plane", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			initialCatalog: [
				{
					providerId: "anthropic",
					models: [
						{
							id: "claude-sonnet-4-6",
							label: "Claude Sonnet 4.6",
							source: "remote",
						},
					],
				},
			],
		});

		for (const purpose of MEMORY_MODEL_PURPOSES) {
			const set = await plane.execute({
				kind: "set_memory_model",
				data: {
					purpose,
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
					},
				},
			});
			expect(set).toMatchObject({
				ok: true,
				snapshot: {
					settings: {
						memoryModels: {
							[purpose]: {
								providerId: "anthropic",
								modelId: "claude-sonnet-4-6",
							},
						},
					},
				},
			});
		}

		const unset = await plane.execute({
			kind: "set_memory_model",
			data: { purpose: "extraction" },
		});

		expect(unset).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					memoryModels: {
						summary: {
							providerId: "anthropic",
							modelId: "claude-sonnet-4-6",
						},
					},
				},
			},
		});
		if (!unset.ok) throw new Error("expected unset to succeed");
		expect(unset.snapshot.settings.memoryModels.extraction).toBeUndefined();
	});

	test("returns memory model field errors for invalid stored memory model selections", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			initialCatalog: [
				{
					providerId: "anthropic",
					models: [
						{
							id: "claude-sonnet-4-6",
							label: "Claude Sonnet 4.6",
							source: "remote",
						},
					],
				},
			],
		});

		const result = await plane.execute({
			kind: "set_memory_model",
			data: {
				purpose: "extraction",
				model: {
					providerId: "anthropic",
					modelId: "missing-model",
				},
			},
		});

		expect(result).toEqual({
			ok: false,
			code: "validation_failed",
			message: "Unknown model 'missing-model' for provider 'anthropic'",
			fieldErrors: {
				"memoryModels.extraction": "Unknown model 'missing-model' for provider 'anthropic'",
			},
		});
	});

	test("sets and unsets stored agent models through the control plane", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {
					fast: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
					},
				},
				memoryModels: {},
				agentModelOverrides: {},
			},
			initialCatalog: [
				{
					providerId: "anthropic",
					models: [
						{
							id: "claude-sonnet-4-6",
							label: "Claude Sonnet 4.6",
							source: "remote",
						},
					],
				},
			],
		});

		const set = await plane.execute({
			kind: "set_agent_model_override",
			data: {
				agentKey: "metacognitive",
				override: {
					kind: "model",
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
					},
				},
			},
		});
		expect(set).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					agentModelOverrides: {
						metacognitive: {
							kind: "model",
							model: {
								providerId: "anthropic",
								modelId: "claude-sonnet-4-6",
							},
						},
					},
				},
			},
		});

		const setTier = await plane.execute({
			kind: "set_agent_model_override",
			data: {
				agentKey: "utility/reader",
				override: { kind: "tier", tier: "fast" },
			},
		});
		expect(setTier).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					agentModelOverrides: {
						"utility/reader": {
							kind: "tier",
							tier: "fast",
						},
					},
				},
			},
		});

		const unset = await plane.execute({
			kind: "set_agent_model_override",
			data: { agentKey: "metacognitive" },
		});

		if (!unset.ok) throw new Error("expected unset to succeed");
		expect(unset.snapshot.settings.agentModelOverrides.metacognitive).toBeUndefined();
	});

	test("sets tier agent models through env-backed default models", async () => {
		const plane = await makePlane({
			modelOverrides: parseModelConfigOverrides({
				SPROUT_DEFAULT_FAST_MODEL: "anthropic:claude-haiku-4-5",
			}),
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			initialCatalog: [
				{
					providerId: "anthropic",
					models: [
						{
							id: "claude-haiku-4-5",
							label: "Claude Haiku 4.5",
							source: "remote",
						},
					],
				},
			],
		});

		const result = await plane.execute({
			kind: "set_agent_model_override",
			data: {
				agentKey: "utility/reader",
				override: { kind: "tier", tier: "fast" },
			},
		});

		expect(result).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					agentModelOverrides: {
						"utility/reader": {
							kind: "tier",
							tier: "fast",
						},
					},
				},
			},
		});
	});

	test("unsets stale unknown stored agent model overrides", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {
					reader: {
						kind: "tier",
						tier: "fast",
					},
				},
			},
		});

		const result = await plane.execute({
			kind: "set_agent_model_override",
			data: { agentKey: "reader" },
		});

		if (!result.ok) throw new Error("expected stale override deletion to succeed");
		expect(result.snapshot.settings.agentModelOverrides.reader).toBeUndefined();
	});

	test("rejects unknown and unresolved tier agent model overrides", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			initialCatalog: [
				{
					providerId: "anthropic",
					models: [
						{
							id: "claude-sonnet-4-6",
							label: "Claude Sonnet 4.6",
							source: "remote",
						},
					],
				},
			],
		});

		await expect(
			plane.execute({
				kind: "set_agent_model_override",
				data: {
					agentKey: "reader",
					override: { kind: "tier", tier: "fast" },
				},
			}),
		).resolves.toEqual({
			ok: false,
			code: "validation_failed",
			message: "Unknown agent key 'reader'",
			fieldErrors: {
				agentKey: "Unknown agent key 'reader'",
			},
		});

		await expect(
			plane.execute({
				kind: "set_agent_model_override",
				data: {
					agentKey: "utility/reader",
					override: { kind: "tier", tier: "fast" },
				},
			}),
		).resolves.toEqual({
			ok: false,
			code: "validation_failed",
			message: "No global 'fast' model is configured",
			fieldErrors: {
				"agentModelOverrides.utility/reader": "No global 'fast' model is configured",
			},
		});
	});

	test("returns agent model field errors for invalid stored agent model selections", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "anthropic",
						kind: "anthropic",
						label: "Anthropic",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			initialCatalog: [
				{
					providerId: "anthropic",
					models: [
						{
							id: "claude-sonnet-4-6",
							label: "Claude Sonnet 4.6",
							source: "remote",
						},
					],
				},
			],
		});

		const result = await plane.execute({
			kind: "set_agent_model_override",
			data: {
				agentKey: "metacognitive",
				override: {
					kind: "model",
					model: {
						providerId: "anthropic",
						modelId: "missing-model",
					},
				},
			},
		});

		expect(result).toEqual({
			ok: false,
			code: "validation_failed",
			message: "Unknown model 'missing-model' for provider 'anthropic'",
			fieldErrors: {
				"agentModelOverrides.metacognitive":
					"Unknown model 'missing-model' for provider 'anthropic'",
			},
		});
	});
	test("surfaces provider health failures in snapshots without failing the command", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "lmstudio",
						kind: "openai-compatible",
						label: "LM Studio",
						enabled: true,
						baseUrl: "http://127.0.0.1:1234/v1",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			checkConnection: async () => {
				throw new Error("connection refused");
			},
			refreshModels: async () => [
				{ id: "qwen2.5-coder", label: "Qwen 2.5 Coder", source: "remote" },
			],
		});

		const connection = await plane.execute({
			kind: "test_provider_connection",
			data: { providerId: "lmstudio" },
		});
		expect(connection).toMatchObject({
			ok: true,
			snapshot: {
				providers: [
					{
						providerId: "lmstudio",
						connectionStatus: "error",
						connectionError: "connection refused",
					},
				],
			},
		});

		const refreshed = await plane.execute({
			kind: "refresh_provider_models",
			data: { providerId: "lmstudio" },
		});
		expect(refreshed).toMatchObject({
			ok: true,
			snapshot: {
				providers: [
					{
						providerId: "lmstudio",
						catalogStatus: "current",
					},
				],
				catalog: [
					{
						providerId: "lmstudio",
						models: [{ id: "qwen2.5-coder", source: "remote" }],
					},
				],
			},
		});
	});

	test("returns ok false when a mutation cannot be persisted", async () => {
		const plane = await makePlane({
			settingsStore: {
				async save() {
					throw new Error("disk full");
				},
			},
		});

		const result = await plane.execute({
			kind: "create_provider",
			data: {
				kind: "openai-compatible",
				label: "LM Studio",
				baseUrl: "http://127.0.0.1:1234/v1",
			},
		});

		expect(result).toEqual({
			ok: false,
			code: "persist_failed",
			message: "disk full",
		});
	});

	test("does not delete stored secrets when provider deletion cannot be persisted", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(createProviderSecretRef("openai", "memory"), "openai-secret");
		const plane = await makePlane({
			secretStore,
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
			settingsStore: {
				async save() {
					throw new Error("disk full");
				},
			},
		});

		const result = await plane.execute({
			kind: "delete_provider",
			data: { providerId: "openai" },
		});

		expect(result).toEqual({
			ok: false,
			code: "persist_failed",
			message: "disk full",
		});
		expect(await secretStore.hasSecret(createProviderSecretRef("openai", "memory"))).toBe(true);
	});

	test("surfaces provider secret cleanup failures as runtime warnings", async () => {
		const plane = await makePlane({
			secretStore: {
				async getSecret() {
					return "openai-secret";
				},
				async setSecret() {},
				async deleteSecret() {
					throw new Error("keychain unavailable");
				},
				async hasSecret() {
					return true;
				},
			},
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const result = await plane.execute({
			kind: "delete_provider",
			data: { providerId: "openai" },
		});

		expect(result).toMatchObject({
			ok: true,
			snapshot: {
				runtime: {
					warnings: [
						{
							code: "secret_cleanup_failed",
							message:
								"Deleted provider 'openai' from settings, but failed to remove its stored secret: keychain unavailable",
						},
					],
				},
			},
		});
	});

	test("rejects invalid provider config with field-level validation errors", async () => {
		const plane = await makePlane();

		const malformedBaseUrl = await plane.execute({
			kind: "create_provider",
			data: {
				kind: "openai-compatible",
				label: "LM Studio",
				baseUrl: "localhost:1234/v1",
			},
		});

		expect(malformedBaseUrl).toEqual({
			ok: false,
			code: "validation_failed",
			message: "Base URL must be a valid http or https URL",
			fieldErrors: {
				baseUrl: "Base URL must be a valid http or https URL",
			},
		});

		const geminiHeaders = await plane.execute({
			kind: "create_provider",
			data: {
				kind: "gemini",
				label: "Gemini",
				nonSecretHeaders: {
					"X-Test": "value",
				},
			},
		});

		expect(geminiHeaders).toEqual({
			ok: false,
			code: "validation_failed",
			message: "Gemini providers do not support custom non-secret headers",
			fieldErrors: {
				nonSecretHeaders: "Gemini providers do not support custom non-secret headers",
			},
		});
	});

	test("surfaces unavailable secret backends in snapshots and secret mutations", async () => {
		const message = "Unsupported secret backend for platform: win32";
		const unavailableSecretStore: SecretStore = {
			async getSecret() {
				return undefined;
			},
			async setSecret() {
				throw new Error(message);
			},
			async deleteSecret() {
				throw new Error(message);
			},
			async hasSecret() {
				return false;
			},
		};
		const plane = await makePlane({
			secretStore: unavailableSecretStore,
			secretBackendState: {
				available: false,
				message,
			},
			initialSettings: {
				version: 4,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: true,
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {},
				memoryModels: {},
				agentModelOverrides: {},
			},
		});

		const snapshot = await plane.execute({ kind: "get_settings", data: {} });
		expect(snapshot).toMatchObject({
			ok: true,
			snapshot: {
				runtime: {
					secretBackend: {
						available: false,
						message,
					},
				},
				providers: [
					{
						providerId: "openai",
						hasSecret: false,
						validationErrors: ["Secret storage backend is unavailable"],
					},
				],
			},
		});

		const enable = await plane.execute({
			kind: "set_provider_enabled",
			data: {
				providerId: "openai",
				enabled: true,
			},
		});
		expect(enable).toEqual({
			ok: false,
			code: "validation_failed",
			message: "Secret storage backend is unavailable",
			fieldErrors: {
				secret: "Secret storage backend is unavailable",
			},
		});

		const saveSecret = await plane.execute({
			kind: "set_provider_secret",
			data: {
				providerId: "openai",
				secret: "openai-secret",
			},
		});
		expect(saveSecret).toEqual({
			ok: false,
			code: "secret_backend_unavailable",
			message,
			fieldErrors: {
				secret: message,
			},
		});

		const deleteSecret = await plane.execute({
			kind: "delete_provider_secret",
			data: {
				providerId: "openai",
			},
		});
		expect(deleteSecret).toEqual({
			ok: false,
			code: "secret_backend_unavailable",
			message,
			fieldErrors: {
				secret: message,
			},
		});
	});

	test("preserves runtime warnings across snapshots and successful mutations", async () => {
		const warning = {
			code: "invalid_settings_recovered" as const,
			message: "Recovered invalid settings file to /tmp/settings.invalid.2026-03-12.json",
		};
		const plane = await makePlane({
			runtimeWarnings: [warning],
		});

		const snapshot = await plane.execute({ kind: "get_settings", data: {} });
		expect(snapshot).toMatchObject({
			ok: true,
			snapshot: {
				runtime: {
					warnings: [warning],
				},
			},
		});

		const created = await plane.execute({
			kind: "create_provider",
			data: {
				kind: "openai-compatible",
				label: "LM Studio",
				baseUrl: "http://127.0.0.1:1234/v1",
			},
		});
		if (!created.ok) throw new Error(created.message);
		expect(created.snapshot.runtime.warnings).toEqual(
			expect.arrayContaining([
				warning,
				expect.objectContaining({ code: "memory_models_incomplete" }),
			]),
		);
	});
});
