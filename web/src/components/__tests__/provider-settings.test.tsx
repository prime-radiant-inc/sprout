import { afterEach, describe, expect, test } from "bun:test";
import type {
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "@kernel/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AgentModelsPanel,
	createSetAgentModelCommand,
} from "../settings/AgentModelsPanel.tsx";
import { DefaultModelsPanel } from "../settings/DefaultModelsPanel.tsx";
import {
	createSetMemoryModelCommand,
	MemoryModelsPanel,
} from "../settings/MemoryModelsPanel.tsx";
import {
	createDeleteProviderCommand,
	createDeleteProviderSecretCommand,
	createProviderSaveCommand,
	createRefreshProviderModelsCommand,
	createSetProviderSecretCommand,
	createTestProviderConnectionCommand,
	createToggleProviderEnabledCommand,
	describePendingProviderAction,
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
			modelOverrides: {
				defaults: {},
				memoryModels: {},
				agentModels: {},
			},
		},
		settings: {
			version: 3,
			providers: [
				{
					id: "anthropic-main",
					kind: "anthropic",
					label: "Anthropic",
					enabled: true,
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
				{
					id: "lmstudio",
					kind: "openai-compatible",
					label: "LM Studio",
					enabled: true,
					baseUrl: "http://127.0.0.1:1234/v1",
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
			],
			defaults: {
				best: {
					providerId: "anthropic-main",
					modelId: "claude-opus-4-6",
				},
				balanced: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
				fast: {
					providerId: "lmstudio",
					modelId: "qwen2.5-coder",
				},
			},
			memoryModels: {},
			agentModels: {},
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
						source: "remote",
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
								version: 3,
								providers: [],
								defaults: {},
								memoryModels: {},
								agentModels: {},
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

	test("renders the default models panel and runtime warnings", () => {
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

		expect(html).toContain("Default models");
		expect(html).toContain("Memory models");
		expect(html).toContain("Agent models");
		expect(html).toContain("Recovered invalid settings file to /tmp/settings.invalid.json");
	});

	test("renders provider health and discovered models without provider-owned tier defaults", () => {
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
		expect(html).toContain("Claude Sonnet 4.6");
		expect(html).not.toContain("Discovery strategy");
		expect(html).not.toContain("Manual models");
	});

	test("renders pending provider action feedback", () => {
		const html = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={makeSettings().settings.providers[0]}
				status={makeSettings().providers[0]}
				catalogEntry={makeSettings().catalog[0]}
				pendingMessage="Refreshing models..."
				onCommand={() => {}}
			/>,
		);

		expect(html).toContain("Refreshing models...");
		expect(html).toContain("disabled");
	});
});

describe("DefaultModelsPanel", () => {
	test("renders the current enabled default models controls", () => {
		const html = renderToStaticMarkup(
			<DefaultModelsPanel settings={makeSettings()} onCommand={() => {}} />,
		);

		expect(html).toContain("Default models");
		expect(html).toContain("Anthropic");
		expect(html).toContain("Best model");
		expect(html).toContain("Balanced model");
		expect(html).toContain("Fast model");
		expect(html).toContain("Claude Opus 4.6");
		expect(html).toContain("Qwen 2.5 Coder");
	});

	test("keeps default model env override notes visible when no model catalog is loaded", () => {
		const settings = makeSettings();
		settings.catalog = settings.catalog.map((entry) => ({ ...entry, models: [] }));
		settings.runtime.modelOverrides.defaults.best = {
			source: "env",
			envVar: "SPROUT_DEFAULT_BEST_MODEL",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-opus-4-6",
			},
			catalogStatus: "not_loaded",
		};

		const html = renderToStaticMarkup(
			<DefaultModelsPanel settings={settings} onCommand={() => {}} />,
		);

		expect(html).toContain("Refresh models to configure default models.");
		expect(html).toContain("Stored: anthropic-main:claude-opus-4-6");
		expect(html).toContain("SPROUT_DEFAULT_BEST_MODEL");
		expect(html).toContain("anthropic-main:claude-opus-4-6");
	});
});

describe("MemoryModelsPanel", () => {
	test("renders memory model controls and env override notes", () => {
		const settings = makeSettings();
		settings.settings.memoryModels = {
			extraction: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		};
		settings.runtime.modelOverrides.memoryModels.subcortical = {
			source: "env",
			envVar: "SPROUT_MEMORY_SUBCORTICAL_MODEL",
			model: {
				providerId: "lmstudio",
				modelId: "qwen2.5-coder",
			},
			catalogStatus: "matched",
			displayLabel: "Qwen 2.5 Coder",
		};

		const html = renderToStaticMarkup(
			<MemoryModelsPanel settings={settings} onCommand={() => {}} />,
		);

		expect(html).toContain("Memory models");
		expect(html).toContain("Memory extraction");
		expect(html).toContain("Relationship classifier");
		expect(html).toContain("Subcortical recall");
		expect(html).toContain("SPROUT_MEMORY_SUBCORTICAL_MODEL");
		expect(html).toContain("Qwen 2.5 Coder");
	});

	test("builds set memory model commands", () => {
		expect(createSetMemoryModelCommand("extraction", "anthropic-main:claude-sonnet-4-6")).toEqual({
			kind: "set_memory_model",
			data: {
				purpose: "extraction",
				model: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
			},
		});
		expect(createSetMemoryModelCommand("subcortical", "")).toEqual({
			kind: "set_memory_model",
			data: {
				purpose: "subcortical",
				model: undefined,
			},
		});
	});

	test("keeps stale memory model values visible when no model catalog is loaded", () => {
		const settings = makeSettings();
		settings.catalog = settings.catalog.map((entry) => ({ ...entry, models: [] }));
		settings.settings.memoryModels = {
			extraction: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		};
		settings.runtime.modelOverrides.memoryModels.extraction = {
			source: "env",
			envVar: "SPROUT_MEMORY_EXTRACTION_MODEL",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
			catalogStatus: "not_loaded",
		};

		const html = renderToStaticMarkup(
			<MemoryModelsPanel settings={settings} onCommand={() => {}} />,
		);

		expect(html).toContain("Refresh models to configure memory models.");
		expect(html).toContain("Stored: anthropic-main:claude-sonnet-4-6");
		expect(html).toContain("SPROUT_MEMORY_EXTRACTION_MODEL");
	});
});

describe("AgentModelsPanel", () => {
	test("renders agent model controls and env override notes", () => {
		const settings = makeSettings();
		settings.settings.agentModels = {
			"observer.metacognitive": {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		};
		settings.runtime.modelOverrides.agentModels["observer.metacognitive"] = {
			source: "env",
			envVar: "SPROUT_OBSERVER_METACOGNITIVE_MODEL",
			model: {
				providerId: "lmstudio",
				modelId: "qwen2.5-coder",
			},
			catalogStatus: "matched",
			displayLabel: "Qwen 2.5 Coder",
		};

		const html = renderToStaticMarkup(
			<AgentModelsPanel settings={settings} onCommand={() => {}} />,
		);

		expect(html).toContain("Agent models");
		expect(html).toContain("Metacognitive observer");
		expect(html).toContain("SPROUT_OBSERVER_METACOGNITIVE_MODEL");
		expect(html).toContain("Qwen 2.5 Coder");
	});

	test("builds set agent model commands", () => {
		expect(
			createSetAgentModelCommand(
				"observer.metacognitive",
				"anthropic-main:claude-sonnet-4-6",
			),
		).toEqual({
			kind: "set_agent_model",
			data: {
				purpose: "observer.metacognitive",
				model: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
			},
		});
		expect(createSetAgentModelCommand("observer.metacognitive", "")).toEqual({
			kind: "set_agent_model",
			data: {
				purpose: "observer.metacognitive",
				model: undefined,
			},
		});
	});
});

describe("ProviderEditor helpers", () => {
	test("builds create and edit provider commands", () => {
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
			}),
		).toEqual({
			kind: "create_provider",
			data: {
				kind: "openrouter",
				label: "OpenRouter",
				nonSecretHeaders: {
					"HTTP-Referer": "https://sprout.local",
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
				nonSecretHeaders: [],
			}),
		).toEqual({
			label: "Label is required.",
			baseUrl: "Base URL is required.",
		});

		expect(
			validateProviderDraftForSave({
				kind: "anthropic",
				label: "Anthropic",
				nonSecretHeaders: [],
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

	test("describes pending provider actions for long-running commands", () => {
		expect(
			describePendingProviderAction(createTestProviderConnectionCommand("lmstudio")),
		).toEqual({
			providerId: "lmstudio",
			message: "Testing connection...",
		});
		expect(
			describePendingProviderAction(createRefreshProviderModelsCommand("lmstudio")),
		).toEqual({
			providerId: "lmstudio",
			message: "Refreshing models...",
		});
		expect(describePendingProviderAction(createDeleteProviderCommand("lmstudio"))).toBeUndefined();
	});
});
