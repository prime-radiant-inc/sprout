import { describe, expect, test } from "bun:test";
import {
	type LoginWithCodeInput,
	OpenAICodexOAuthService,
} from "@/host/openai-codex-oauth/service";
import type { TokenResponse } from "@/host/openai-codex-oauth/tokens";
import { createProviderCredentialRef } from "@/host/settings/provider-credentials";
import type { SecretStorageBackend, SecretStore } from "@/host/settings/secret-store";

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";
const NOW = Date.parse("2026-05-20T12:00:00.000Z");
const PROVIDER_ID = "openai-codex";
const SECRET_BACKEND = "memory" satisfies SecretStorageBackend;
const LOGIN_INPUT = {
	providerId: PROVIDER_ID,
	code: "code",
	codeVerifier: "verifier",
	redirectUri: "http://localhost:1455/auth/callback",
} satisfies LoginWithCodeInput;

class TestSecretStore implements SecretStore {
	readonly secrets = new Map<string, string>();

	constructor(private readonly options: { deleteSecret?: () => Promise<void> } = {}) {}

	async getSecret(
		ref: ReturnType<typeof createProviderCredentialRef>,
	): Promise<string | undefined> {
		return this.secrets.get(ref.storageKey);
	}

	async setSecret(
		ref: ReturnType<typeof createProviderCredentialRef>,
		value: string,
	): Promise<void> {
		this.secrets.set(ref.storageKey, value);
	}

	async deleteSecret(ref: ReturnType<typeof createProviderCredentialRef>): Promise<void> {
		await this.options.deleteSecret?.();
		this.secrets.delete(ref.storageKey);
	}

	async hasSecret(ref: ReturnType<typeof createProviderCredentialRef>): Promise<boolean> {
		return this.secrets.has(ref.storageKey);
	}
}

interface ServiceTestContext {
	secretStore: TestSecretStore;
	service: OpenAICodexOAuthService;
}

function makeOAuthService(
	options: {
		secretStore?: TestSecretStore;
		exchangeCodeForTokens?: (input: LoginWithCodeInput) => Promise<TokenResponse>;
		refreshTokens?: (input: { refreshToken: string }) => Promise<TokenResponse>;
		now?: () => number;
		refreshSkewMs?: number;
		lifecycleTimeoutMs?: number;
	} = {},
): ServiceTestContext {
	const secretStore = options.secretStore ?? new TestSecretStore();
	const service = new OpenAICodexOAuthService({
		secretStore,
		secretBackend: SECRET_BACKEND,
		exchangeCodeForTokens:
			options.exchangeCodeForTokens ??
			(async () => tokenResponseWithAccount("acct_123", { refreshToken: "refresh-token" })),
		refreshTokens:
			options.refreshTokens ??
			(async () => tokenResponseWithAccount("acct_123", { refreshToken: "refresh-token" })),
		now: options.now ?? (() => NOW),
		refreshSkewMs: options.refreshSkewMs ?? 5 * 60 * 1000,
		lifecycleTimeoutMs: options.lifecycleTimeoutMs ?? 25,
	});
	return { secretStore, service };
}

function oauthRef(providerId = PROVIDER_ID): ReturnType<typeof createProviderCredentialRef> {
	return createProviderCredentialRef(providerId, "oauth", SECRET_BACKEND);
}

async function readStoredOAuth(
	secretStore: TestSecretStore,
	providerId = PROVIDER_ID,
): Promise<any> {
	const value = await secretStore.getSecret(oauthRef(providerId));
	return value === undefined ? undefined : JSON.parse(value);
}

async function writeStoredOAuth(
	secretStore: TestSecretStore,
	record: Record<string, unknown>,
	providerId = PROVIDER_ID,
): Promise<void> {
	await secretStore.setSecret(oauthRef(providerId), JSON.stringify(record));
}

function validOAuthRecord(
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_123" }),
		refreshToken: "refresh-token",
		expiresAt: "2026-05-20T12:10:00.000Z",
		accountId: "acct_123",
		updatedAt: "2026-05-20T11:59:00.000Z",
		...overrides,
	};
}

function expiredOAuthRecord(refreshToken: string): Record<string, unknown> {
	return validOAuthRecord({
		accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_old" }),
		refreshToken,
		expiresAt: "2026-05-20T11:59:00.000Z",
		accountId: "acct_123",
	});
}

function tokenResponseWithAccount(
	accountId: string,
	overrides: Partial<TokenResponse> = {},
): TokenResponse {
	return {
		accessToken: jwt({ [ACCOUNT_ID_CLAIM]: accountId }),
		refreshToken: "refresh-token",
		expiresAt: "2026-05-20T12:05:00.000Z",
		...overrides,
	};
}

function tokenResponseWithoutAccount(overrides: Partial<TokenResponse> = {}): TokenResponse {
	return {
		accessToken: jwt({}),
		expiresAt: "2026-05-20T12:05:00.000Z",
		...overrides,
	};
}

function base64UrlEncode(value: string): string {
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function jwt(payload: Record<string, unknown>): string {
	return `header.${base64UrlEncode(JSON.stringify(payload))}.signature`;
}

describe("OpenAICodexOAuthService", () => {
	test("persists initial credentials only after account id extraction succeeds", async () => {
		const { secretStore, service } = makeOAuthService({
			exchangeCodeForTokens: async () =>
				tokenResponseWithAccount("acct_123", { refreshToken: "refresh-token" }),
		});

		await service.loginWithCode(LOGIN_INPUT);

		expect(await readStoredOAuth(secretStore)).toMatchObject({
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_123" }),
			refreshToken: "refresh-token",
			accountId: "acct_123",
			expiresAt: "2026-05-20T12:05:00.000Z",
			updatedAt: "2026-05-20T12:00:00.000Z",
		});

		const failing = makeOAuthService({
			exchangeCodeForTokens: async () =>
				tokenResponseWithoutAccount({ refreshToken: "refresh-token" }),
		});
		await expect(failing.service.loginWithCode(LOGIN_INPUT)).rejects.toThrow("sign in again");
		expect(await readStoredOAuth(failing.secretStore)).toBeUndefined();
	});

	test("coalesces concurrent refresh and persists rotated refresh token once", async () => {
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => {
				refreshCalls += 1;
				return tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" });
			},
		});
		let refreshCalls = 0;
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		const [first, second] = await Promise.all([
			service.resolveCredentials(PROVIDER_ID),
			service.resolveCredentials(PROVIDER_ID),
		]);

		expect(first).toEqual({
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_123" }),
			accountId: "acct_123",
			expiresAt: "2026-05-20T12:05:00.000Z",
		});
		expect(second).toEqual(first);
		expect(refreshCalls).toBe(1);
		expect(await readStoredOAuth(secretStore)).toMatchObject({
			refreshToken: "new-refresh",
			updatedAt: "2026-05-20T12:00:00.000Z",
		});
	});

	test("preserves existing refresh token when refresh omits one", async () => {
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => tokenResponseWithAccount("acct_123", { refreshToken: undefined }),
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		await service.resolveCredentials(PROVIDER_ID);

		expect(await readStoredOAuth(secretStore)).toMatchObject({
			refreshToken: "old-refresh",
			accountId: "acct_123",
		});
	});

	test("refresh failure clears singleflight and leaves stored record unchanged", async () => {
		let refreshCalls = 0;
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => {
				refreshCalls += 1;
				throw new Error("token endpoint down");
			},
		});
		const originalRecord = expiredOAuthRecord("old-refresh");
		await writeStoredOAuth(secretStore, originalRecord);

		await expect(
			Promise.all([
				service.resolveCredentials(PROVIDER_ID),
				service.resolveCredentials(PROVIDER_ID),
			]),
		).rejects.toThrow("token endpoint down");
		expect(await readStoredOAuth(secretStore)).toEqual(originalRecord);

		await expect(service.resolveCredentials(PROVIDER_ID)).rejects.toThrow("token endpoint down");
		expect(refreshCalls).toBe(2);
		expect(await readStoredOAuth(secretStore)).toEqual(originalRecord);
	});

	test("refresh can fall back to stored account id when refreshed tokens omit account claims", async () => {
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => tokenResponseWithoutAccount({ refreshToken: "new-refresh" }),
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		const credentials = await service.resolveCredentials(PROVIDER_ID);

		expect(credentials.accountId).toBe("acct_123");
		expect(await readStoredOAuth(secretStore)).toMatchObject({
			accountId: "acct_123",
			refreshToken: "new-refresh",
		});
	});

	test("logout waits for refresh and deletes the refreshed credentials", async () => {
		let finishRefresh: (() => void) | undefined;
		let refreshEntered: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			refreshEntered = resolve;
		});
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => {
				refreshEntered?.();
				await new Promise<void>((finish) => {
					finishRefresh = finish;
				});
				return tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" });
			},
			lifecycleTimeoutMs: 100,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		const refresh = service.resolveCredentials(PROVIDER_ID);
		await refreshStarted;
		const logout = service.logout(PROVIDER_ID);
		finishRefresh?.();

		await expect(refresh).resolves.toMatchObject({ accountId: "acct_123" });
		await logout;
		expect(await readStoredOAuth(secretStore)).toBeUndefined();
	});

	test("delete failure returns failed oauth ref and leaves credentials present", async () => {
		const secretStore = new TestSecretStore({
			deleteSecret: async () => {
				throw new Error("backend");
			},
		});
		const { service } = makeOAuthService({ secretStore });
		await writeStoredOAuth(secretStore, validOAuthRecord());

		await expect(service.deleteCredentials(PROVIDER_ID)).resolves.toEqual({
			ok: false,
			failedRefs: ["oauth"],
		});
		expect(await readStoredOAuth(secretStore)).toBeDefined();
	});

	test("stuck refresh wait times out without deleting credentials", async () => {
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => new Promise<TokenResponse>(() => {}),
			lifecycleTimeoutMs: 1,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		void service.resolveCredentials(PROVIDER_ID);

		await expect(service.logout(PROVIDER_ID)).rejects.toThrow("credential operation timed out");
		expect(await readStoredOAuth(secretStore)).toBeDefined();
	});

	test("corrupt stored JSON and missing fields ask user to sign in again without overwriting", async () => {
		const { secretStore, service } = makeOAuthService();
		await secretStore.setSecret(oauthRef(), "{not-json");

		await expect(service.resolveCredentials(PROVIDER_ID)).rejects.toThrow("sign in again");
		expect(await secretStore.getSecret(oauthRef())).toBe("{not-json");

		await writeStoredOAuth(secretStore, {
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_123" }),
			refreshToken: "refresh-token",
			expiresAt: "2026-05-20T12:10:00.000Z",
		});

		await expect(service.resolveCredentials(PROVIDER_ID)).rejects.toThrow("sign in again");
		expect(await readStoredOAuth(secretStore)).toEqual({
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_123" }),
			refreshToken: "refresh-token",
			expiresAt: "2026-05-20T12:10:00.000Z",
		});
	});
});
