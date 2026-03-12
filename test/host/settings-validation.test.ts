import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../../src/host/settings/types.ts";
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
		discoveryStrategy: "remote-with-manual",
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
