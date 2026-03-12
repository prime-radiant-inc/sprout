import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SettingsControlPlane,
	type SettingsSnapshot,
} from "../../src/host/settings/control-plane.ts";
import {
	createProviderSecretRef,
	createSecretStore,
	type SecretStore,
} from "../../src/host/settings/secret-store.ts";
import { SettingsStore } from "../../src/host/settings/store.ts";
import { createEmptySettings, type SproutSettings } from "../../src/host/settings/types.ts";

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
		runtimeWarnings?: ConstructorParameters<typeof SettingsControlPlane>[0]["runtimeWarnings"];
		onSettingsUpdated?: (snapshot: SettingsSnapshot) => void;
		checkConnection?: ConstructorParameters<typeof SettingsControlPlane>[0]["checkConnection"];
		refreshModels?: ConstructorParameters<typeof SettingsControlPlane>[0]["refreshModels"];
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
		runtimeWarnings: options.runtimeWarnings,
		initialSettings: options.initialSettings ?? createEmptySettings(),
		onSettingsUpdated: options.onSettingsUpdated,
		checkConnection: options.checkConnection,
		refreshModels: options.refreshModels,
		now: () => "2026-03-11T12:34:56.000Z",
	});
}

describe("SettingsControlPlane", () => {
	test("creates providers, manages secrets, and enables them after validation", async () => {
		const snapshots: SettingsSnapshot[] = [];
		const plane = await makePlane({
			onSettingsUpdated: (snapshot) => snapshots.push(snapshot),
		});

		const created = await plane.execute({
			kind: "create_provider",
			data: {
				kind: "openai",
				label: "OpenAI",
				discoveryStrategy: "remote-only",
			},
		});
		expect(created.ok).toBe(true);
		const providerId = created.ok ? created.snapshot.settings.providers[0]?.id : undefined;
		expect(providerId).toBe("openai");
		if (!providerId) throw new Error("expected provider id");

		const enableWithoutSecret = await plane.execute({
			kind: "set_provider_enabled",
			data: {
				providerId,
				enabled: true,
			},
		});
		expect(enableWithoutSecret).toEqual({
			ok: false,
			code: "validation_failed",
			message: "API key is required",
			fieldErrors: {
				secret: "API key is required",
			},
		});

		const secretResult = await plane.execute({
			kind: "set_provider_secret",
			data: {
				providerId,
				secret: "openai-secret",
			},
		});
		expect(secretResult.ok).toBe(true);

		const enabled = await plane.execute({
			kind: "set_provider_enabled",
			data: {
				providerId,
				enabled: true,
			},
		});
		expect(enabled).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					routing: {
						providerPriority: ["openai"],
					},
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
		expect(snapshots).toHaveLength(3);
	});

	test("updates routing, clears defaults on delete, and removes stored secrets", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(createProviderSecretRef("openai", "memory"), "openai-secret");
		const plane = await makePlane({
			secretStore,
			initialSettings: {
				version: 1,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: true,
						discoveryStrategy: "remote-only",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
					{
						id: "lmstudio",
						kind: "openai-compatible",
						label: "LM Studio",
						enabled: true,
						baseUrl: "http://127.0.0.1:1234/v1",
						discoveryStrategy: "manual-only",
						manualModels: [{ id: "qwen2.5-coder", label: "Qwen 2.5 Coder" }],
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: {
					selection: {
						kind: "model",
						model: {
							providerId: "openai",
							modelId: "gpt-4o",
						},
					},
				},
				routing: {
					providerPriority: ["openai", "lmstudio"],
					tierOverrides: {
						fast: ["openai"],
					},
				},
			},
		});

		const priority = await plane.execute({
			kind: "set_provider_priority",
			data: { providerIds: ["lmstudio", "openai"] },
		});
		expect(priority).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					routing: {
						providerPriority: ["lmstudio", "openai"],
					},
				},
			},
		});

		const tierPriority = await plane.execute({
			kind: "set_tier_priority",
			data: { tier: "fast", providerIds: ["lmstudio"] },
		});
		expect(tierPriority).toMatchObject({
			ok: true,
			snapshot: {
				settings: {
					routing: {
						tierOverrides: {
							fast: ["lmstudio"],
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
					defaults: { selection: { kind: "none" } },
					routing: {
						providerPriority: ["lmstudio"],
						tierOverrides: {
							fast: ["lmstudio"],
						},
					},
				},
			},
		});
		expect(await secretStore.hasSecret(createProviderSecretRef("openai", "memory"))).toBe(false);
	});

	test("surfaces provider health failures in snapshots without failing the command", async () => {
		const plane = await makePlane({
			initialSettings: {
				version: 1,
				providers: [
					{
						id: "lmstudio",
						kind: "openai-compatible",
						label: "LM Studio",
						enabled: true,
						baseUrl: "http://127.0.0.1:1234/v1",
						discoveryStrategy: "manual-only",
						manualModels: [{ id: "qwen2.5-coder", label: "Qwen 2.5 Coder" }],
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: { selection: { kind: "none" } },
				routing: { providerPriority: ["lmstudio"], tierOverrides: {} },
			},
			checkConnection: async () => {
				throw new Error("connection refused");
			},
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
						models: [{ id: "qwen2.5-coder", source: "manual" }],
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
				discoveryStrategy: "manual-only",
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
				version: 1,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: true,
						discoveryStrategy: "remote-only",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: { selection: { kind: "none" } },
				routing: { providerPriority: ["openai"], tierOverrides: {} },
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
				version: 1,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: true,
						discoveryStrategy: "remote-only",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: { selection: { kind: "none" } },
				routing: { providerPriority: ["openai"], tierOverrides: {} },
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
				discoveryStrategy: "manual-only",
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
				discoveryStrategy: "remote-only",
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
				version: 1,
				providers: [
					{
						id: "openai",
						kind: "openai",
						label: "OpenAI",
						enabled: false,
						discoveryStrategy: "remote-only",
						createdAt: "2026-03-11T12:00:00.000Z",
						updatedAt: "2026-03-11T12:00:00.000Z",
					},
				],
				defaults: { selection: { kind: "none" } },
				routing: { providerPriority: [], tierOverrides: {} },
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
				discoveryStrategy: "manual-only",
			},
		});
		expect(created).toMatchObject({
			ok: true,
			snapshot: {
				runtime: {
					warnings: [warning],
				},
			},
		});
	});
});
