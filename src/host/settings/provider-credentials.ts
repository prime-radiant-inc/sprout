import type { ProviderKind } from "../../shared/provider-settings.ts";

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

export interface ProviderCredentialRef<SecretKind extends ProviderSecretKind = ProviderSecretKind> {
	providerId: string;
	secretKind: SecretKind;
	storageBackend: SecretStorageBackend;
	storageKey: string;
}

export function getProviderCredentialKinds(kind: ProviderKind): readonly ProviderSecretKind[] {
	return PROVIDER_CREDENTIAL_KINDS[kind];
}

export function providerSupportsSecretKind(
	kind: ProviderKind,
	secretKind: ProviderSecretKind,
): boolean {
	return getProviderCredentialKinds(kind).includes(secretKind);
}

export function createProviderCredentialRefForKind(
	providerId: string,
	providerKind: ProviderKind,
	storageBackend: SecretStorageBackend,
): ProviderCredentialRef | undefined {
	const [secretKind] = getProviderCredentialKinds(providerKind);
	if (!secretKind) return undefined;
	return createProviderCredentialRef(providerId, secretKind, storageBackend);
}

export function createProviderCredentialRef(
	providerId: string,
	secretKind: "api-key",
	storageBackend: SecretStorageBackend,
): ProviderCredentialRef<"api-key">;
export function createProviderCredentialRef(
	providerId: string,
	secretKind: "oauth",
	storageBackend: SecretStorageBackend,
): ProviderCredentialRef<"oauth">;
export function createProviderCredentialRef(
	providerId: string,
	secretKind: ProviderSecretKind,
	storageBackend: SecretStorageBackend,
): ProviderCredentialRef<ProviderSecretKind>;
export function createProviderCredentialRef(
	providerId: string,
	secretKind: ProviderSecretKind,
	storageBackend: SecretStorageBackend,
): ProviderCredentialRef<ProviderSecretKind> {
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
