import {
	getProviderCredentialKinds,
	PROVIDER_CREDENTIAL_KINDS,
	type ProviderKind,
	type ProviderSecretKind,
	providerSupportsSecretKind,
} from "../../shared/provider-settings.ts";

import type { SecretStorageBackend } from "./secret-store";

export {
	getProviderCredentialKinds,
	PROVIDER_CREDENTIAL_KINDS,
	providerSupportsSecretKind,
	type ProviderSecretKind,
};

export interface ProviderCredentialRef<SecretKind extends ProviderSecretKind = ProviderSecretKind> {
	providerId: string;
	secretKind: SecretKind;
	storageBackend: SecretStorageBackend;
	storageKey: string;
}

export function createProviderCredentialRefsForKind(
	providerId: string,
	providerKind: ProviderKind,
	storageBackend: SecretStorageBackend,
): ProviderCredentialRef[] {
	return getProviderCredentialKinds(providerKind).map((secretKind) =>
		createProviderCredentialRef(providerId, secretKind, storageBackend),
	);
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
