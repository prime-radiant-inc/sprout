import {
	createProviderCredentialRef,
	type ProviderSecretKind,
} from "../settings/provider-credentials";
import type { SecretStorageBackend, SecretStore } from "../settings/secret-store";
import { extractChatGPTAccountId } from "./claims";
import { exchangeCodeForTokens, refreshTokens, type TokenResponse } from "./tokens";

const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30_000;
const SIGN_IN_AGAIN_ERROR = "OpenAI Codex OAuth credentials are invalid; please sign in again";
const OPERATION_TIMED_OUT_ERROR = "credential operation timed out";

export interface OpenAICodexRuntimeCredentials {
	accessToken: string;
	accountId: string;
	expiresAt: string;
}

export interface LoginWithCodeInput {
	providerId: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}

export interface CredentialDeleteResult {
	ok: boolean;
	failedRefs: ProviderSecretKind[];
}

interface OpenAICodexOAuthRecord {
	accessToken: string;
	refreshToken: string;
	expiresAt: string;
	accountId: string;
	idToken?: string;
	updatedAt: string;
}

interface OpenAICodexOAuthServiceOptions {
	secretStore: SecretStore;
	secretBackend: SecretStorageBackend;
	exchangeCodeForTokens?: (input: LoginWithCodeInput) => Promise<TokenResponse>;
	refreshTokens?: (input: { refreshToken: string }) => Promise<TokenResponse>;
	now?: () => number;
	refreshSkewMs?: number;
	lifecycleTimeoutMs?: number;
}

interface RefreshState {
	promise: Promise<OpenAICodexRuntimeCredentials>;
	waiters: number;
	settled: boolean;
}

export class OpenAICodexOAuthService {
	private readonly secretStore: SecretStore;
	private readonly secretBackend: SecretStorageBackend;
	private readonly exchangeCodeForTokensImpl: (input: LoginWithCodeInput) => Promise<TokenResponse>;
	private readonly refreshTokensImpl: (input: { refreshToken: string }) => Promise<TokenResponse>;
	private readonly now: () => number;
	private readonly refreshSkewMs: number;
	private readonly lifecycleTimeoutMs: number;
	private readonly refreshes = new Map<string, RefreshState>();
	private readonly lifecycleTails = new Map<string, Promise<void>>();

	constructor(options: OpenAICodexOAuthServiceOptions) {
		this.secretStore = options.secretStore;
		this.secretBackend = options.secretBackend;
		this.exchangeCodeForTokensImpl = options.exchangeCodeForTokens ?? exchangeCodeForTokens;
		this.refreshTokensImpl = options.refreshTokens ?? refreshTokens;
		this.now = options.now ?? Date.now;
		this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
		this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
	}

	async resolveCredentials(providerId: string): Promise<OpenAICodexRuntimeCredentials> {
		const { credentials, refreshState } = await this.withLifecycle(providerId, async () => {
			const existing = this.refreshes.get(providerId);
			if (existing !== undefined) {
				existing.waiters += 1;
				return { credentials: existing.promise, refreshState: existing };
			}

			const stored = await this.readStoredRecord(providerId);
			if (!this.shouldRefresh(stored)) {
				return { credentials: toRuntimeCredentials(stored) };
			}

			const refresh = this.refreshStoredCredentials(providerId, stored);
			const refreshState: RefreshState = {
				promise: refresh,
				waiters: 1,
				settled: false,
			};
			this.refreshes.set(providerId, refreshState);
			this.markRefreshSettled(providerId, refreshState);
			return { credentials: refresh, refreshState };
		});
		try {
			return await credentials;
		} finally {
			if (refreshState !== undefined) {
				this.releaseRefreshWaiter(providerId, refreshState);
			}
		}
	}

	async loginWithCode(input: LoginWithCodeInput): Promise<void> {
		const tokenResponse = await this.exchangeCodeForTokensImpl(input);
		const refreshToken = requireTokenField(tokenResponse.refreshToken);
		const accountId = extractAccountIdOrSignInAgain(tokenResponse);
		assertUsableExpiry(tokenResponse.expiresAt, this.now());
		const record = buildOAuthRecord({
			tokenResponse,
			refreshToken,
			accountId,
			updatedAt: this.currentIsoTimestamp(),
		});
		await this.secretStore.setSecret(this.oauthRef(input.providerId), JSON.stringify(record));
	}

	async logout(providerId: string): Promise<void> {
		await this.withLifecycle(providerId, async () => {
			await this.waitForRefresh(providerId);
			await this.secretStore.deleteSecret(this.oauthRef(providerId));
		});
	}

	async deleteCredentials(providerId: string): Promise<CredentialDeleteResult> {
		return this.withLifecycle(providerId, async () => {
			await this.waitForRefresh(providerId);
			try {
				await this.secretStore.deleteSecret(this.oauthRef(providerId));
				return { ok: true, failedRefs: [] };
			} catch {
				return { ok: false, failedRefs: ["oauth"] };
			}
		});
	}

	private async refreshStoredCredentials(
		providerId: string,
		stored: OpenAICodexOAuthRecord,
	): Promise<OpenAICodexRuntimeCredentials> {
		const tokenResponse = await this.refreshTokensImpl({ refreshToken: stored.refreshToken });
		const refreshToken = tokenResponse.refreshToken ?? stored.refreshToken;
		const accountId = extractAccountIdOrSignInAgain(tokenResponse, stored.accountId);
		assertUsableExpiry(tokenResponse.expiresAt, this.now());
		const record = buildOAuthRecord({
			tokenResponse,
			refreshToken,
			accountId,
			updatedAt: this.currentIsoTimestamp(),
		});
		await this.secretStore.setSecret(this.oauthRef(providerId), JSON.stringify(record));
		return toRuntimeCredentials(record);
	}

	private async readStoredRecord(providerId: string): Promise<OpenAICodexOAuthRecord> {
		const value = await this.secretStore.getSecret(this.oauthRef(providerId));
		if (value === undefined) {
			throw new Error(SIGN_IN_AGAIN_ERROR);
		}
		return parseStoredRecord(value);
	}

	private shouldRefresh(record: OpenAICodexOAuthRecord): boolean {
		const expiresAt = parseDateMs(record.expiresAt);
		if (expiresAt === undefined) {
			throw new Error(SIGN_IN_AGAIN_ERROR);
		}
		return expiresAt <= this.now() + this.refreshSkewMs;
	}

	private async waitForRefresh(providerId: string): Promise<void> {
		const refresh = this.refreshes.get(providerId);
		if (refresh === undefined) {
			return;
		}
		await withTimeout(
			refresh.promise.then(
				() => undefined,
				() => undefined,
			),
			this.lifecycleTimeoutMs,
		);
	}

	private markRefreshSettled(providerId: string, refreshState: RefreshState): void {
		void refreshState.promise.then(
			() => {
				refreshState.settled = true;
				this.clearRefreshIfUnused(providerId, refreshState);
			},
			() => {
				refreshState.settled = true;
				this.clearRefreshIfUnused(providerId, refreshState);
			},
		);
	}

	private releaseRefreshWaiter(providerId: string, refreshState: RefreshState): void {
		refreshState.waiters -= 1;
		this.clearRefreshIfUnused(providerId, refreshState);
	}

	private clearRefreshIfUnused(providerId: string, refreshState: RefreshState): void {
		if (!refreshState.settled || refreshState.waiters > 0) {
			return;
		}
		queueMicrotask(() => {
			if (
				refreshState.settled &&
				refreshState.waiters === 0 &&
				this.refreshes.get(providerId) === refreshState
			) {
				this.refreshes.delete(providerId);
			}
		});
	}

	private async withLifecycle<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
		const previousTail = this.lifecycleTails.get(providerId) ?? Promise.resolve();
		let releaseCurrent: (() => void) | undefined;
		const currentTail = new Promise<void>((resolve) => {
			releaseCurrent = resolve;
		});
		this.lifecycleTails.set(providerId, currentTail);

		try {
			await withTimeout(previousTail, this.lifecycleTimeoutMs);
			return await operation();
		} finally {
			releaseCurrent?.();
			if (this.lifecycleTails.get(providerId) === currentTail) {
				this.lifecycleTails.delete(providerId);
			}
		}
	}

	private oauthRef(providerId: string) {
		return createProviderCredentialRef(providerId, "oauth", this.secretBackend);
	}

	private currentIsoTimestamp(): string {
		return new Date(this.now()).toISOString();
	}
}

function parseStoredRecord(value: string): OpenAICodexOAuthRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(SIGN_IN_AGAIN_ERROR);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(SIGN_IN_AGAIN_ERROR);
	}

	const record = parsed as Record<string, unknown>;
	const accessToken = requiredString(record.accessToken);
	const refreshToken = requiredString(record.refreshToken);
	const expiresAt = requiredString(record.expiresAt);
	const accountId = requiredString(record.accountId);
	const updatedAt = requiredString(record.updatedAt);
	const idToken = optionalString(record.idToken);

	if (
		accessToken === undefined ||
		refreshToken === undefined ||
		expiresAt === undefined ||
		accountId === undefined ||
		updatedAt === undefined ||
		parseDateMs(expiresAt) === undefined ||
		parseDateMs(updatedAt) === undefined ||
		(record.idToken !== undefined && idToken === undefined)
	) {
		throw new Error(SIGN_IN_AGAIN_ERROR);
	}

	return {
		accessToken,
		refreshToken,
		expiresAt,
		accountId,
		...(idToken !== undefined ? { idToken } : {}),
		updatedAt,
	};
}

function buildOAuthRecord(input: {
	tokenResponse: TokenResponse;
	refreshToken: string;
	accountId: string;
	updatedAt: string;
}): OpenAICodexOAuthRecord {
	return {
		accessToken: input.tokenResponse.accessToken,
		refreshToken: input.refreshToken,
		expiresAt: input.tokenResponse.expiresAt,
		accountId: input.accountId,
		...(input.tokenResponse.idToken !== undefined ? { idToken: input.tokenResponse.idToken } : {}),
		updatedAt: input.updatedAt,
	};
}

function toRuntimeCredentials(record: OpenAICodexOAuthRecord): OpenAICodexRuntimeCredentials {
	return {
		accessToken: record.accessToken,
		accountId: record.accountId,
		expiresAt: record.expiresAt,
	};
}

function extractAccountIdOrSignInAgain(
	tokenResponse: TokenResponse,
	storedAccountId?: string,
): string {
	try {
		return extractChatGPTAccountId({
			accessToken: tokenResponse.accessToken,
			idToken: tokenResponse.idToken,
			storedAccountId,
		});
	} catch {
		throw new Error(SIGN_IN_AGAIN_ERROR);
	}
}

function requireTokenField(value: string | undefined): string {
	const parsed = requiredString(value);
	if (parsed === undefined) {
		throw new Error(SIGN_IN_AGAIN_ERROR);
	}
	return parsed;
}

function assertUsableExpiry(expiresAt: string, now: number): void {
	const parsed = parseDateMs(expiresAt);
	if (parsed === undefined || parsed <= now) {
		throw new Error(SIGN_IN_AGAIN_ERROR);
	}
}

function requiredString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return requiredString(value);
}

function parseDateMs(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(OPERATION_TIMED_OUT_ERROR)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}
