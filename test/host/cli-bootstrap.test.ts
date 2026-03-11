import { describe, expect, test } from "bun:test";
import { bootstrapInteractiveRuntime } from "../../src/host/cli-bootstrap.ts";
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
	return {
		backend: "memory" as const,
		secretStore: {
			getSecret: async () => undefined,
			setSecret: async () => {},
			deleteSecret: async () => {},
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

describe("bootstrapInteractiveRuntime", () => {
	test("builds runtime wiring and emits stderr-enabled info log", async () => {
		const created: Record<string, unknown> = {};
		const logger = {
			info: (category: string, message: string, data?: Record<string, unknown>) => {
				created.info = { category, message, data };
			},
		};

		const result = await bootstrapInteractiveRuntime(
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
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
				logStderr: true,
				debug: false,
			},
			{
				createBus: () => ({ id: "bus" }),
				createSettingsStore: () => emptySettingsStore(),
				createSecretStore: () => memorySecretStore(),
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
		await bootstrapInteractiveRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
				logStderr: false,
				debug: true,
			},
			{
				createBus: () => ({ id: "bus" }),
				createSettingsStore: () => emptySettingsStore(),
				createSecretStore: () => memorySecretStore(),
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
					discoveryStrategy: "remote-only" as const,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
			],
			routing: {
				providerPriority: ["anthropic"],
				tierOverrides: {},
			},
		};

		await bootstrapInteractiveRuntime(
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
					save: async (settings) => {
						created.savedSettings = settings;
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
		expect(created.savedSettings).toEqual(importedSettings);
	});

	test("does not import env-backed settings after invalid-file recovery", async () => {
		const created: Record<string, unknown> = {};

		await bootstrapInteractiveRuntime(
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
					discoveryStrategy: "remote-only" as const,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
				{
					id: "openrouter",
					kind: "openrouter" as const,
					label: "OpenRouter",
					enabled: true,
					discoveryStrategy: "remote-only" as const,
					createdAt: "2026-03-11T12:34:56.000Z",
					updatedAt: "2026-03-11T12:34:56.000Z",
				},
			],
			routing: {
				providerPriority: ["anthropic", "openrouter"],
				tierOverrides: {},
			},
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

		const result = await bootstrapInteractiveRuntime(
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
					backend: "memory",
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
		expect(result.availableModels).toContain("claude-opus-4-6");
		expect(result.availableModels).not.toContain("openrouter");
	});
});
