import { describe, expect, test } from "bun:test";
import { bootstrapInteractiveRuntime } from "../../src/host/cli-bootstrap.ts";
import { createEmptySettings } from "../../src/host/settings/types.ts";

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
				createLogger: (opts) => {
					created.loggerOpts = opts;
					return logger;
				},
				createClient: async (incomingLogger) => {
					created.clientLogger = incomingLogger;
					return { id: "client" };
				},
				createController: (opts) => {
					created.controllerOpts = opts;
					return { sessionId: "01BOOT" };
				},
				loadAvailableModels: async (client) => {
					created.availableModelsClient = client;
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
				createLogger: (opts) => {
					created.loggerOpts = opts;
					return { info: () => {} };
				},
				createClient: async () => ({ id: "client" }),
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
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
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
				createSecretStore: () =>
					({
						getSecret: async () => undefined,
						setSecret: async () => {},
						deleteSecret: async () => {},
						hasSecret: async () => false,
					}) as any,
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
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
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
				createSecretStore: () =>
					({
						getSecret: async () => undefined,
						setSecret: async () => {},
						deleteSecret: async () => {},
						hasSecret: async () => false,
					}) as any,
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
});
