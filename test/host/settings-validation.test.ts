import { describe, expect, test } from "bun:test";
import {
	createEmptySettings,
	type ProviderConfig,
	validateSproutSettings,
} from "../../src/host/settings/types.ts";

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "anthropic-main",
		kind: "anthropic",
		label: "Anthropic",
		enabled: true,
		discoveryStrategy: "remote-only",
		createdAt: "2026-03-11T00:00:00.000Z",
		updatedAt: "2026-03-11T00:00:00.000Z",
		...overrides,
	};
}

describe("settings validation", () => {
	test("rejects duplicate provider ids", () => {
		const settings = createEmptySettings();
		settings.providers = [makeProvider(), makeProvider()];

		expect(() => validateSproutSettings(settings)).toThrow(/duplicate provider id/i);
	});

	test("rejects duplicate provider priority entries", () => {
		const settings = createEmptySettings();
		settings.providers = [makeProvider()];
		settings.routing.providerPriority = ["anthropic-main", "anthropic-main"];

		expect(() => validateSproutSettings(settings)).toThrow(/duplicate provider priority/i);
	});

	test("rejects enabled providers missing from provider priority", () => {
		const settings = createEmptySettings();
		settings.providers = [makeProvider(), makeProvider({ id: "openai-main", kind: "openai" })];
		settings.routing.providerPriority = ["anthropic-main"];

		expect(() => validateSproutSettings(settings)).toThrow(/missing enabled provider/i);
	});
});
