import { describe, expect, test } from "bun:test";
import {
	createProviderCredentialRef,
	getProviderCredentialKinds,
	PROVIDER_CREDENTIAL_KINDS,
} from "@/host/settings/provider-credentials";
import type { ProviderKind } from "@/shared/provider-settings";

describe("provider credential declarations", () => {
	test("declares credential kinds for every provider kind", () => {
		const providerKinds: ProviderKind[] = [
			"anthropic",
			"openai",
			"openai-codex",
			"openai-compatible",
			"openrouter",
			"gemini",
		];

		expect(Object.keys(PROVIDER_CREDENTIAL_KINDS).sort()).toEqual([...providerKinds].sort());
	});

	test("uses oauth credentials for OpenAI Codex providers", () => {
		expect(getProviderCredentialKinds("openai-codex")).toEqual(["oauth"]);
	});

	test("uses api key credentials for OpenAI providers", () => {
		expect(getProviderCredentialKinds("openai")).toEqual(["api-key"]);
	});

	test("creates provider credential refs with stable storage keys", () => {
		expect(createProviderCredentialRef("openai-codex", "oauth", "memory")).toEqual({
			providerId: "openai-codex",
			secretKind: "oauth",
			storageBackend: "memory",
			storageKey: "sprout/providers/openai-codex/oauth",
		});
	});

	test("rejects unsafe provider ids for storage keys", () => {
		expect(() => createProviderCredentialRef("../bad", "oauth", "memory")).toThrow(
			"Unsafe provider id",
		);
	});
});
