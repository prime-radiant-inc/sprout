import { afterEach, describe, expect, test } from "bun:test";
import type {
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "@kernel/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createDefaultSelectionCommand,
	createProviderPriorityCommand,
	createTierPriorityCommand,
	moveProviderPriority,
	toggleTierProviderSelection,
} from "../settings/DefaultsPanel.tsx";
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
							tierHint: "fast",
							rank: 5,
						},
					],
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
			],
			defaults: {
				selection: {
					kind: "model",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
			},
			routing: {
				providerPriority: ["anthropic-main", "lmstudio"],
				tierOverrides: {
					best: ["anthropic-main"],
					fast: ["lmstudio"],
				},
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
						id: "claude-sonnet-4-6",
						label: "Claude Sonnet 4.6",
						tierHint: "balanced",
						rank: 10,
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
						tierHint: "fast",
						rank: 5,
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

	test("renders loading and empty states", () => {
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
					settings={{
						runtime: {
							secretBackend: {
								backend: "memory",
								available: true,
							},
							warnings: [],
						},
						settings: {
							version: 1,
							providers: [],
							defaults: { selection: { kind: "none" } },
							routing: { providerPriority: [], tierOverrides: {} },
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

	test("renders unavailable state when settings cannot be loaded", () => {
		const html = renderToStaticMarkup(
			<ProviderSettingsPanel
				settings={null}
				lastResult={makeResult({
					code: "settings_unavailable",
					message: "Settings control plane is unavailable",
				})}
				onCommand={() => {}}
				onClose={() => {}}
			/>,
		);

		expect(html).toContain("Provider settings are unavailable");
		expect(html).toContain("Settings control plane is unavailable");
	});

	test("renders provider health, unsupported secret backend messaging, and discovered models", () => {
		const result = makeResult({ message: "Latest command failed" });
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		const html = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={makeSettings().settings.providers[0]}
				status={makeSettings().providers[0]}
				catalogEntry={makeSettings().catalog[0]}
				message={result.message}
				onCommand={() => {}}
			/>,
		);
		expect(html).toContain("Unsupported secret backend");
		expect(html).toContain("Auth failed");
		expect(html).toContain("Refresh required");
		expect(html).toContain("Claude Sonnet 4.6");
		expect(html).toContain("Latest command failed");
		expect(logged).toEqual([]);
	});

	test("renders panel-level runtime warnings", () => {
		const settings = makeSettings();
		settings.runtime.warnings = [
			{
				code: "invalid_settings_recovered",
				message: "Recovered invalid settings file to /tmp/settings.invalid.2026-03-12.json",
			},
			{
				code: "secret_backend_unavailable",
				message: "Unsupported secret backend for platform: win32",
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

		expect(html).toContain("Recovered invalid settings file to /tmp/settings.invalid.2026-03-12.json");
		expect(html).toContain("Unsupported secret backend for platform: win32");
	});

	test("builds create and edit provider commands with manual models and headers", () => {
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
						tierHint: "fast",
						rank: "3",
					},
				],
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
						tierHint: "fast",
						rank: 3,
					},
				],
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
							tierHint: "",
							rank: "",
						},
					],
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
			}),
		).toBeUndefined();
	});

	test("renders field-level errors, manual models, and custom headers for supported providers", () => {
		const html = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={makeSettings().settings.providers[1]}
				status={makeSettings().providers[1]}
				catalogEntry={makeSettings().catalog[1]}
				message="Validation failed"
				fieldErrors={{
					baseUrl: "Base URL must be a valid http or https URL",
					manualModels: "Manual models must use unique ids",
					nonSecretHeaders: "Header names must be unique",
				}}
				onCommand={() => {}}
			/>,
		);

		expect(html).toContain("Base URL must be a valid http or https URL");
		expect(html).toContain("Manual models");
		expect(html).toContain("Manual models must use unique ids");
		expect(html).toContain("Custom headers");
		expect(html).toContain("Header names must be unique");
		expect(html).toContain("Qwen 2.5 Coder");
	});

	test("hides custom header editing for gemini providers", () => {
		const html = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={{
					id: "gemini-main",
					kind: "gemini",
					label: "Gemini",
					enabled: true,
					discoveryStrategy: "remote-only",
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				}}
				status={{
					providerId: "gemini-main",
					hasSecret: true,
					validationErrors: [],
					connectionStatus: "ok",
					catalogStatus: "current",
				}}
				catalogEntry={{
					providerId: "gemini-main",
					models: [],
				}}
				message={null}
				onCommand={() => {}}
			/>,
		);

		expect(html).not.toContain("Custom headers");
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

	test("builds default selection and routing commands", () => {
		expect(createDefaultSelectionCommand("tier", "fast", "")).toEqual({
			kind: "set_default_selection",
			data: {
				selection: {
					kind: "tier",
					tier: "fast",
				},
			},
		} satisfies SettingsCommand);
		expect(
			createDefaultSelectionCommand(
				"model",
				"balanced",
				"lmstudio:qwen2.5-coder",
			),
		).toEqual({
			kind: "set_default_selection",
			data: {
				selection: {
					kind: "model",
					model: {
						providerId: "lmstudio",
						modelId: "qwen2.5-coder",
					},
				},
			},
		} satisfies SettingsCommand);
		expect(moveProviderPriority(["anthropic-main", "lmstudio"], "lmstudio", -1)).toEqual([
			"lmstudio",
			"anthropic-main",
		]);
		expect(toggleTierProviderSelection(["anthropic-main"], "lmstudio")).toEqual([
			"anthropic-main",
			"lmstudio",
		]);
		expect(createProviderPriorityCommand(["lmstudio", "anthropic-main"])).toEqual({
			kind: "set_provider_priority",
			data: {
				providerIds: ["lmstudio", "anthropic-main"],
			},
		} satisfies SettingsCommand);
		expect(createTierPriorityCommand("best", ["anthropic-main", "lmstudio"])).toEqual({
			kind: "set_tier_priority",
			data: {
				tier: "best",
				providerIds: ["anthropic-main", "lmstudio"],
			},
		} satisfies SettingsCommand);
	});
});
