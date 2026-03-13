import { describe, expect, test } from "bun:test";
import {
	createEmptySettings,
	type ProviderConfig,
	validateSproutSettings,
} from "../../src/host/settings/types.ts";
import {
	validateProviderConfig,
	validateProviderRuntimeReadiness,
} from "../../src/host/settings/validation.ts";

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "lmstudio",
		kind: "openai-compatible",
		label: "LM Studio",
		enabled: false,
		baseUrl: "http://127.0.0.1:1234/v1",
		createdAt: "2026-03-12T00:00:00.000Z",
		updatedAt: "2026-03-12T00:00:00.000Z",
		...overrides,
	};
}

describe("validateProviderConfig", () => {
	test("rejects malformed base URLs before runtime use", () => {
		const result = validateProviderConfig(
			makeProvider({
				baseUrl: "localhost:1234/v1",
			}),
		);

		expect(result.errors).toContain("Base URL must be a valid http or https URL");
		expect(result.fieldErrors).toEqual({
			baseUrl: "Base URL must be a valid http or https URL",
		});
	});

	test("rejects openrouter endpoints on openai-compatible providers", () => {
		const result = validateProviderConfig(
			makeProvider({
				label: "OpenRouter",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		);

		expect(result.errors).toContain("OpenRouter endpoints must use the OpenRouter provider kind");
		expect(result.fieldErrors).toEqual({
			baseUrl: "OpenRouter endpoints must use the OpenRouter provider kind",
		});
	});

	test("rejects custom headers for gemini providers", () => {
		const result = validateProviderConfig(
			makeProvider({
				kind: "gemini",
				baseUrl: undefined,
				nonSecretHeaders: {
					"X-Test": "value",
				},
			}),
		);

		expect(result.errors).toContain("Gemini providers do not support custom non-secret headers");
		expect(result.fieldErrors).toEqual({
			nonSecretHeaders: "Gemini providers do not support custom non-secret headers",
		});
	});

	test("rejects discovery strategy and manual models from the removed schema", () => {
		const result = validateProviderConfig({
			...makeProvider(),
			discoveryStrategy: "remote-only",
			manualModels: [{ id: "qwen2.5-coder" }],
		} as ProviderConfig & {
			discoveryStrategy: string;
			manualModels: Array<{ id: string }>;
		});

		expect(result.errors).toContain("Discovery strategy is no longer supported");
		expect(result.errors).toContain("Manual model configuration is no longer supported");
		expect(result.fieldErrors).toEqual({
			discoveryStrategy: "Discovery strategy is no longer supported",
			manualModels: "Manual model configuration is no longer supported",
		});
	});
});

describe("validateProviderRuntimeReadiness", () => {
	test("reports missing secret readiness separately from config validation", () => {
		const result = validateProviderRuntimeReadiness(
			makeProvider({
				id: "openai",
				kind: "openai",
				baseUrl: undefined,
			}),
			{
				hasSecret: false,
				secretBackendAvailable: true,
			},
		);

		expect(result.errors).toContain("API key is required");
		expect(result.fieldErrors).toEqual({
			secret: "API key is required",
		});
	});

	test("reports unavailable secret backend distinctly", () => {
		const result = validateProviderRuntimeReadiness(
			makeProvider({
				id: "openai",
				kind: "openai",
				baseUrl: undefined,
			}),
			{
				hasSecret: false,
				secretBackendAvailable: false,
			},
		);

		expect(result.errors).toContain("Secret storage backend is unavailable");
		expect(result.fieldErrors).toEqual({
			secret: "Secret storage backend is unavailable",
		});
	});
});

describe("validateSproutSettings", () => {
	test("rejects duplicate provider ids", () => {
		const settings = createEmptySettings();
		settings.providers = [
			makeProvider({
				id: "lmstudio",
				enabled: true,
			}),
			makeProvider({
				id: "lmstudio",
				kind: "openrouter",
				baseUrl: undefined,
				enabled: true,
			}),
		];

		expect(() => validateSproutSettings(settings)).toThrow("Duplicate provider id: lmstudio");
	});

	test("allows explicit default model tuples for enabled providers", () => {
		const settings = createEmptySettings();
		settings.providers = [
			makeProvider({
				id: "openrouter-main",
				kind: "openrouter",
				baseUrl: undefined,
				enabled: true,
			}),
			makeProvider({
				id: "lmstudio",
				enabled: true,
			}),
		];
		settings.defaults = {
			best: {
				providerId: "openrouter-main",
				modelId: "anthropic/claude-opus-4.1",
			},
			fast: {
				providerId: "lmstudio",
				modelId: "qwen2.5-coder",
			},
		};

		expect(() => validateSproutSettings(settings)).not.toThrow();
	});

	test("rejects default models that reference missing or disabled providers", () => {
		const settings = createEmptySettings();
		settings.providers = [
			makeProvider({
				id: "openrouter-main",
				kind: "openrouter",
				baseUrl: undefined,
				enabled: true,
			}),
			makeProvider({
				id: "lmstudio",
				enabled: false,
			}),
		];
		settings.defaults = {
			fast: {
				providerId: "lmstudio",
				modelId: "qwen2.5-coder",
			},
		};

		expect(() => validateSproutSettings(settings)).toThrow(
			"Default model 'fast' must reference an enabled provider: lmstudio",
		);
	});
});
