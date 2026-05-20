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

	constructor(
		private readonly options: {
			deleteSecret?: () => Promise<void>;
			hasSecret?: (ref: ReturnType<typeof createProviderCredentialRef>) => Promise<boolean>;
			getSecretAfterRead?: (
				ref: ReturnType<typeof createProviderCredentialRef>,
				value: string | undefined,
			) => Promise<void>;
			setSecretBeforeWrite?: (
				ref: ReturnType<typeof createProviderCredentialRef>,
				value: string,
			) => Promise<void>;
		} = {},
	) {}

	async getSecret(
		ref: ReturnType<typeof createProviderCredentialRef>,
	): Promise<string | undefined> {
		const value = this.secrets.get(ref.storageKey);
		await this.options.getSecretAfterRead?.(ref, value);
		return value;
	}

	async setSecret(
		ref: ReturnType<typeof createProviderCredentialRef>,
		value: string,
	): Promise<void> {
		await this.options.setSecretBeforeWrite?.(ref, value);
		this.secrets.set(ref.storageKey, value);
	}

	async deleteSecret(ref: ReturnType<typeof createProviderCredentialRef>): Promise<void> {
		await this.options.deleteSecret?.();
		this.secrets.delete(ref.storageKey);
	}

	async hasSecret(ref: ReturnType<typeof createProviderCredentialRef>): Promise<boolean> {
		if (this.options.hasSecret !== undefined) {
			return this.options.hasSecret(ref);
		}
		return this.secrets.has(ref.storageKey);
	}
}

interface LifecycleDiagnostic {
	active: boolean;
	waiters: number;
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return {
		promise,
		resolve: () => resolve?.(),
	};
}

async function rejectionMessageWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<string> {
	try {
		await withTestTimeout(promise, timeoutMs);
		return "resolved";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function settlementWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<"settled" | "timeout"> {
	try {
		await withTestTimeout(
			promise.then(
				() => undefined,
				() => undefined,
			),
			timeoutMs,
		);
		return "settled";
	} catch {
		return "timeout";
	}
}

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error("test timed out waiting for promise")),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
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

	test("returns valid stored credentials outside the refresh skew without refreshing", async () => {
		let refreshCalls = 0;
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => {
				refreshCalls += 1;
				return tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" });
			},
		});
		const storedRecord = validOAuthRecord({
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_valid" }),
			refreshToken: "valid-refresh",
			expiresAt: "2026-05-20T12:10:01.000Z",
			accountId: "acct_valid",
		});
		await writeStoredOAuth(secretStore, storedRecord);

		await expect(service.resolveCredentials(PROVIDER_ID)).resolves.toEqual({
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_valid" }),
			accountId: "acct_valid",
			expiresAt: "2026-05-20T12:10:01.000Z",
		});
		expect(refreshCalls).toBe(0);
		expect(await readStoredOAuth(secretStore)).toEqual(storedRecord);
	});

	test("refreshes credentials expiring exactly at the skew boundary", async () => {
		let refreshCalls = 0;
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => {
				refreshCalls += 1;
				return tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" });
			},
		});
		await writeStoredOAuth(
			secretStore,
			validOAuthRecord({
				expiresAt: "2026-05-20T12:05:00.000Z",
				refreshToken: "old-refresh",
			}),
		);

		await expect(service.resolveCredentials(PROVIDER_ID)).resolves.toMatchObject({
			accountId: "acct_123",
			expiresAt: "2026-05-20T12:05:00.000Z",
		});
		expect(refreshCalls).toBe(1);
		expect(await readStoredOAuth(secretStore)).toMatchObject({
			refreshToken: "new-refresh",
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

	test("stale refresh result returns newer usable stored credentials without overwriting", async () => {
		let finishRefresh: (() => void) | undefined;
		const refreshStarted = deferred();
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => {
				refreshStarted.resolve();
				await new Promise<void>((resolve) => {
					finishRefresh = resolve;
				});
				return tokenResponseWithAccount("acct_old", { refreshToken: "stale-refresh" });
			},
			lifecycleTimeoutMs: 100,
		});
		const sourceRecord = expiredOAuthRecord("old-refresh");
		const newerRecord = validOAuthRecord({
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_new" }),
			refreshToken: "newer-refresh",
			expiresAt: "2026-05-20T12:30:00.000Z",
			accountId: "acct_new",
			updatedAt: "2026-05-20T12:01:00.000Z",
		});
		await writeStoredOAuth(secretStore, sourceRecord);

		const refresh = service.resolveCredentials(PROVIDER_ID);
		await refreshStarted.promise;
		await writeStoredOAuth(secretStore, newerRecord);
		finishRefresh?.();

		await expect(refresh).resolves.toEqual({
			accessToken: jwt({ [ACCOUNT_ID_CLAIM]: "acct_new" }),
			accountId: "acct_new",
			expiresAt: "2026-05-20T12:30:00.000Z",
		});
		expect(await readStoredOAuth(secretStore)).toEqual(newerRecord);
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

	test("logout waits when resolve has read expired credentials but has not registered refresh", async () => {
		const getSecretReturned = deferred();
		const resumeGetSecret = deferred();
		let blockedGetSecret = false;
		const secretStore = new TestSecretStore({
			getSecretAfterRead: async () => {
				if (blockedGetSecret) {
					return;
				}
				blockedGetSecret = true;
				getSecretReturned.resolve();
				await resumeGetSecret.promise;
			},
		});
		const { service } = makeOAuthService({
			secretStore,
			refreshTokens: async () =>
				tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" }),
			lifecycleTimeoutMs: 100,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		const refresh = service.resolveCredentials(PROVIDER_ID);
		await getSecretReturned.promise;
		const logout = service.logout(PROVIDER_ID);
		resumeGetSecret.resolve();

		await expect(refresh).resolves.toMatchObject({ accountId: "acct_123" });
		await logout;
		expect(await readStoredOAuth(secretStore)).toBeUndefined();
	});

	test("delete waits when resolve has read expired credentials but has not registered refresh", async () => {
		const getSecretReturned = deferred();
		const resumeGetSecret = deferred();
		let blockedGetSecret = false;
		const secretStore = new TestSecretStore({
			getSecretAfterRead: async () => {
				if (blockedGetSecret) {
					return;
				}
				blockedGetSecret = true;
				getSecretReturned.resolve();
				await resumeGetSecret.promise;
			},
		});
		const { service } = makeOAuthService({
			secretStore,
			refreshTokens: async () =>
				tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" }),
			lifecycleTimeoutMs: 100,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		const refresh = service.resolveCredentials(PROVIDER_ID);
		await getSecretReturned.promise;
		const deletion = service.deleteCredentials(PROVIDER_ID);
		resumeGetSecret.resolve();

		await expect(refresh).resolves.toMatchObject({ accountId: "acct_123" });
		await expect(deletion).resolves.toEqual({ ok: true, failedRefs: [] });
		expect(await readStoredOAuth(secretStore)).toBeUndefined();
	});

	test("timed out lifecycle waiter does not let later delete bypass active resolve", async () => {
		const getSecretReturned = deferred();
		const resumeGetSecret = deferred();
		let blockedGetSecret = false;
		const secretStore = new TestSecretStore({
			getSecretAfterRead: async () => {
				if (blockedGetSecret) {
					return;
				}
				blockedGetSecret = true;
				getSecretReturned.resolve();
				await resumeGetSecret.promise;
			},
		});
		const { service } = makeOAuthService({
			secretStore,
			refreshTokens: async () =>
				tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" }),
			lifecycleTimeoutMs: 5,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		const refresh = service.resolveCredentials(PROVIDER_ID);
		await getSecretReturned.promise;
		await expect(service.logout(PROVIDER_ID)).rejects.toThrow("credential operation timed out");
		const deletion = service.deleteCredentials(PROVIDER_ID);
		resumeGetSecret.resolve();

		await expect(refresh).resolves.toMatchObject({ accountId: "acct_123" });
		await expect(deletion).resolves.toEqual({ ok: true, failedRefs: [] });
		expect(await readStoredOAuth(secretStore)).toBeUndefined();
	});

	test("hung refresh times out and clears singleflight so later resolve can retry", async () => {
		let refreshCalls = 0;
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => {
				refreshCalls += 1;
				if (refreshCalls === 1) {
					return new Promise<TokenResponse>(() => {});
				}
				return tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" });
			},
			lifecycleTimeoutMs: 5,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		await expect(rejectionMessageWithin(service.resolveCredentials(PROVIDER_ID), 25)).resolves.toBe(
			"credential operation timed out",
		);
		await expect(
			withTestTimeout(service.resolveCredentials(PROVIDER_ID), 25),
		).resolves.toMatchObject({
			accountId: "acct_123",
		});
		expect(refreshCalls).toBe(2);
		expect(await readStoredOAuth(secretStore)).toMatchObject({
			refreshToken: "new-refresh",
		});
	});

	test("login waits for active delete before writing credentials", async () => {
		const deleteEntered = deferred();
		const releaseDelete = deferred();
		const loginWriteAttempted = deferred();
		let observeLoginWrites = false;
		const secretStore = new TestSecretStore({
			deleteSecret: async () => {
				deleteEntered.resolve();
				await releaseDelete.promise;
			},
			setSecretBeforeWrite: async (_ref, value) => {
				if (observeLoginWrites && value.includes("acct_login")) {
					loginWriteAttempted.resolve();
				}
			},
		});
		const { service } = makeOAuthService({
			secretStore,
			exchangeCodeForTokens: async () =>
				tokenResponseWithAccount("acct_login", { refreshToken: "login-refresh" }),
			lifecycleTimeoutMs: 100,
		});
		await writeStoredOAuth(secretStore, validOAuthRecord());

		observeLoginWrites = true;
		const deletion = service.deleteCredentials(PROVIDER_ID);
		await deleteEntered.promise;
		const login = service.loginWithCode(LOGIN_INPUT);

		await expect(settlementWithin(loginWriteAttempted.promise, 5)).resolves.toBe("timeout");
		releaseDelete.resolve();

		await expect(deletion).resolves.toEqual({ ok: true, failedRefs: [] });
		await login;
		expect(await readStoredOAuth(secretStore)).toMatchObject({
			accountId: "acct_login",
			refreshToken: "login-refresh",
		});
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

	test("delete treats missing secret after delete failure as success", async () => {
		const secretStore = new TestSecretStore({
			deleteSecret: async () => {
				throw new Error("missing secret");
			},
			hasSecret: async () => false,
		});
		const { service } = makeOAuthService({ secretStore });
		await writeStoredOAuth(secretStore, validOAuthRecord());

		await expect(service.deleteCredentials(PROVIDER_ID)).resolves.toEqual({
			ok: true,
			failedRefs: [],
		});
	});

	test("delete reports failed oauth ref when delete fails and secret remains", async () => {
		const secretStore = new TestSecretStore({
			deleteSecret: async () => {
				throw new Error("backend");
			},
			hasSecret: async () => true,
		});
		const { service } = makeOAuthService({ secretStore });
		await writeStoredOAuth(secretStore, validOAuthRecord());

		await expect(service.deleteCredentials(PROVIDER_ID)).resolves.toEqual({
			ok: false,
			failedRefs: ["oauth"],
		});
	});

	test("timed out lifecycle waiters are removed without bypassing active operation", async () => {
		const getSecretReturned = deferred();
		let blockedGetSecret = false;
		const secretStore = new TestSecretStore({
			getSecretAfterRead: async () => {
				if (blockedGetSecret) {
					return;
				}
				blockedGetSecret = true;
				getSecretReturned.resolve();
				await new Promise<void>(() => {});
			},
		});
		const { service } = makeOAuthService({
			secretStore,
			lifecycleTimeoutMs: 2,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		void service.resolveCredentials(PROVIDER_ID).catch(() => undefined);
		await getSecretReturned.promise;
		for (let index = 0; index < 3; index += 1) {
			await expect(service.logout(PROVIDER_ID)).rejects.toThrow("credential operation timed out");
		}

		const diagnostic = (
			service as unknown as {
				getLifecycleDiagnosticForTest(providerId: string): LifecycleDiagnostic | undefined;
			}
		).getLifecycleDiagnosticForTest(PROVIDER_ID);
		expect(diagnostic).toEqual({ active: true, waiters: 0 });
		expect(await readStoredOAuth(secretStore)).toBeDefined();
	});

	test("stuck refresh wait times out without deleting credentials", async () => {
		const { secretStore, service } = makeOAuthService({
			refreshTokens: async () => new Promise<TokenResponse>(() => {}),
			lifecycleTimeoutMs: 1,
		});
		await writeStoredOAuth(secretStore, expiredOAuthRecord("old-refresh"));

		const refresh = service.resolveCredentials(PROVIDER_ID);
		const refreshError = refresh.catch((error) => error);

		await expect(service.logout(PROVIDER_ID)).rejects.toThrow("credential operation timed out");
		await expect(refreshError).resolves.toBeInstanceOf(Error);
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

		await writeStoredOAuth(secretStore, validOAuthRecord({ version: 2 }));

		await expect(service.resolveCredentials(PROVIDER_ID)).rejects.toThrow("sign in again");
		expect(await readStoredOAuth(secretStore)).toMatchObject({ version: 2 });
	});
});
