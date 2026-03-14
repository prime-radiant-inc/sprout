import { describe, expect, test } from "bun:test";
import { importSettingsFromEnv } from "../../src/host/settings/env-import.ts";
import {
	createProviderSecretRef,
	createSecretStore,
	type SecretStore,
} from "../../src/host/settings/secret-store.ts";

describe("importSettingsFromEnv", () => {
	test("maps env-backed providers into deterministic order with stable ids", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		const result = await importSettingsFromEnv({
			env: {
				OPENAI_API_KEY: "openai-secret",
				ANTHROPIC_API_KEY: "anthropic-secret",
				GOOGLE_API_KEY: "gemini-secret",
			},
			secretStore,
			secretBackend: "memory",
			now: () => "2026-03-11T12:34:56.000Z",
		});

		expect(
			result.settings.providers.map((provider) => ({
				id: provider.id,
				kind: provider.kind,
				enabled: provider.enabled,
			})),
		).toEqual([
			{ id: "anthropic", kind: "anthropic", enabled: true },
			{ id: "openai", kind: "openai", enabled: true },
			{ id: "gemini", kind: "gemini", enabled: true },
		]);
		expect(result.settings.defaults).toEqual({});
		expect(result.validationErrorsByProvider).toEqual({});
		expect(await secretStore.getSecret(createProviderSecretRef("anthropic", "memory"))).toBe(
			"anthropic-secret",
		);
		expect(await secretStore.getSecret(createProviderSecretRef("openai", "memory"))).toBe(
			"openai-secret",
		);
		expect(await secretStore.getSecret(createProviderSecretRef("gemini", "memory"))).toBe(
			"gemini-secret",
		);
	});

	test("keeps provider metadata but disables providers when secret migration fails", async () => {
		const secretStore: SecretStore = {
			async getSecret() {
				return undefined;
			},
			async setSecret() {
				throw new Error("keychain unavailable");
			},
			async deleteSecret() {},
			async hasSecret() {
				return false;
			},
		};

		const result = await importSettingsFromEnv({
			env: {
				ANTHROPIC_API_KEY: "anthropic-secret",
			},
			secretStore,
			secretBackend: "macos-keychain",
			now: () => "2026-03-11T12:34:56.000Z",
		});

		expect(result.settings.providers).toHaveLength(1);
		expect(result.settings.providers[0]).toMatchObject({
			id: "anthropic",
			kind: "anthropic",
			enabled: false,
		});
		expect(result.settings.defaults).toEqual({});
		expect(result.validationErrorsByProvider).toEqual({
			anthropic: ["Credential migration failed: keychain unavailable"],
		});
	});

	test("imports openrouter credentials and default-model tuples from env", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "linux" });
		const result = await importSettingsFromEnv({
			env: {
				OPENROUTER_API_KEY: "openrouter-secret",
				SPROUT_DEFAULT_BEST_MODEL: "openrouter:openai/gpt-4o-mini",
				SPROUT_DEFAULT_BALANCED_MODEL: "openrouter:openai/gpt-4o-mini",
				SPROUT_DEFAULT_FAST_MODEL: "openrouter:openai/gpt-4o-mini",
			},
			secretStore,
			secretBackend: "memory",
			now: () => "2026-03-14T12:00:00.000Z",
		});

		expect(result.settings.providers).toEqual([
			{
				id: "openrouter",
				kind: "openrouter",
				label: "OpenRouter",
				enabled: true,
				createdAt: "2026-03-14T12:00:00.000Z",
				updatedAt: "2026-03-14T12:00:00.000Z",
			},
		]);
		expect(result.settings.defaults).toEqual({
			best: { providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
			balanced: { providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
			fast: { providerId: "openrouter", modelId: "openai/gpt-4o-mini" },
		});
		expect(await secretStore.getSecret(createProviderSecretRef("openrouter", "memory"))).toBe(
			"openrouter-secret",
		);
	});
});
