import { describe, expect, test } from "bun:test";
import { bootstrapSessionRuntime } from "../../src/host/cli-bootstrap.ts";
import { importSettingsFromEnv } from "../../src/host/settings/env-import.ts";
import {
	applyModelConfigOverrides,
	parseModelConfigOverrides,
} from "../../src/host/settings/model-overrides.ts";
import type { ProviderSecretRef } from "../../src/host/settings/secret-store.ts";
import { createEmptySettings } from "../../src/host/settings/types.ts";
import type { ProviderRegistryEntry } from "../../src/llm/provider-registry.ts";
import type { ProviderAdapter, ProviderModel } from "../../src/llm/types.ts";

function fakeAdapter(
	providerId: string,
	kind: ProviderAdapter["kind"],
	models: ProviderModel[],
	options: { failListModels?: boolean } = {},
): ProviderAdapter {
	return {
		name: providerId,
		providerId,
		kind,
		async complete() {
			throw new Error("not implemented");
		},
		stream() {
			throw new Error("not implemented");
		},
		async listModels() {
			if (options.failListModels) {
				throw new Error("catalog refresh failed");
			}
			return models;
		},
		async checkConnection() {
			return { ok: true as const };
		},
	};
}

function emptyRegistry() {
	return {
		getEntries: async () => [] as ProviderRegistryEntry[],
		getEntry: async () => undefined,
	};
}

function memorySecretStore() {
	const secrets = new Map<string, string>();
	return {
		secretRefBackend: "memory" as const,
		secretBackendState: {
			backend: "memory" as const,
			available: true,
		},
		secretStore: {
			getSecret: async (ref: ProviderSecretRef) => secrets.get(ref.storageKey),
			setSecret: async (ref: ProviderSecretRef, value: string) => {
				secrets.set(ref.storageKey, value);
			},
			deleteSecret: async (ref: ProviderSecretRef) => {
				secrets.delete(ref.storageKey);
			},
			hasSecret: async (ref: ProviderSecretRef) => secrets.has(ref.storageKey),
		},
	};
}

function keychainSecretStore() {
	const secrets = new Map<string, string>();
	return {
		secretRefBackend: "macos-keychain" as const,
		secretBackendState: {
			backend: "macos-keychain" as const,
			available: true,
		},
		secretStore: {
			getSecret: async (ref: ProviderSecretRef) => secrets.get(ref.storageKey),
			setSecret: async (ref: ProviderSecretRef, value: string) => {
				secrets.set(ref.storageKey, value);
			},
			deleteSecret: async (ref: ProviderSecretRef) => {
				secrets.delete(ref.storageKey);
			},
			hasSecret: async (ref: ProviderSecretRef) => secrets.has(ref.storageKey),
		},
	};
}

function unavailableSecretStore(message = "Unsupported secret backend for platform: win32") {
	return {
		secretRefBackend: "memory" as const,
		secretBackendState: {
			available: false,
			message,
		},
		secretStore: {
			getSecret: async () => undefined,
			setSecret: async () => {
				throw new Error(message);
			},
			deleteSecret: async () => {
				throw new Error(message);
			},
			hasSecret: async () => false,
		},
	};
}

function emptySettingsStore(source: "loaded" | "recovered" = "loaded") {
	return {
		load: async () => ({
			settings: createEmptySettings(),
			skipEnvImport: false,
			source,
		}),
		save: async () => {},
	};
}

describe("bootstrapSessionRuntime", () => {
	test("builds runtime wiring and emits stderr-enabled info log", async () => {
		const created: Record<string, unknown> = {};
		const logger = {
			info: (category: string, message: string, data?: Record<string, unknown>) => {
				created.info = { category, message, data };
			},
		};

		const result = await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				initialHistory: [{ role: "user", content: [{ kind: "text", text: "prior" }] }],
				completedHandles: [
					{
						handleId: "h1",
						ownerId: "root",
						agentName: "worker",
						result: {
							kind: "result",
							handle_id: "h1",
							output: "ok",
							success: true,
							stumbles: 0,
							turns: 1,
							timed_out: false,
						},
					},
				],
				infra: {
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
				},
				logStderr: true,
				debug: false,
			},
			{
				createBus: () => ({ id: "bus" }),
				createSettingsStore: () => emptySettingsStore(),
				createSecretStore: () => keychainSecretStore(),
				createProviderRegistry: () => emptyRegistry(),
				createLogger: (opts) => {
					created.loggerOpts = opts;
					return logger;
				},
				createClient: async ({ logger: incomingLogger }) => {
					created.clientLogger = incomingLogger;
					return { id: "client" };
				},
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return { id: "control-plane" };
				},
				createController: (opts) => {
					created.controllerOpts = opts;
					return { sessionId: "01BOOT" };
				},
				loadAvailableModels: async (catalog) => {
					created.availableModelsCatalog = catalog;
					return ["fast", "balanced"];
				},
			},
		);

		expect((created.loggerOpts as any).stderrLevel).toBe("info");
		expect((created.info as any).data.level).toBe("info");
		expect((created.controllerOpts as any).completedHandles).toHaveLength(1);
		expect(result.availableModels).toEqual(["fast", "balanced"]);
	});

	test("omits stderr level when logStderr is false", async () => {
		const created: Record<string, unknown> = {};
		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: {
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
				},
				logStderr: false,
				debug: true,
			},
			{
				createBus: () => ({ id: "bus" }),
				createSettingsStore: () => emptySettingsStore(),
				createSecretStore: () => keychainSecretStore(),
				createProviderRegistry: () => emptyRegistry(),
				createLogger: (opts) => {
					created.loggerOpts = opts;
					return { info: () => {} };
				},
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: () => ({ id: "control-plane" }),
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
			},
		);

		expect((created.loggerOpts as any).stderrLevel).toBeUndefined();
	});

	test("imports env-backed settings only when the settings file is absent", async () => {
		const created: Record<string, unknown> = {};
		const importedSettings = {
			...createEmptySettings(),
			providers: [
				{
					id: "anthropic",
					kind: "anthropic" as const,
					label: "Anthropic",
					enabled: true,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
			],
			defaults: {},
		};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: {
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
				},
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: () => ({ id: "control-plane" }),
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
				createProviderRegistry: () => emptyRegistry(),
				createSettingsStore: () => ({
					load: async () => ({
						settings: createEmptySettings(),
						skipEnvImport: false,
						source: "missing" as const,
					}),
					save: async (settings) => {
						created.savedSettings = settings;
					},
				}),
				createSecretStore: () => keychainSecretStore(),
				importSettingsFromEnv: async () => {
					created.importCalled = true;
					return {
						settings: importedSettings,
						validationErrorsByProvider: {},
					};
				},
			},
		);

		expect(created.importCalled).toBe(true);
		expect(created.savedSettings).toEqual(importedSettings);
	});

	test("does not persist env-backed settings when using the memory secret backend", async () => {
		const created: Record<string, unknown> = {};
		const importedSettings = {
			...createEmptySettings(),
			providers: [
				{
					id: "openrouter",
					kind: "openrouter" as const,
					label: "OpenRouter",
					enabled: true,
					createdAt: "2026-03-14T12:34:56.000Z",
					updatedAt: "2026-03-14T12:34:56.000Z",
				},
			],
			defaults: {
				best: { providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
			},
		};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: () => ({ id: "control-plane" }),
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
				createProviderRegistry: () => emptyRegistry(),
				createSettingsStore: () => ({
					load: async () => ({
						settings: createEmptySettings(),
						skipEnvImport: false,
						source: "missing" as const,
					}),
					save: async () => {
						created.saved = true;
					},
				}),
				createSecretStore: () => memorySecretStore(),
				importSettingsFromEnv: async () => {
					created.importCalled = true;
					return {
						settings: importedSettings,
						validationErrorsByProvider: {},
					};
				},
			},
		);

		expect(created.importCalled).toBe(true);
		expect(created.saved).toBeUndefined();
	});

	test("keeps default model env vars as runtime-only overrides during first-run import", async () => {
		const created: Record<string, unknown> = {};
		const env = {
			OPENROUTER_API_KEY: "openrouter-secret",
			SPROUT_DEFAULT_BEST_MODEL: "openrouter:openai/gpt-4o-mini",
		};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return {
						id: "control-plane",
						getSelectionContext: () => ({
							settings: applyModelConfigOverrides(options.initialSettings, options.modelOverrides!),
							catalog: [],
						}),
					};
				},
				createController: (opts) => {
					created.resolverSettings = opts.getResolverSettings?.();
					return { sessionId: "01BOOT" };
				},
				loadAvailableModels: async () => [],
				createProviderRegistry: () => emptyRegistry(),
				createSettingsStore: () => ({
					load: async () => ({
						settings: createEmptySettings(),
						skipEnvImport: false,
						source: "missing" as const,
					}),
					save: async (settings) => {
						created.savedSettings = settings;
					},
				}),
				createSecretStore: () => keychainSecretStore(),
				importSettingsFromEnv: async ({ secretStore, secretBackend }) =>
					importSettingsFromEnv({
						env,
						secretStore,
						secretBackend,
						now: () => "2026-03-14T12:00:00.000Z",
					}),
				parseModelConfigOverrides: () => parseModelConfigOverrides(env),
			},
		);

		expect((created.savedSettings as any).providers).toEqual([
			{
				id: "openrouter",
				kind: "openrouter",
				label: "OpenRouter",
				enabled: true,
				createdAt: "2026-03-14T12:00:00.000Z",
				updatedAt: "2026-03-14T12:00:00.000Z",
			},
		]);
		expect((created.savedSettings as any).defaults).toEqual({});
		expect((created.controlPlaneOptions as any).initialSettings.defaults).toEqual({});
		expect((created.resolverSettings as any).defaults.best).toEqual({
			providerId: "openrouter",
			modelId: "openai/gpt-4o-mini",
		});
	});

	test("ignores default-only env imports when no providers were imported", async () => {
		const created: Record<string, unknown> = {};
		const importedSettings = {
			...createEmptySettings(),
			defaults: {
				best: { providerId: "openrouter", modelId: "openai/gpt-5-mini" },
			},
		};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return {
						id: "control-plane",
						getSelectionContext: () => ({
							settings: {
								providers: [],
								defaults: options.initialSettings.defaults,
								memoryModels: options.initialSettings.memoryModels,
							},
							catalog: [],
						}),
					};
				},
				createController: (opts) => {
					created.resolverSettings = opts.getResolverSettings?.();
					return { sessionId: "01BOOT" };
				},
				loadAvailableModels: async () => [],
				createProviderRegistry: () => emptyRegistry(),
				createSettingsStore: () => ({
					load: async () => ({
						settings: createEmptySettings(),
						skipEnvImport: false,
						source: "missing" as const,
					}),
					save: async () => {},
				}),
				createSecretStore: () => memorySecretStore(),
				importSettingsFromEnv: async () => ({
					settings: importedSettings,
					validationErrorsByProvider: {},
				}),
			},
		);

		expect((created.controlPlaneOptions as any).initialSettings.defaults).toEqual({});
		expect((created.resolverSettings as any).defaults).toEqual({});
	});

	test("applies env model overrides to runtime resolver settings without persisting them", async () => {
		const created: Record<string, unknown> = {};
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "openrouter",
					kind: "openrouter" as const,
					label: "OpenRouter",
					enabled: true,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			],
			defaults: {
				best: { providerId: "openrouter", modelId: "stored-model" },
			},
			memoryModels: {},
		};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: {
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
					genomeService: {
						updateRuntimeClient: (client, resolverSettings) => {
							created.genomeClient = client;
							created.genomeResolverSettings = resolverSettings;
						},
					},
				},
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return {
						id: "control-plane",
						getSelectionContext: () => ({
							settings: applyModelConfigOverrides(options.initialSettings, options.modelOverrides!),
							catalog: [],
						}),
					};
				},
				createController: (opts) => {
					created.resolverSettings = opts.getResolverSettings?.();
					return { sessionId: "01BOOT" };
				},
				loadAvailableModels: async () => [],
				createProviderRegistry: () => emptyRegistry(),
				createSettingsStore: () => ({
					load: async () => ({
						settings,
						skipEnvImport: false,
						source: "loaded" as const,
					}),
					save: async () => {
						created.saved = true;
					},
				}),
				createSecretStore: () => memorySecretStore(),
				parseModelConfigOverrides: () => ({
					defaults: {
						best: {
							source: "env",
							envVar: "SPROUT_DEFAULT_BEST_MODEL",
							model: { providerId: "openrouter", modelId: "env-model" },
							catalogStatus: "not_loaded",
						},
					},
					memoryModels: {
						extraction: {
							source: "env",
							envVar: "SPROUT_MEMORY_EXTRACTION_MODEL",
							model: { providerId: "openrouter", modelId: "env-extraction" },
							catalogStatus: "not_loaded",
						},
					},
					agentModelOverrides: {},
				}),
			},
		);

		expect(created.saved).toBeUndefined();
		expect((created.controlPlaneOptions as any).initialSettings.defaults.best).toEqual({
			providerId: "openrouter",
			modelId: "stored-model",
		});
		expect((created.controlPlaneOptions as any).initialSettings.memoryModels).toEqual({});
		expect((created.resolverSettings as any).defaults.best).toEqual({
			providerId: "openrouter",
			modelId: "env-model",
		});
		expect(created.genomeClient).toEqual({ id: "client" });
		expect((created.genomeResolverSettings as any).memoryModels.extraction).toEqual({
			providerId: "openrouter",
			modelId: "env-extraction",
		});
	});

	test("fails bootstrap when env model overrides reference unknown or disabled providers", async () => {
		const disabledSettings = {
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
		const baseOptions = {
			genomePath: "/tmp/genome",
			projectDataDir: "/tmp/project",
			rootDir: "/tmp/root",
			sessionId: "01BOOT",
			infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
		};
		const baseDeps = {
			createBus: () => ({ id: "bus" }),
			createLogger: () => ({ info: () => {} }),
			createClient: async () => ({ id: "client" }),
			createSettingsControlPlane: () => ({ id: "control-plane" }),
			createController: () => ({ sessionId: "01BOOT" }),
			loadAvailableModels: async () => [],
			createProviderRegistry: () => emptyRegistry(),
			createSecretStore: () => memorySecretStore(),
		};

		await expect(
			bootstrapSessionRuntime(baseOptions, {
				...baseDeps,
				createSettingsStore: () => ({
					load: async () => ({
						settings: createEmptySettings(),
						skipEnvImport: false,
						source: "loaded" as const,
					}),
					save: async () => {},
				}),
				parseModelConfigOverrides: () => ({
					defaults: {},
					memoryModels: {
						extraction: {
							source: "env",
							envVar: "SPROUT_MEMORY_EXTRACTION_MODEL",
							model: { providerId: "missing", modelId: "claude-sonnet-4-6" },
							catalogStatus: "not_loaded",
						},
					},
					agentModelOverrides: {},
				}),
			}),
		).rejects.toThrow("SPROUT_MEMORY_EXTRACTION_MODEL references unknown provider 'missing'");

		await expect(
			bootstrapSessionRuntime(baseOptions, {
				...baseDeps,
				createSettingsStore: () => ({
					load: async () => ({
						settings: disabledSettings,
						skipEnvImport: false,
						source: "loaded" as const,
					}),
					save: async () => {},
				}),
				parseModelConfigOverrides: () => ({
					defaults: {
						fast: {
							source: "env",
							envVar: "SPROUT_DEFAULT_FAST_MODEL",
							model: { providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
							catalogStatus: "not_loaded",
						},
					},
					memoryModels: {},
					agentModelOverrides: {},
				}),
			}),
		).rejects.toThrow("SPROUT_DEFAULT_FAST_MODEL references disabled provider 'openrouter'");
	});

	test("does not import env-backed settings after invalid-file recovery", async () => {
		const created: Record<string, unknown> = {};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: () => ({ id: "control-plane" }),
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
				createProviderRegistry: () => emptyRegistry(),
				createSettingsStore: () => ({
					load: async () => ({
						settings: createEmptySettings(),
						skipEnvImport: true,
						source: "recovered" as const,
					}),
					save: async () => {
						created.saved = true;
					},
				}),
				createSecretStore: () => memorySecretStore(),
				importSettingsFromEnv: async () => {
					created.importCalled = true;
					return {
						settings: createEmptySettings(),
						validationErrorsByProvider: {},
					};
				},
			},
		);

		expect(created.importCalled).toBeUndefined();
		expect(created.saved).toBeUndefined();
	});

	test("passes invalid-settings recovery warnings into the settings control plane", async () => {
		const created: Record<string, unknown> = {};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return { id: "control-plane" };
				},
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
				createProviderRegistry: () => emptyRegistry(),
				createSettingsStore: () => ({
					load: async () => ({
						settings: createEmptySettings(),
						recoveredInvalidFilePath: "/tmp/settings.invalid.2026-03-12.json",
						skipEnvImport: true,
						source: "recovered" as const,
					}),
					save: async () => {},
				}),
				createSecretStore: () => memorySecretStore(),
			},
		);

		expect((created.controlPlaneOptions as any).runtimeWarnings).toEqual([
			{
				code: "invalid_settings_recovered",
				message: "Recovered invalid settings file to /tmp/settings.invalid.2026-03-12.json",
			},
		]);
	});

	test("continues bootstrapping when the secret backend is unavailable", async () => {
		const created: Record<string, unknown> = {};

		const result = await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createSettingsStore: () => emptySettingsStore(),
				createSecretStore: () => unavailableSecretStore(),
				createProviderRegistry: () => emptyRegistry(),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return { id: "control-plane" };
				},
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
			},
		);

		expect(result.availableModels).toEqual([]);
		expect((created.controlPlaneOptions as any).secretBackendState).toEqual({
			available: false,
			message: "Unsupported secret backend for platform: win32",
		});
	});

	test("threads backend-unavailable startup validation into the control plane without a fake missing-secret error", async () => {
		const created: Record<string, unknown> = {};
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "openai",
					kind: "openai" as const,
					label: "OpenAI",
					enabled: true,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
			],
		};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createSettingsStore: () => ({
					load: async () => ({
						settings,
						skipEnvImport: false,
						source: "loaded" as const,
					}),
					save: async () => {},
				}),
				createSecretStore: () => unavailableSecretStore(),
				createLogger: () => ({ info: () => {} }),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return { id: "control-plane" };
				},
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
			},
		);

		expect((created.controlPlaneOptions as any).initialValidationErrors).toEqual({
			openai: ["Secret storage backend is unavailable"],
		});
	});

	test("builds the runtime client from the settings-backed registry and derives available models from the catalog", async () => {
		const created: Record<string, unknown> = {};
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "anthropic",
					kind: "anthropic" as const,
					label: "Anthropic",
					enabled: true,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
				{
					id: "openrouter",
					kind: "openrouter" as const,
					label: "OpenRouter",
					enabled: true,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
			],
			defaults: {},
		};
		const entries: ProviderRegistryEntry[] = [
			{
				provider: settings.providers[0]!,
				validationErrors: [],
				adapter: fakeAdapter("anthropic", "anthropic", [
					{ id: "claude-opus-4-6", label: "claude-opus-4-6", source: "remote" },
				]),
			},
			{
				provider: settings.providers[1]!,
				validationErrors: [],
				adapter: fakeAdapter("openrouter", "openrouter", [], {
					failListModels: true,
				}),
			},
		];

		const result = await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createSettingsStore: () => ({
					load: async () => ({
						settings,
						skipEnvImport: false,
						source: "loaded" as const,
					}),
					save: async () => {},
				}),
				createSecretStore: () => ({
					secretRefBackend: "memory",
					secretBackendState: {
						backend: "memory",
						available: true,
					},
					secretStore: {
						getSecret: async () => undefined,
						setSecret: async () => {},
						deleteSecret: async () => {},
						hasSecret: async () => false,
					},
				}),
				createProviderRegistry: () => ({
					getEntries: async () => entries,
					getEntry: async (providerId: string) =>
						entries.find((entry) => entry.provider.id === providerId),
				}),
				createClient: async (options) => {
					created.clientOptions = options;
					return { id: "client" };
				},
				createSettingsControlPlane: (options) => {
					created.controlPlaneOptions = options;
					return { id: "control-plane" };
				},
				createController: () => ({ sessionId: "01BOOT" }),
			},
		);

		expect((created.clientOptions as any).providers).toEqual({
			anthropic: entries[0]!.adapter,
			openrouter: entries[1]!.adapter,
		});
		expect((created.controlPlaneOptions as any).initialSettings).toEqual(settings);
		expect(result.availableModels).toContain("anthropic:claude-opus-4-6");
		expect(result.availableModels).not.toContain("openrouter");
	});

	test("passes default-provider resolver settings with global tier defaults into the controller", async () => {
		const created: Record<string, unknown> = {};
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "openai",
					kind: "openai" as const,
					label: "OpenAI",
					enabled: true,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
				{
					id: "anthropic",
					kind: "anthropic" as const,
					label: "Anthropic",
					enabled: false,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
			],
			defaults: {
				balanced: {
					providerId: "openai",
					modelId: "gpt-4.1",
				},
				best: {
					providerId: "anthropic",
					modelId: "claude-opus-4-6",
				},
			},
		};

		await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createSettingsStore: () => ({
					load: async () => ({
						settings,
						skipEnvImport: false,
						source: "loaded" as const,
					}),
					save: async () => {},
				}),
				createSecretStore: () => memorySecretStore(),
				createProviderRegistry: () => emptyRegistry(),
				createClient: async () => ({ id: "client" }),
				createSettingsControlPlane: () => ({
					getSelectionContext: () => ({
						settings: {
							providers: settings.providers,
							defaults: settings.defaults,
							memoryModels: {
								extraction: {
									providerId: "openai",
									modelId: "gpt-4.1-mini",
								},
							},
						},
						catalog: [],
					}),
				}),
				createController: (opts) => {
					created.resolverSettings = opts.getResolverSettings?.();
					return { sessionId: "01BOOT" };
				},
				loadAvailableModels: async () => [],
			},
		);

		expect(created.resolverSettings).toEqual({
			providers: [
				{
					id: "openai",
					enabled: true,
				},
				{
					id: "anthropic",
					enabled: false,
				},
			],
			defaults: {
				balanced: {
					providerId: "openai",
					modelId: "gpt-4.1",
				},
				best: {
					providerId: "anthropic",
					modelId: "claude-opus-4-6",
				},
			},
			memoryModels: {
				extraction: {
					providerId: "openai",
					modelId: "gpt-4.1-mini",
				},
			},
			agentModelOverrides: {},
		});
	});

	test("rebuilds the runtime registry after provider settings change", async () => {
		const registrySettings: string[][] = [];
		const checkConnectionCalls: string[] = [];
		const clientUpdates: string[][] = [];
		const genomeRuntimeUpdates: Array<{ client: unknown; providers: string[] }> = [];
		const runtimeClient = {
			replaceProviders(nextProviders: Record<string, unknown>) {
				clientUpdates.push(Object.keys(nextProviders));
			},
		};
		const runtime = await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: {
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
					genomeService: {
						updateRuntimeClient: (client, resolverSettings) => {
							genomeRuntimeUpdates.push({
								client,
								providers: resolverSettings.providers.map((provider) => provider.id),
							});
						},
					},
				},
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createSettingsStore: () => emptySettingsStore(),
				createSecretStore: () => memorySecretStore(),
				createProviderRegistry: ({ settings }) => {
					registrySettings.push(settings.providers.map((provider) => provider.id));
					return {
						getEntries: async () =>
							settings.providers.map((provider) => ({
								provider,
								validationErrors: [],
								adapter: fakeAdapter(
									provider.id,
									"openai-compatible",
									[{ id: "qwen2.5-coder", label: "Qwen 2.5 Coder", source: "remote" }],
									{
										failListModels: false,
									},
								),
							})),
						getEntry: async (providerId: string) => {
							const provider = settings.providers.find((candidate) => candidate.id === providerId);
							if (!provider) return undefined;
							return {
								provider,
								validationErrors: [],
								adapter: {
									...fakeAdapter(provider.id, "openai-compatible", [
										{ id: "qwen2.5-coder", label: "Qwen 2.5 Coder", source: "remote" },
									]),
									async checkConnection() {
										checkConnectionCalls.push(provider.id);
										return { ok: true as const };
									},
								},
							};
						},
					};
				},
				createClient: async () => runtimeClient,
				createController: () => ({ sessionId: "01BOOT" }),
			},
		);

		const controlPlane = runtime.settingsControlPlane as {
			execute: (command: Record<string, unknown>) => Promise<any>;
		};
		await controlPlane.execute({
			kind: "create_provider",
			data: {
				kind: "openai-compatible",
				label: "LM Studio",
				baseUrl: "http://127.0.0.1:1234/v1",
			},
		});
		const connection = await controlPlane.execute({
			kind: "test_provider_connection",
			data: { providerId: "openai-compatible" },
		});

		expect(registrySettings).toEqual([[], ["openai-compatible"], ["openai-compatible"]]);
		expect(clientUpdates).toEqual([["openai-compatible"], ["openai-compatible"]]);
		expect(genomeRuntimeUpdates).toEqual([
			{ client: runtimeClient, providers: [] },
			{ client: runtimeClient, providers: ["openai-compatible"] },
			{ client: runtimeClient, providers: ["openai-compatible"] },
		]);
		expect(checkConnectionCalls).toEqual(["openai-compatible"]);
		expect(connection).toMatchObject({
			ok: true,
			snapshot: {
				providers: [
					{
						providerId: "openai-compatible",
						connectionStatus: "ok",
					},
				],
			},
		});
	});

	test("clears startup validation errors once a provider is repaired", async () => {
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "openai",
					kind: "openai" as const,
					label: "OpenAI",
					enabled: false,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
			],
			defaults: {},
		};
		const runtime = await bootstrapSessionRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: () => ({ info: () => {} }),
				createSettingsStore: () => ({
					load: async () => ({
						settings,
						skipEnvImport: false,
						source: "loaded" as const,
					}),
					save: async () => {},
				}),
				createSecretStore: () => memorySecretStore(),
				createProviderRegistry: () => ({
					getEntries: async () => [
						{
							provider: settings.providers[0]!,
							validationErrors: ["API key is required"],
						},
					],
					getEntry: async () => undefined,
				}),
				createClient: async () => ({ replaceProviders() {} }),
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
			},
		);

		const controlPlane = runtime.settingsControlPlane as {
			execute: (command: Record<string, unknown>) => Promise<any>;
		};
		await controlPlane.execute({
			kind: "set_provider_secret",
			data: {
				providerId: "openai",
				secret: "openai-secret",
			},
		});
		const snapshot = await controlPlane.execute({ kind: "get_settings", data: {} });

		expect(snapshot).toMatchObject({
			ok: true,
			snapshot: {
				providers: [
					{
						providerId: "openai",
						validationErrors: [],
					},
				],
			},
		});
	});
});
