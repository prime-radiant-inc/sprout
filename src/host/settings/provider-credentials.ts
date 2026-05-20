import type { ProviderKind } from "@/shared/provider-settings";

import type { SecretStorageBackend } from "./secret-store";

export type ProviderSecretKind = "api-key" | "oauth";

export const PROVIDER_CREDENTIAL_KINDS = {
	anthropic: ["api-key"],
	openai: ["api-key"],
	"openai-codex": ["oauth"],
	"openai-compatible": ["api-key"],
	openrouter: ["api-key"],
	gemini: ["api-key"],
} as const satisfies Record<ProviderKind, readonly ProviderSecretKind[]>;

export interface ProviderCredentialRef {
	providerId: string;
	secretKind: ProviderSecretKind;
	storageBackend: SecretStorageBackend;
	storageKey: string;
}

export function getProviderCredentialKinds(kind: ProviderKind): readonly ProviderSecretKind[] {
	return PROVIDER_CREDENTIAL_KINDS[kind];
}

export function createProviderCredentialRef(
	providerId: string,
	secretKind: ProviderSecretKind,
	storageBackend: SecretStorageBackend,
): ProviderCredentialRef {
	assertSafeProviderId(providerId);

	return {
		providerId,
		secretKind,
		storageBackend,
		storageKey: `sprout/providers/${providerId}/${secretKind}`,
	};
}

export function assertSafeProviderId(providerId: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(providerId)) {
		throw new Error(`Unsafe provider id for credential storage: ${providerId}`);
	}
}
