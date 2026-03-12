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

	test("builds create and edit provider commands", () => {
		expect(
			createProviderSaveCommand("create", {
				kind: "openrouter",
				label: "OpenRouter",
				discoveryStrategy: "remote-only",
			}),
		).toEqual({
			kind: "create_provider",
			data: {
				kind: "openrouter",
				label: "OpenRouter",
				discoveryStrategy: "remote-only",
			},
		} satisfies SettingsCommand);

		expect(
			createProviderSaveCommand(
				"edit",
				{
					kind: "openai-compatible",
					label: "Local LM Studio",
					baseUrl: "http://127.0.0.1:4321/v1",
					discoveryStrategy: "remote-with-manual",
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
					discoveryStrategy: "remote-with-manual",
				},
			},
		} satisfies SettingsCommand);
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
