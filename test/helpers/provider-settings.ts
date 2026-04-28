import type {
	SessionSelectionSnapshot,
	SettingsCommandResult,
	SettingsSnapshot,
} from "../../src/kernel/types.ts";

export function makeSettingsSnapshot(): SettingsSnapshot {
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
				connectionStatus: "ok",
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
						source: "remote",
					},
				],
			},
			{
				providerId: "lmstudio",
				lastRefreshAt: "2026-03-11T00:00:00.000Z",
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

export function makeSelectionSnapshot(
	overrides: Partial<SessionSelectionSnapshot> = {},
): SessionSelectionSnapshot {
	return {
		selection: {
			kind: "model",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		},
		resolved: {
			providerId: "anthropic-main",
			modelId: "claude-sonnet-4-6",
		},
		source: "session",
		...overrides,
	};
}

export function makeSettingsErrorResult(
	message = "Validation failed",
): Extract<SettingsCommandResult, { ok: false }> {
	return {
		ok: false,
		code: "validation_error",
		message,
	};
}
