import { afterEach, describe, expect, test } from "bun:test";
import { createProviderCredentialRef } from "../../src/host/settings/provider-credentials.ts";
import {
	createProviderSecretRef,
	createSecretStore,
	createSecretStoreRuntime,
	type SecretStore,
} from "../../src/host/settings/secret-store.ts";
import type { ProviderConfig, SproutSettings } from "../../src/host/settings/types.ts";
import { ProviderRegistry } from "../../src/llm/provider-registry.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function makeSettings(providers: ProviderConfig[]): SproutSettings {
	return {
		version: 4,
		providers,
		defaults: {},
		memoryModels: {},
		agentModelOverrides: {},
	};
}

describe("ProviderRegistry", () => {
	test("constructs secret-optional openai-compatible providers with their configured base URL", async () => {
		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
					enabled: true,
					baseUrl: "http://127.0.0.1:1234/v1",
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore: createSecretStore({ backend: "memory", platform: "darwin" }),
			secretBackend: "memory",
		});

		const entry = await registry.getEntry("lmstudio");
		expect(entry?.validationErrors).toEqual([]);
		expect(entry?.adapter?.providerId).toBe("lmstudio");
		expect(entry?.adapter?.kind).toBe("openai-compatible");
	});

	test("builds openrouter adapters against the openrouter base URL and forwards non-secret headers", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(
			createProviderSecretRef("openrouter-main", "memory"),
			"openrouter-secret",
		);

		const requests: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (input, init) => {
			requests.push({
				url:
					typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
				headers: new Headers(init?.headers),
			});
			return new Response(
				JSON.stringify({
					data: [{ id: "openrouter/anthropic/claude-3.7-sonnet" }],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as typeof fetch;

		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "openrouter-main",
					kind: "openrouter",
					label: "OpenRouter",
					enabled: true,
					nonSecretHeaders: {
						"HTTP-Referer": "https://sprout.test",
						"X-Title": "Sprout",
					},
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore,
			secretBackend: "memory",
		});

		const entry = await registry.getEntry("openrouter-main");
		expect(entry?.validationErrors).toEqual([]);
		expect(await entry?.adapter?.checkConnection()).toEqual({ ok: true });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/models");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer openrouter-secret");
		expect(requests[0]?.headers.get("http-referer")).toBe("https://sprout.test");
		expect(requests[0]?.headers.get("x-title")).toBe("Sprout");
	});

	test("reports validation errors instead of constructing adapters when required secrets are missing", async () => {
		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "openai",
					kind: "openai",
					label: "OpenAI",
					enabled: true,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore: createSecretStore({ backend: "memory", platform: "darwin" }),
			secretBackend: "memory",
		});

		const entry = await registry.getEntry("openai");
		expect(entry?.adapter).toBeUndefined();
		expect(entry?.validationErrors).toContain("API key is required");
	});

	test("does not construct adapters for disabled providers", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(
			createProviderCredentialRef("openai", "api-key", "memory"),
			"openai-secret",
		);
		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "openai",
					kind: "openai",
					label: "OpenAI",
					enabled: false,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore,
			secretBackend: "memory",
		});

		const entry = await registry.getEntry("openai");
		expect(entry?.adapter).toBeUndefined();
		expect(entry?.validationErrors).toEqual(["Provider is disabled"]);
	});

	test("does not check secrets for disabled providers", async () => {
		const throwingSecretStore: SecretStore = {
			async getSecret() {
				throw new Error("disabled provider should not read secrets");
			},
			async setSecret() {
				throw new Error("disabled provider should not write secrets");
			},
			async deleteSecret() {
				throw new Error("disabled provider should not delete secrets");
			},
			async hasSecret() {
				throw new Error("disabled provider should not check secrets");
			},
		};
		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "openai",
					kind: "openai",
					label: "OpenAI",
					enabled: false,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore: throwingSecretStore,
			secretBackend: "memory",
		});

		const entry = await registry.getEntry("openai");
		expect(entry?.adapter).toBeUndefined();
		expect(entry?.validationErrors).toEqual(["Provider is disabled"]);
	});

	test("does not satisfy OpenAI Codex readiness with an api-key credential ref", async () => {
		const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
		await secretStore.setSecret(
			createProviderSecretRef("openai-codex", "memory"),
			"api-key-secret",
		);

		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "openai-codex",
					kind: "openai-codex",
					label: "OpenAI Codex",
					enabled: true,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore,
			secretBackend: "memory",
		});

		const entry = await registry.getEntry("openai-codex");
		expect(entry?.adapter).toBeUndefined();
		expect(entry?.validationErrors).toEqual(["ChatGPT OAuth login is required for OpenAI Codex"]);
		expect(
			await secretStore.hasSecret(createProviderCredentialRef("openai-codex", "oauth", "memory")),
		).toBe(false);
	});

	test("reports unavailable secret backend distinctly instead of collapsing it into a missing secret", async () => {
		const runtime = createSecretStoreRuntime({
			backend: "macos-keychain",
			platform: "linux",
		});
		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "openai",
					kind: "openai",
					label: "OpenAI",
					enabled: true,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore: runtime.secretStore,
			secretBackend: runtime.secretRefBackend,
			secretBackendState: runtime.secretBackendState,
		});

		const entry = await registry.getEntry("openai");
		expect(entry?.adapter).toBeUndefined();
		expect(entry?.validationErrors).toEqual(["Secret storage backend is unavailable"]);
	});

	test("reports malformed base URLs consistently instead of constructing adapters", async () => {
		const registry = new ProviderRegistry({
			settings: makeSettings([
				{
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
					enabled: true,
					baseUrl: "localhost:1234/v1",
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				},
			]),
			secretStore: createSecretStore({ backend: "memory", platform: "darwin" }),
			secretBackend: "memory",
		});

		const entry = await registry.getEntry("lmstudio");
		expect(entry?.adapter).toBeUndefined();
		expect(entry?.validationErrors).toEqual(["Base URL must be a valid http or https URL"]);
	});
});
