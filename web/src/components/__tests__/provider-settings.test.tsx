import { afterEach, describe, expect, test } from "bun:test";
import type {
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "@kernel/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { DefaultProviderPanel } from "../settings/DefaultProviderPanel.tsx";
import {
	createDeleteProviderCommand,
	createDeleteProviderSecretCommand,
	createProviderSaveCommand,
	createRefreshProviderModelsCommand,
	createSetProviderSecretCommand,
	createTestProviderConnectionCommand,
	createToggleProviderEnabledCommand,
	ProviderEditor,
	validateProviderDraftForSave,
} from "../settings/ProviderEditor.tsx";
import { ProviderSettingsPanel } from "../settings/ProviderSettingsPanel.tsx";

function makeSettings(): SettingsSnapshot {
	return {
		runtime: {
			secretBackend: {
				backend: "memory",
				available: true,
			},
			warnings: [],
		},
		settings: {
			version: 1,
			providers: [
				{
					id: "anthropic-main",
					kind: "anthropic",
					label: "Anthropic",
					enabled: true,
					discoveryStrategy: "remote-with-manual",
					tierDefaults: {
						best: "claude-opus-4-6",
						balanced: "claude-sonnet-4-6",
					},
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
				{
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
					enabled: false,
					baseUrl: "http://127.0.0.1:1234/v1",
					discoveryStrategy: "manual-only",
					manualModels: [
						{
							id: "qwen2.5-coder",
							label: "Qwen 2.5 Coder",
						},
					],
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
			],
			defaults: {
				defaultProviderId: "anthropic-main",
			},
		},
		providers: [
			{
				providerId: "anthropic-main",
				hasSecret: true,
				validationErrors: ["Unsupported secret backend"],
				connectionStatus: "error",
				connectionError: "Auth failed",
				catalogStatus: "stale",
				catalogError: "Refresh required",
			},
			{
				providerId: "lmstudio",
				hasSecret: false,
				validationErrors: [],
				connectionStatus: "unknown",
				catalogStatus: "current",
			},
		],
		catalog: [
			{
				providerId: "anthropic-main",
				lastRefreshAt: "2026-03-11T00:00:00.000Z",
				models: [
					{
						id: "claude-opus-4-6",
						label: "Claude Opus 4.6",
						source: "remote",
					},
					{
						id: "claude-sonnet-4-6",
						label: "Claude Sonnet 4.6",
						source: "remote",
					},
				],
			},
			{
				providerId: "lmstudio",
				models: [
					{
						id: "qwen2.5-coder",
						label: "Qwen 2.5 Coder",
						source: "manual",
					},
				],
			},
		],
	};
}

function makeResult(
	overrides: Partial<Extract<SettingsCommandResult, { ok: false }>> = {},
): Extract<SettingsCommandResult, { ok: false }> {
	return {
		ok: false,
		code: "validation_error",
		message: "Validation failed",
		...overrides,
	};
}

describe("ProviderSettingsPanel", () => {
	const originalConsoleError = console.error;

	afterEach(() => {
		console.error = originalConsoleError;
	});

	test("renders loading, unavailable, and empty states", () => {
		expect(
			renderToStaticMarkup(
				<ProviderSettingsPanel
					settings={null}
					lastResult={null}
					onCommand={() => {}}
					onClose={() => {}}
				/>,
			),
		).toContain("Loading provider settings");

		expect(
			renderToStaticMarkup(
				<ProviderSettingsPanel
					settings={null}
					lastResult={makeResult({
						code: "settings_unavailable",
						message: "Settings control plane is unavailable",
					})}
					onCommand={() => {}}
					onClose={() => {}}
				/>,
			),
		).toContain("Provider settings are unavailable");

		expect(
			renderToStaticMarkup(
				<ProviderSettingsPanel
					settings={{
						...makeSettings(),
						settings: {
							version: 1,
							providers: [],
							defaults: {},
						},
						providers: [],
						catalog: [],
					}}
					lastResult={null}
					onCommand={() => {}}
					onClose={() => {}}
				/>,
			),
		).toContain("No providers configured");
	});

	test("renders the default provider panel and runtime warnings", () => {
		const settings = makeSettings();
		settings.runtime.warnings = [
			{
				code: "invalid_settings_recovered",
				message: "Recovered invalid settings file to /tmp/settings.invalid.json",
			},
		];

		const html = renderToStaticMarkup(
			<ProviderSettingsPanel
				settings={settings}
				lastResult={null}
				onCommand={() => {}}
				onClose={() => {}}
			/>,
		);

		expect(html).toContain("Default provider");
		expect(html).toContain("Recovered invalid settings file to /tmp/settings.invalid.json");
	});

	test("renders provider health, discovered models, and tier defaults", () => {
		const html = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={makeSettings().settings.providers[0]}
				status={makeSettings().providers[0]}
				catalogEntry={makeSettings().catalog[0]}
				message="Validation failed"
				onCommand={() => {}}
			/>,
		);

		expect(html).toContain("Unsupported secret backend");
		expect(html).toContain("Auth failed");
		expect(html).toContain("Refresh required");
		expect(html).toContain("Tier defaults");
		expect(html).toContain("Claude Sonnet 4.6");
	});
});

describe("DefaultProviderPanel", () => {
	test("renders the current enabled default provider", () => {
		const html = renderToStaticMarkup(
			<DefaultProviderPanel settings={makeSettings()} onCommand={() => {}} />,
		);

		expect(html).toContain("Default provider");
		expect(html).toContain("Anthropic");
	});
});

describe("ProviderEditor helpers", () => {
	test("builds create and edit provider commands with manual models and tier defaults", () => {
		expect(
			createProviderSaveCommand("create", {
				kind: "openrouter",
				label: "OpenRouter",
				nonSecretHeaders: [
					{
						key: "HTTP-Referer",
						value: "https://sprout.local",
					},
				],
				discoveryStrategy: "remote-only",
				manualModels: [
					{
						id: "openrouter/manual-fast",
						label: "Manual Fast",
					},
				],
				tierDefaults: {
					fast: "openai/gpt-4o-mini",
				},
			}),
		).toEqual({
			kind: "create_provider",
			data: {
				kind: "openrouter",
				label: "OpenRouter",
				nonSecretHeaders: {
					"HTTP-Referer": "https://sprout.local",
				},
				discoveryStrategy: "remote-only",
				manualModels: [
					{
						id: "openrouter/manual-fast",
						label: "Manual Fast",
					},
				],
				tierDefaults: {
					fast: "openai/gpt-4o-mini",
				},
			},
		} satisfies SettingsCommand);

		expect(
			createProviderSaveCommand(
				"edit",
				{
					kind: "openai-compatible",
					label: "Local LM Studio",
					baseUrl: "http://127.0.0.1:4321/v1",
					nonSecretHeaders: [
						{
							key: "X-Client",
							value: "sprout",
						},
					],
					discoveryStrategy: "remote-with-manual",
					manualModels: [
						{
							id: "qwen2.5-coder",
							label: "Qwen 2.5 Coder",
						},
					],
					tierDefaults: {
						best: "qwen2.5-coder",
					},
				},
				"lmstudio",
			),
		).toEqual({
			kind: "update_provider",
			data: {
				providerId: "lmstudio",
				patch: {
					label: "Local LM Studio",
					baseUrl: "http://127.0.0.1:4321/v1",
					nonSecretHeaders: {
						"X-Client": "sprout",
					},
					discoveryStrategy: "remote-with-manual",
					manualModels: [
						{
							id: "qwen2.5-coder",
							label: "Qwen 2.5 Coder",
						},
					],
					tierDefaults: {
						best: "qwen2.5-coder",
					},
				},
			},
		} satisfies SettingsCommand);
	});

	test("validates required local save fields before dispatch", () => {
		expect(
			validateProviderDraftForSave({
				kind: "openai-compatible",
				label: "   ",
				baseUrl: "",
				discoveryStrategy: "manual-only",
				nonSecretHeaders: [],
				manualModels: [],
				tierDefaults: {},
			}),
		).toEqual({
			label: "Label is required.",
			baseUrl: "Base URL is required.",
		});

		expect(
			validateProviderDraftForSave({
				kind: "anthropic",
				label: "Anthropic",
				discoveryStrategy: "remote-only",
				nonSecretHeaders: [],
				manualModels: [],
				tierDefaults: {},
			}),
		).toBeUndefined();
	});

	test("builds secret and provider action commands", () => {
		expect(createSetProviderSecretCommand("lmstudio", "secret-token")).toEqual({
			kind: "set_provider_secret",
			data: {
				providerId: "lmstudio",
				secret: "secret-token",
			},
		} satisfies SettingsCommand);
		expect(createDeleteProviderSecretCommand("lmstudio")).toEqual({
			kind: "delete_provider_secret",
			data: {
				providerId: "lmstudio",
			},
		} satisfies SettingsCommand);
		expect(createToggleProviderEnabledCommand("lmstudio", true)).toEqual({
			kind: "set_provider_enabled",
			data: {
				providerId: "lmstudio",
				enabled: true,
			},
		} satisfies SettingsCommand);
		expect(createTestProviderConnectionCommand("lmstudio")).toEqual({
			kind: "test_provider_connection",
			data: {
				providerId: "lmstudio",
			},
		} satisfies SettingsCommand);
		expect(createRefreshProviderModelsCommand("lmstudio")).toEqual({
			kind: "refresh_provider_models",
			data: {
				providerId: "lmstudio",
			},
		} satisfies SettingsCommand);
		expect(createDeleteProviderCommand("lmstudio")).toEqual({
			kind: "delete_provider",
			data: {
				providerId: "lmstudio",
			},
		} satisfies SettingsCommand);
	});
});
