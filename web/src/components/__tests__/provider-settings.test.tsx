import { afterEach, describe, expect, test } from "bun:test";
import type {
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "@kernel/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createSetAgentModelCommand,
	createSetMemoryModelCommand,
	ModelsPanel,
} from "../settings/ModelsPanel.tsx";
import {
	createDeleteProviderCommand,
	createDeleteProviderSecretCommand,
	createLoginProviderOAuthCommand,
	createProviderSaveCommand,
	createRefreshProviderModelsCommand,
	createRetryProviderDeleteCommand,
	createSetProviderSecretCommand,
	createTestProviderConnectionCommand,
	createToggleProviderEnabledCommand,
	createLogoutProviderOAuthCommand,
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
				agentModelOverrides: {},
			},
		},
		settings: {
			version: 4,
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
			agentModelOverrides: {},
		},
		providers: [
			{
				providerId: "anthropic-main",
				hasSecret: true,
				credentialStatus: { kind: "api-key", present: true },
				validationErrors: ["Unsupported secret backend"],
				connectionStatus: "error",
				connectionError: "Auth failed",
				catalogStatus: "stale",
				catalogError: "Refresh required",
			},
			{
				providerId: "lmstudio",
				hasSecret: false,
				credentialStatus: { kind: "none" },
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
		agentModels: [
			{
				key: "metacognitive",
				name: "metacognitive",
				source: "tree",
				path: "metacognitive",
				description: "Observe Sprout sessions",
				defaultModel: "balanced",
				effective: {
					selection: "default",
					label: "balanced",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
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
		).toContain("Loading model settings");

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
		).toContain("Model settings are unavailable");

		expect(
			renderToStaticMarkup(
				<ProviderSettingsPanel
						settings={{
							...makeSettings(),
							settings: {
								version: 4,
								providers: [],
								defaults: {},
								memoryModels: {},
								agentModelOverrides: {},
							},
							providers: [],
							catalog: [],
							agentModels: [],
					}}
					lastResult={null}
					onCommand={() => {}}
					onClose={() => {}}
				/>,
			),
		).toContain("No providers configured");
	});

	test("renders the unified models panel and runtime warnings", () => {
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

		expect(html).toContain("Model assignments");
		expect(html).toContain("Global tiers");
		expect(html).toContain("Memory system models");
		expect(html).toContain("Agent types");
		expect(html).not.toContain("Default models");
		expect(html).not.toContain("Memory models");
		expect(html).toContain("Recovered invalid settings file to /tmp/settings.invalid.json");
	});

	test("opens directly to an initial provider when requested", () => {
		const html = renderToStaticMarkup(
			<ProviderSettingsPanel
				settings={makeSettings()}
				lastResult={null}
				onCommand={() => {}}
				onClose={() => {}}
				initialProviderId="lmstudio"
			/>,
		);

		expect(html).toContain("LM Studio");
		expect(html).toContain("Base URL");
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

	test("renders all shared provider kinds in the create dropdown", () => {
		const html = renderToStaticMarkup(
			<ProviderEditor mode="create" onCommand={() => {}} />,
		);

		expect(html).toContain('value="openai-codex"');
		expect(html).toContain("OpenAI Codex");
	});

	test("does not render generic API-key controls for OpenAI Codex providers", () => {
		const html = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={{
					id: "openai-codex",
					kind: "openai-codex",
					label: "OpenAI Codex",
					enabled: true,
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				}}
				status={{
					providerId: "openai-codex",
					hasSecret: false,
					credentialStatus: { kind: "oauth", signedIn: false },
					validationErrors: ["ChatGPT OAuth login is required for OpenAI Codex"],
					connectionStatus: "unknown",
					catalogStatus: "never-loaded",
				}}
				onCommand={() => {}}
			/>,
		);

		expect(html).not.toContain("API key or token");
		expect(html).not.toContain("Base URL");
		expect(html).not.toContain('data-action="save-secret"');
		expect(html).not.toContain('data-action="remove-secret"');
	});

	test("renders OpenAI Codex OAuth status and actions", () => {
		const signedOutHtml = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={{
					id: "openai-codex",
					kind: "openai-codex",
					label: "OpenAI Codex",
					enabled: true,
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				}}
				status={{
					providerId: "openai-codex",
					hasSecret: false,
					credentialStatus: { kind: "oauth", signedIn: false },
					validationErrors: [],
					connectionStatus: "unknown",
					catalogStatus: "never-loaded",
				}}
				onCommand={() => {}}
			/>,
		);

		expect(signedOutHtml).toContain("ChatGPT account");
		expect(signedOutHtml).toContain("Not signed in");
		expect(signedOutHtml).toContain("Login with ChatGPT");
		expect(signedOutHtml).toContain('data-action="login-provider-oauth"');

		const signedInHtml = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={{
					id: "openai-codex",
					kind: "openai-codex",
					label: "OpenAI Codex",
					enabled: true,
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				}}
				status={{
					providerId: "openai-codex",
					hasSecret: true,
					credentialStatus: {
						kind: "oauth",
						signedIn: true,
						email: "jesse@example.com",
					},
					validationErrors: [],
					connectionStatus: "ok",
					catalogStatus: "current",
				}}
				onCommand={() => {}}
			/>,
		);

		expect(signedInHtml).toContain("Signed in as jesse@example.com");
		expect(signedInHtml).toContain("Logout");
		expect(signedInHtml).toContain('data-action="logout-provider-oauth"');
		expect(signedInHtml).not.toContain("API key");
	});

	test("renders cleanup-failed OpenAI Codex recovery actions", () => {
		const html = renderToStaticMarkup(
			<ProviderEditor
				mode="edit"
				provider={{
					id: "openai-codex",
					kind: "openai-codex",
					label: "OpenAI Codex",
					enabled: false,
					disabledReason: "credential-cleanup-failed",
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				}}
				status={{
					providerId: "openai-codex",
					hasSecret: false,
					credentialStatus: { kind: "oauth", signedIn: false },
					validationErrors: [],
					connectionStatus: "unknown",
					catalogStatus: "never-loaded",
				}}
				onCommand={() => {}}
			/>,
		);

		expect(html).toContain("Retry delete");
		expect(html).toContain("Sign in again");
		expect(html).toContain('data-action="retry-provider-delete"');
		expect(html).toContain('data-action="login-provider-oauth"');
	});
});

describe("ModelsPanel", () => {
	test("renders one unified model assignment surface", () => {
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
			<ModelsPanel settings={settings} onCommand={() => {}} />,
		);

		expect(html).toContain("Model assignments");
		expect(html).toContain("Global tiers");
		expect(html).toContain("Memory system models");
		expect(html).toContain("Agent types");
		expect(html).toContain("Best");
		expect(html).toContain("Balanced");
		expect(html).toContain("Fast");
		expect(html).toContain("Memory system models");
		expect(html).toContain("Memory extraction");
		expect(html).toContain("Use default (best)");
		expect(html).toContain("Use default (balanced)");
		expect(html).toContain("Use default (fast)");
		expect(html).toContain(
			"Extracts durable project memories from collapse, learn, and bus evidence before anything is written.",
		);
		expect(html).toContain("Relationship classifier");
		expect(html).toContain(
			"Classifies candidate memory pairs as semantic links such as refines, supersedes, conflicts, or unrelated.",
		);
		expect(html).toContain("Subcortical recall");
		expect(html).toContain(
			"Runs the cheap pre-recall pass: expands the search query, extracts entity hints, and keeps pinned memories.",
		);
		expect(html).toContain("metacognitive");
		expect(html).toContain("Claude Opus 4.6");
		expect(html).toContain("Qwen 2.5 Coder");
		expect(html).toContain("SPROUT_MEMORY_SUBCORTICAL_MODEL");
		expect(html).not.toContain("Default models");
		expect(html).not.toContain("Memory models");
	});

	test("keeps default and memory env override notes visible without a loaded catalog", () => {
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
			<ModelsPanel settings={settings} onCommand={() => {}} />,
		);

		expect(html).toContain("Refresh provider models to configure assignments.");
		expect(html).toContain("Stored: anthropic-main:claude-opus-4-6");
		expect(html).toContain("Stored: anthropic-main:claude-sonnet-4-6");
		expect(html).toContain("SPROUT_DEFAULT_BEST_MODEL");
		expect(html).toContain("SPROUT_MEMORY_EXTRACTION_MODEL");
	});

	test("builds set memory model commands", () => {
		expect(
			createSetMemoryModelCommand("extraction", "anthropic-main:claude-sonnet-4-6"),
		).toEqual({
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

	test("renders agent model controls and env override notes", () => {
		const settings = makeSettings();
		settings.settings.agentModelOverrides = {
			metacognitive: {
				kind: "model",
				model: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
			},
		};
		settings.agentModels[0] = {
			...settings.agentModels[0]!,
			storedOverride: settings.settings.agentModelOverrides.metacognitive,
			runtimeOverride: {
				source: "env",
				envVar: "SPROUT_AGENT_MODEL_OVERRIDES",
				selection: {
					kind: "model",
					model: {
						providerId: "lmstudio",
						modelId: "qwen2.5-coder",
					},
				},
				displayLabel: "Qwen 2.5 Coder",
			},
			effective: {
				selection: "model",
				label: "lmstudio:qwen2.5-coder",
				model: {
					providerId: "lmstudio",
					modelId: "qwen2.5-coder",
				},
			},
		};
		settings.runtime.modelOverrides.agentModelOverrides.metacognitive = {
			source: "env",
			envVar: "SPROUT_AGENT_MODEL_OVERRIDES",
			selection: {
				kind: "model",
				model: {
					providerId: "lmstudio",
					modelId: "qwen2.5-coder",
				},
			},
			displayLabel: "Qwen 2.5 Coder",
		};

		const html = renderToStaticMarkup(
			<ModelsPanel settings={settings} onCommand={() => {}} />,
		);

		expect(html).toContain("Agent types");
		expect(html).toContain("metacognitive");
		expect(html).toContain("SPROUT_AGENT_MODEL_OVERRIDES");
		expect(html).toContain("Qwen 2.5 Coder");
	});

	test("builds set agent model commands", () => {
		expect(
			createSetAgentModelCommand(
				"metacognitive",
				"anthropic-main:claude-sonnet-4-6",
			),
		).toEqual({
			kind: "set_agent_model_override",
			data: {
				agentKey: "metacognitive",
				override: {
					kind: "model",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
			},
		});
		expect(createSetAgentModelCommand("metacognitive", "fast")).toEqual({
			kind: "set_agent_model_override",
			data: {
				agentKey: "metacognitive",
				override: { kind: "tier", tier: "fast" },
			},
		});
		expect(createSetAgentModelCommand("metacognitive", "")).toEqual({
			kind: "set_agent_model_override",
			data: {
				agentKey: "metacognitive",
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
		expect(createLoginProviderOAuthCommand("openai-codex")).toEqual({
			kind: "login_provider_oauth",
			data: {
				providerId: "openai-codex",
			},
		} satisfies SettingsCommand);
		expect(createLogoutProviderOAuthCommand("openai-codex")).toEqual({
			kind: "logout_provider_oauth",
			data: {
				providerId: "openai-codex",
			},
		} satisfies SettingsCommand);
		expect(createRetryProviderDeleteCommand("openai-codex")).toEqual({
			kind: "retry_provider_delete",
			data: {
				providerId: "openai-codex",
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
