# OpenAI Codex OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OAuth-only `OpenAI Codex` provider that authenticates through ChatGPT OAuth and uses the Codex backend endpoints.

**Architecture:** Add a distinct `openai-codex` provider kind while reusing the OpenAI TypeScript SDK and shared Responses helpers. Keep OAuth credential storage, token refresh, Codex endpoint behavior, provider registry wiring, and UI controls as separate units with narrow tests.

**Tech Stack:** TypeScript, Bun test runner, OpenAI TypeScript SDK, Sprout settings control plane, OS-backed secret store abstraction, React web settings, TUI provider settings.

---

## Reference Spec

- `docs/superpowers/specs/2026-05-19-openai-codex-oauth-design.md`

## File Map

- Modify `src/shared/provider-settings.ts`
  - Add `openai-codex`.
  - Add optional `disabledReason`.
- Modify `src/host/settings/types.ts`
  - Re-export updated shared settings types.
  - Add validation coverage for disabled providers if needed.
- Create `src/host/settings/provider-credentials.ts`
  - Declare exhaustive provider-kind credential refs.
  - Build provider credential refs consistently.
- Modify `src/host/settings/secret-store.ts`
  - Support `"api-key" | "oauth"` secret kinds.
  - Add provider-id-safe storage keys.
- Create `src/host/settings/redaction.ts`
  - Central redaction helper for OAuth, secret-store, and UI/control-plane error surfaces.
- Modify `src/host/settings/validation.ts`
  - Add credential-kind-aware runtime validation.
  - Report OAuth-specific missing credential messages.
- Modify `src/host/settings/control-plane.ts`
  - Add OAuth login/logout/status command plumbing.
  - Add cleanup-failed disabled state and retry/delete behavior.
- Create `src/host/openai-codex-oauth/config.ts`
  - OAuth constants and authorize URL builder.
- Create `src/host/openai-codex-oauth/pkce.ts`
  - PKCE verifier/challenge helpers.
- Create `src/host/openai-codex-oauth/claims.ts`
  - Decode-only account-id extraction.
- Create `src/host/openai-codex-oauth/tokens.ts`
  - Token exchange and refresh.
- Create `src/host/openai-codex-oauth/callback-server.ts`
  - Loopback callback server and pasteback parser.
- Create `src/host/openai-codex-oauth/service.ts`
  - Credential lifecycle, singleflight refresh, logout/delete coordination.
- Create `src/llm/openai/responses-request.ts`
  - Shared Responses request builders extracted from `src/llm/openai.ts`.
- Create `src/llm/openai/responses-parse.ts`
  - Shared response and usage parsing.
- Create `src/llm/openai/responses-stream.ts`
  - Shared stream accumulator including Codex tool-call event ordering.
- Modify `src/llm/openai.ts`
  - Use extracted helpers without behavior change.
- Create `src/llm/openai-codex.ts`
  - `OpenAICodexAdapter` using OpenAI SDK with Codex base URL.
- Modify `src/llm/provider-registry.ts`
  - Materialize `OpenAICodexAdapter`.
  - Enforce enabled-provider and credential readiness.
- Modify `src/host/cli-bootstrap.ts` and `src/bus/agent-process.ts`
  - Wire OAuth credential service into provider registry creation.
- Modify `src/tui/provider-settings-editor.tsx`
  - Add `OpenAI Codex` kind and OAuth controls.
- Modify `web/src/components/settings/ProviderEditor.tsx`
  - Add `OpenAI Codex` kind and OAuth controls.
- Add/modify tests under `test/host`, `test/llm`, `test/tui`, and `web/src/components/__tests__`.

---

## Task 1: Provider Kind, Disabled Reason, And Credential Ref Declarations

**Files:**
- Modify: `src/shared/provider-settings.ts`
- Create: `src/host/settings/provider-credentials.ts`
- Test: `test/host/provider-credentials.test.ts`
- Test: `test/host/settings-validation.test.ts`

- [ ] **Step 1: Add failing provider credential declaration tests**

Add `test/host/provider-credentials.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
	createProviderCredentialRef,
	getProviderCredentialKinds,
	PROVIDER_CREDENTIAL_KINDS,
} from "../../src/host/settings/provider-credentials.ts";
import type { ProviderKind } from "../../src/shared/provider-settings.ts";

const providerKinds = [
	"anthropic",
	"openai",
	"openai-codex",
	"openai-compatible",
	"openrouter",
	"gemini",
] as const satisfies readonly ProviderKind[];

describe("provider credential declarations", () => {
	test("declares credential refs for every provider kind", () => {
		expect(Object.keys(PROVIDER_CREDENTIAL_KINDS).sort()).toEqual([...providerKinds].sort());
		expect(getProviderCredentialKinds("openai-codex")).toEqual(["oauth"]);
		expect(getProviderCredentialKinds("openai")).toEqual(["api-key"]);
	});

	test("builds deterministic storage keys for provider credential refs", () => {
		expect(createProviderCredentialRef("openai-codex", "oauth", "memory")).toMatchObject({
			providerId: "openai-codex",
			secretKind: "oauth",
			storageBackend: "memory",
			storageKey: "sprout/providers/openai-codex/oauth",
		});
	});

	test("rejects unsafe provider ids before composing storage keys", () => {
		expect(() => createProviderCredentialRef("../bad", "oauth", "memory")).toThrow(
			"Unsafe provider id",
		);
	});
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
bun test test/host/provider-credentials.test.ts
```

Expected: fail because `provider-credentials.ts` and `openai-codex` do not exist.

- [ ] **Step 3: Add provider kind and optional disabled reason**

In `src/shared/provider-settings.ts`, update the provider kind and config:

```ts
export type ProviderKind =
	| "anthropic"
	| "openai"
	| "openai-codex"
	| "openai-compatible"
	| "openrouter"
	| "gemini";

export interface ProviderConfig {
	id: string;
	kind: ProviderKind;
	label: string;
	enabled: boolean;
	disabledReason?: "user" | "credential-cleanup-failed";
	baseUrl?: string;
	nonSecretHeaders?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}
```

- [ ] **Step 4: Add credential declarations**

Create `src/host/settings/provider-credentials.ts`:

```ts
import type { ProviderKind } from "../../shared/provider-settings.ts";
import type { SecretStorageBackend } from "./secret-store.ts";

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
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test test/host/provider-credentials.test.ts
```

Expected: provider credential tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared/provider-settings.ts src/host/settings/provider-credentials.ts test/host/provider-credentials.test.ts
git commit -m "feat: declare provider credential refs"
```

---

## Task 2: Secret Store Supports OAuth Refs And Redaction

**Files:**
- Modify: `src/host/settings/secret-store.ts`
- Create: `src/host/settings/redaction.ts`
- Test: `test/host/secret-store.test.ts`
- Test: `test/host/redaction.test.ts`

- [ ] **Step 1: Add failing redaction tests**

Create `test/host/redaction.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { redactCredentialText } from "../../src/host/settings/redaction.ts";

describe("redactCredentialText", () => {
	test("redacts OAuth and secret-store credential material", () => {
		const input = [
			"Authorization: Bearer sk-live-secret",
			"http://localhost:1455/auth/callback?code=abc123&state=state123",
			"raw code abc123",
			"security item sprout/providers/openai-codex/oauth failed",
			"backend error token refresh_token_123",
		].join("\n");

		const redacted = redactCredentialText(input);

		expect(redacted).not.toContain("sk-live-secret");
		expect(redacted).not.toContain("abc123");
		expect(redacted).not.toContain("refresh_token_123");
		expect(redacted).not.toContain("sprout/providers/openai-codex/oauth");
		expect(redacted).toContain("[redacted]");
	});
});
```

- [ ] **Step 2: Add failing OAuth secret-store test**

Extend `test/host/secret-store.test.ts` with:

```ts
test("stores oauth provider credentials under the oauth storage key", async () => {
	const store = createSecretStore({ backend: "memory", platform: "darwin" });
	const ref = createProviderCredentialRef("openai-codex", "oauth", "memory");

	await store.setSecret(ref, JSON.stringify({ accessToken: "access" }));

	expect(await store.getSecret(ref)).toBe('{"accessToken":"access"}');
	expect(await store.hasSecret(ref)).toBe(true);
	await store.deleteSecret(ref);
	expect(await store.hasSecret(ref)).toBe(false);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
bun test test/host/redaction.test.ts test/host/secret-store.test.ts
```

Expected: fail because `redaction.ts` does not exist and `SecretStore` still expects the old ref type.

- [ ] **Step 4: Implement redaction helper**

Create `src/host/settings/redaction.ts`:

```ts
export function redactCredentialText(value: string): string {
	return value
		.replace(/Authorization:\s*Bearer\s+[^\s]+/gi, "Authorization: Bearer [redacted]")
		.replace(/([?&]code=)[^&\s]+/gi, "$1[redacted]")
		.replace(/([?&]state=)[^&\s]+/gi, "$1[redacted]")
		.replace(/sprout\/providers\/[A-Za-z0-9._-]+\/(?:api-key|oauth)/g, "[redacted]")
		.replace(/\b(?:access|refresh)?_?token_[A-Za-z0-9._-]+\b/gi, "[redacted]")
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, "[redacted]");
}
```

- [ ] **Step 5: Update secret-store types**

In `src/host/settings/secret-store.ts`, import and use `ProviderCredentialRef`:

```ts
import type { ProviderCredentialRef } from "./provider-credentials.ts";

export type ProviderSecretRef = ProviderCredentialRef;
```

Keep `createProviderSecretRef(providerId, backend)` as a compatibility wrapper:

```ts
import { createProviderCredentialRef } from "./provider-credentials.ts";

export function createProviderSecretRef(
	providerId: string,
	storageBackend: SecretStorageBackend,
): ProviderSecretRef {
	return createProviderCredentialRef(providerId, "api-key", storageBackend);
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test test/host/provider-credentials.test.ts test/host/redaction.test.ts test/host/secret-store.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/host/settings/secret-store.ts src/host/settings/redaction.ts test/host/secret-store.test.ts test/host/redaction.test.ts
git commit -m "feat: support oauth provider secrets"
```

---

## Task 3: Provider Validation And Disabled Provider Guards

**Files:**
- Modify: `src/host/settings/validation.ts`
- Modify: `src/llm/provider-registry.ts`
- Modify: `src/host/settings/control-plane.ts`
- Test: `test/host/settings-validation.test.ts`
- Test: `test/llm/provider-registry.test.ts`
- Test: `test/host/settings-control-plane.test.ts`

- [ ] **Step 1: Add validation tests for OpenAI Codex**

In `test/host/settings-validation.test.ts`, add:

```ts
test("openai-codex requires oauth credentials and rejects base URLs", () => {
	const provider = makeProvider({ kind: "openai-codex", id: "openai-codex" });

	expect(validateProviderConfig({ ...provider, baseUrl: "https://chatgpt.com" }).fieldErrors).toEqual({
		baseUrl: "Base URL is only supported for openai-compatible providers",
	});

	expect(
		validateProviderRuntimeReadiness(provider, {
			hasSecret: false,
			secretBackendAvailable: true,
		}).fieldErrors.secret,
	).toBe("ChatGPT OAuth login is required for OpenAI Codex");
});
```

- [ ] **Step 2: Add disabled provider registry test**

In `test/llm/provider-registry.test.ts`, add:

```ts
test("does not construct adapters for disabled providers", async () => {
	const registry = new ProviderRegistry({
		settings: makeSettings([
			{
				id: "openai",
				kind: "openai",
				label: "OpenAI",
				enabled: false,
				createdAt: "2026-03-11T12:00:00.000Z",
				updatedAt: "2026-03-11T12:00:00.000Z",
			},
		]),
		secretStore: createSecretStore({ backend: "memory", platform: "darwin" }),
		secretBackend: "memory",
	});

	const entry = await registry.getEntry("openai");
	expect(entry?.adapter).toBeUndefined();
	expect(entry?.validationErrors).toContain("Provider is disabled");
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
bun test test/host/settings-validation.test.ts test/llm/provider-registry.test.ts
```

Expected: fail because validation does not know OAuth credentials and registry ignores disabled state.

- [ ] **Step 4: Implement credential-aware validation**

In `src/host/settings/validation.ts`, add credential helpers:

```ts
export function providerRequiresSecret(provider: ProviderConfig): boolean {
	return provider.kind !== "openai-compatible";
}

function missingCredentialMessage(provider: ProviderConfig): string {
	return provider.kind === "openai-codex"
		? "ChatGPT OAuth login is required for OpenAI Codex"
		: "API key is required";
}
```

Update readiness validation:

```ts
if (!provider.enabled) {
	addFieldError(result.errors, result.fieldErrors, "enabled", "Provider is disabled");
	return result;
}
if (!providerRequiresSecret(provider)) {
	return result;
}
if (!options.hasSecret) {
	addFieldError(result.errors, result.fieldErrors, "secret", missingCredentialMessage(provider));
}
```

Keep `provider.kind !== "openai-compatible" && provider.baseUrl !== undefined` so `openai-codex` cannot have `baseUrl`.

- [ ] **Step 5: Update registry credential refs**

In `src/llm/provider-registry.ts`, use `getProviderCredentialKinds(provider.kind)[0]` through a helper. For this task, only the first credential kind is needed because current registry readiness checks one runtime credential.

```ts
private secretRef(provider: ProviderConfig) {
	const [secretKind] = getProviderCredentialKinds(provider.kind);
	return createProviderCredentialRef(provider.id, secretKind!, this.secretBackend);
}
```

Update call sites from `this.secretRef(provider.id)` to `this.secretRef(provider)`.

- [ ] **Step 6: Run tests**

Run:

```bash
bun test test/host/settings-validation.test.ts test/llm/provider-registry.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/host/settings/validation.ts src/llm/provider-registry.ts test/host/settings-validation.test.ts test/llm/provider-registry.test.ts
git commit -m "feat: validate oauth provider readiness"
```

---

## Task 4: OAuth URL, PKCE, Claims, And Token Helpers

**Files:**
- Create: `src/host/openai-codex-oauth/config.ts`
- Create: `src/host/openai-codex-oauth/pkce.ts`
- Create: `src/host/openai-codex-oauth/claims.ts`
- Create: `src/host/openai-codex-oauth/tokens.ts`
- Test: `test/host/openai-codex-oauth/config.test.ts`
- Test: `test/host/openai-codex-oauth/claims.test.ts`
- Test: `test/host/openai-codex-oauth/tokens.test.ts`

- [ ] **Step 1: Add OAuth config tests**

Create `test/host/openai-codex-oauth/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl, OPENAI_CODEX_OAUTH } from "../../../src/host/openai-codex-oauth/config.ts";

describe("OpenAI Codex OAuth config", () => {
	test("builds the Pi-compatible Codex authorize URL", async () => {
		const url = buildAuthorizeUrl({
			redirectUri: OPENAI_CODEX_OAUTH.primaryRedirectUri,
			state: "state-123",
			codeChallenge: "challenge-123",
		});

		expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
		expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		expect(url.searchParams.get("scope")).toBe(
			"openid profile email offline_access api.connectors.read api.connectors.invoke",
		);
		expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
		expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		expect(url.searchParams.get("originator")).toBe("pi");
		expect(url.searchParams.get("state")).toBe("state-123");
		expect(url.searchParams.get("code_challenge")).toBe("challenge-123");
	});
});
```

- [ ] **Step 2: Add claim extraction tests**

Create `test/host/openai-codex-oauth/claims.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { extractChatGPTAccountId } from "../../../src/host/openai-codex-oauth/claims.ts";

function jwt(payload: Record<string, unknown>): string {
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `header.${encoded}.signature`;
}

describe("extractChatGPTAccountId", () => {
	test("reads the ChatGPT account id from access token claims", () => {
		expect(
			extractChatGPTAccountId({
				accessToken: jwt({
					"https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
				}),
			}),
		).toBe("acct_123");
	});

	test("falls back to id token and stored account id", () => {
		expect(
			extractChatGPTAccountId({
				accessToken: jwt({}),
				idToken: jwt({
					"https://api.openai.com/auth": { chatgpt_account_id: "acct_id" },
				}),
			}),
		).toBe("acct_id");
		expect(extractChatGPTAccountId({ accessToken: jwt({}), storedAccountId: "acct_old" })).toBe(
			"acct_old",
		);
	});

	test("throws a redacted error for malformed JWTs", () => {
		expect(() => extractChatGPTAccountId({ accessToken: "not-a-jwt" })).toThrow(
			"Unable to decode OpenAI OAuth token claims",
		);
	});
});
```

- [ ] **Step 3: Implement config and claims**

Create `src/host/openai-codex-oauth/config.ts` and `claims.ts` matching the tests. Use `Buffer.from(segment, "base64url")` for decode-only JWT payload parsing.

- [ ] **Step 4: Add token exchange tests with mocked fetch**

Create `test/host/openai-codex-oauth/tokens.test.ts` with mocked `fetch` that asserts `application/x-www-form-urlencoded` body includes `client_id`, `code_verifier`, and either `code` or `refresh_token`.

- [ ] **Step 5: Implement token helpers**

Create `src/host/openai-codex-oauth/tokens.ts`:

```ts
export interface TokenResponse {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt: string;
}

export async function exchangeCodeForTokens(input: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}): Promise<TokenResponse> {
	// POST form body to OPENAI_CODEX_OAUTH.tokenUrl.
}

export async function refreshTokens(input: {
	refreshToken: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}): Promise<TokenResponse> {
	// POST refresh_token grant and preserve missing refresh token at service layer.
}
```

The implementation must parse `expires_in` into ISO `expiresAt` when present, fall back to the
access-token JWT `exp` claim when `expires_in` is omitted, and throw redacted errors.

- [ ] **Step 6: Run tests**

Run:

```bash
bun test test/host/openai-codex-oauth/config.test.ts test/host/openai-codex-oauth/claims.test.ts test/host/openai-codex-oauth/tokens.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/host/openai-codex-oauth test/host/openai-codex-oauth
git commit -m "feat: add OpenAI Codex OAuth primitives"
```

---

## Task 5: Callback Server And Pasteback Parser

**Files:**
- Create: `src/host/openai-codex-oauth/callback-server.ts`
- Test: `test/host/openai-codex-oauth/callback-server.test.ts`

- [ ] **Step 1: Add callback and pasteback tests**

Create `test/host/openai-codex-oauth/callback-server.test.ts` with tests for:

```ts
import { describe, expect, test } from "bun:test";
import {
	parseManualPasteback,
	validateCallbackRequest,
} from "../../../src/host/openai-codex-oauth/callback-server.ts";

describe("OpenAI Codex OAuth callback validation", () => {
	test("accepts only matching GET callback path and state", () => {
		expect(
			validateCallbackRequest(new Request("http://localhost:1455/auth/callback?code=c&state=s"), {
				expectedState: "s",
			}),
		).toEqual({ ok: true, code: "c" });
		expect(
			validateCallbackRequest(new Request("http://localhost:1455/wrong?code=c&state=s"), {
				expectedState: "s",
			}).ok,
		).toBe(false);
	});

	test("parses full callback pasteback with state validation", () => {
		expect(
			parseManualPasteback({
				input: "http://localhost:1455/auth/callback?code=c&state=s",
				expectedState: "s",
			}),
		).toEqual({ ok: true, code: "c" });
	});

	test("requires returned state for raw-code pasteback", () => {
		expect(parseManualPasteback({ input: "c", returnedState: "s", expectedState: "s" })).toEqual({
			ok: true,
			code: "c",
		});
		expect(parseManualPasteback({ input: "c", expectedState: "s" }).ok).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test test/host/openai-codex-oauth/callback-server.test.ts
```

Expected: fail because the module does not exist.

- [ ] **Step 3: Implement callback validation and pasteback parser**

Implement pure helpers first. Only after those pass, add `listenForCallback()` using `Bun.serve` with loopback host, primary/fallback ports, one-shot state, timeout cleanup, and no secret logging.

- [ ] **Step 4: Run tests**

Run:

```bash
bun test test/host/openai-codex-oauth/callback-server.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/host/openai-codex-oauth/callback-server.ts test/host/openai-codex-oauth/callback-server.test.ts
git commit -m "feat: add OpenAI Codex OAuth callback handling"
```

---

## Task 6: OAuth Credential Service With Refresh Singleflight

**Files:**
- Create: `src/host/openai-codex-oauth/service.ts`
- Test: `test/host/openai-codex-oauth/service.test.ts`

- [ ] **Step 1: Add service tests for initial persistence and refresh**

Create `test/host/openai-codex-oauth/service.test.ts` with tests that use memory secret store and mocked token functions:

```ts
test("persists initial credentials only after account id extraction succeeds", async () => {
	const service = makeOAuthService({
		exchangeCodeForTokens: async () => tokenResponseWithAccount("acct_123"),
	});

	await service.loginWithCode({
		providerId: "openai-codex",
		code: "code",
		codeVerifier: "verifier",
		redirectUri: "http://localhost:1455/auth/callback",
	});

	const stored = await readStoredOAuth("openai-codex");
	expect(stored).toMatchObject({
		accessToken: "access-token",
		refreshToken: "refresh-token",
		accountId: "acct_123",
	});
	expect(stored.expiresAt).toBe("2026-05-20T12:05:00.000Z");
});

test("coalesces concurrent refresh and persists rotated refresh token once", async () => {
	await writeStoredOAuth("openai-codex", expiredOAuthRecord("old-refresh"));
	let refreshCalls = 0;
	const service = makeOAuthService({
		refreshTokens: async () => {
			refreshCalls += 1;
			return tokenResponseWithAccount("acct_123", { refreshToken: "new-refresh" });
		},
	});

	const [first, second] = await Promise.all([
		service.resolveCredentials("openai-codex"),
		service.resolveCredentials("openai-codex"),
	]);

	expect(first.accessToken).toBe("access-token");
	expect(second.accessToken).toBe("access-token");
	expect(refreshCalls).toBe(1);
	expect((await readStoredOAuth("openai-codex")).refreshToken).toBe("new-refresh");
});
```

- [ ] **Step 2: Add service tests for lifecycle races**

Add tests for:

```ts
test("logout waits for refresh and deletes the refreshed credentials", async () => {
	await writeStoredOAuth("openai-codex", expiredOAuthRecord("old-refresh"));
	const service = makeOAuthService({ refreshTokens: delayedRefresh("new-refresh") });

	const refresh = service.resolveCredentials("openai-codex");
	await service.logout("openai-codex");

	await expect(refresh).resolves.toMatchObject({ accountId: "acct_123" });
	expect(await readStoredOAuth("openai-codex")).toBeUndefined();
});

test("delete failure keeps provider cleanup-failed and disabled", async () => {
	const service = makeOAuthService({ deleteSecret: async () => { throw new Error("backend"); } });

	const result = await service.deleteCredentials("openai-codex");

	expect(result).toEqual({ ok: false, failedRefs: ["oauth"] });
	expect(await readStoredOAuth("openai-codex")).toBeDefined();
});

test("stuck lifecycle lock times out without deleting credentials", async () => {
	await writeStoredOAuth("openai-codex", validOAuthRecord());
	const service = makeOAuthService({ lifecycleLock: stuckLifecycleLock() });

	await expect(service.logout("openai-codex")).rejects.toThrow("credential operation timed out");
	expect(await readStoredOAuth("openai-codex")).toBeDefined();
});
```

- [ ] **Step 3: Implement service**

Create `OpenAICodexOAuthService` with:

```ts
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

export class OpenAICodexOAuthService {
	async resolveCredentials(providerId: string): Promise<OpenAICodexRuntimeCredentials>;
	async loginWithCode(input: LoginWithCodeInput): Promise<void>;
	async logout(providerId: string): Promise<void>;
	async deleteCredentials(providerId: string): Promise<CredentialDeleteResult>;
}
```

Use one in-process `Map<string, Promise<OpenAICodexRuntimeCredentials>>` for refresh singleflight and a per-provider lifecycle mutex/queue for logout/delete coordination.

- [ ] **Step 4: Run tests**

Run:

```bash
bun test test/host/openai-codex-oauth/service.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/host/openai-codex-oauth/service.ts test/host/openai-codex-oauth/service.test.ts
git commit -m "feat: manage OpenAI Codex OAuth credentials"
```

---

## Task 7: Extract Shared OpenAI Responses Helpers

**Files:**
- Create: `src/llm/openai/responses-request.ts`
- Create: `src/llm/openai/responses-parse.ts`
- Create: `src/llm/openai/responses-stream.ts`
- Modify: `src/llm/openai.ts`
- Test: `test/llm/openai.test.ts`

- [ ] **Step 1: Add characterization tests for current Responses streaming**

In `test/llm/openai.test.ts`, add tests for `response.output_item.added`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, and `response.output_item.done` ordering. Use a fake SDK stream assigned to `(adapter as any).client.responses.create`.

- [ ] **Step 2: Run characterization tests**

Run:

```bash
bun test test/llm/openai.test.ts
```

Expected: fail if current stream accumulator does not handle the new ordering.

- [ ] **Step 3: Extract request and parser helpers without behavior change**

Move `buildResponsesInput`, `buildResponsesParams`, response parsing, usage parsing, and `safeParseJSON` into focused files. Export the same functions used by tests.

- [ ] **Step 4: Implement stream accumulator**

Create a shared accumulator that accepts SDK `ResponseStreamEvent` values and yields Sprout `StreamEvent` values. It must track `item_id` to `call_id`, handle argument `done`, and synthesize final response only after completion.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test test/llm/openai.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/llm/openai.ts src/llm/openai test/llm/openai.test.ts
git commit -m "refactor: share OpenAI responses helpers"
```

---

## Task 8: OpenAI Codex Adapter

**Files:**
- Create: `src/llm/openai-codex.ts`
- Modify: `src/llm/provider-registry.ts`
- Test: `test/llm/openai-codex.test.ts`
- Test: `test/llm/provider-registry.test.ts`

- [ ] **Step 1: Add adapter tests**

Create `test/llm/openai-codex.test.ts` with a local `Bun.serve` mock verifying:

```ts
test("lists models from the Codex models endpoint", async () => {
	// Server asserts GET /backend-api/codex/models?client_version=0.0.0.
	// Server asserts Authorization and ChatGPT-Account-ID.
	// Adapter parses { models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }] }.
});

test("uses the streaming Codex responses endpoint for complete", async () => {
	// Server asserts POST /backend-api/codex/responses.
	// Adapter.complete() consumes stream and returns final text/tool response.
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test test/llm/openai-codex.test.ts
```

Expected: fail because adapter does not exist.

- [ ] **Step 3: Implement adapter**

Create `OpenAICodexAdapter`:

```ts
export class OpenAICodexAdapter implements ProviderAdapter {
	readonly name = "openai-codex";
	readonly kind = "openai-codex" as const;

	constructor(private readonly options: OpenAICodexAdapterOptions);

	async listModels(): Promise<ProviderModel[]>;
	async checkConnection(): Promise<{ ok: true } | { ok: false; message: string }>;
	async complete(request: Request): Promise<Response>;
	stream(request: Request): AsyncIterable<StreamEvent>;
}
```

Use `new OpenAI({ apiKey: async () => accessToken, baseURL })`, `client.get("/models", { query })`, and `client.responses.create(..., { headers })`.

- [ ] **Step 4: Wire registry**

In `src/llm/provider-registry.ts`, create `OpenAICodexAdapter` when `provider.kind === "openai-codex"`. Pass a credential resolver from registry options rather than raw API-key string.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test test/llm/openai-codex.test.ts test/llm/provider-registry.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/llm/openai-codex.ts src/llm/provider-registry.ts test/llm/openai-codex.test.ts test/llm/provider-registry.test.ts
git commit -m "feat: add OpenAI Codex adapter"
```

---

## Task 9: Settings Control Plane OAuth Commands And Cleanup-Failed Recovery

**Files:**
- Modify: `src/host/settings/control-plane.ts`
- Test: `test/host/settings-control-plane.test.ts`

- [ ] **Step 1: Add control-plane command tests**

Add tests for:

```ts
test("openai-codex snapshots expose oauth credential status", async () => {
	const plane = await makePlaneWithOpenAICodexOAuth({ accountId: "acct_123" });
	const result = await plane.execute({ kind: "get_settings", data: {} });
	expect(result.ok && result.snapshot.providers[0]?.credentialStatus).toMatchObject({
		kind: "oauth",
		signedIn: true,
		accountId: "acct_123",
	});
});

test("login provider oauth is only available for openai-codex", async () => {
	const plane = await makePlaneWithProvider({ kind: "openai", id: "openai" });
	const result = await plane.execute({
		kind: "login_provider_oauth",
		data: { providerId: "openai" },
	});
	expect(result).toMatchObject({ ok: false, code: "unsupported_provider_auth" });
});

test("logout clears oauth status and cached codex models", async () => {
	const plane = await makePlaneWithOpenAICodexOAuth({ accountId: "acct_123" });
	await plane.execute({ kind: "logout_provider_oauth", data: { providerId: "openai-codex" } });
	const result = await plane.execute({ kind: "get_settings", data: {} });
	expect(result.ok && result.snapshot.providers[0]?.credentialStatus).toMatchObject({
		kind: "oauth",
		signedIn: false,
	});
	expect(result.ok && result.snapshot.catalog).toEqual([]);
});

test("partial delete failure marks provider cleanup-failed and disabled", async () => {
	const plane = await makePlaneWithFailingOAuthDelete();
	const result = await plane.execute({
		kind: "delete_provider",
		data: { providerId: "openai-codex" },
	});
	expect(result.ok && result.snapshot.settings.providers[0]).toMatchObject({
		enabled: false,
		disabledReason: "credential-cleanup-failed",
	});
});

test("retry delete removes provider after idempotent cleanup succeeds", async () => {
	const plane = await makePlaneWithCleanupFailedProvider();
	const result = await plane.execute({
		kind: "retry_provider_delete",
		data: { providerId: "openai-codex" },
	});
	expect(result.ok && result.snapshot.settings.providers).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test test/host/settings-control-plane.test.ts
```

Expected: fail because command kinds and snapshots do not exist.

- [ ] **Step 3: Add command types**

Extend `SettingsCommand`:

```ts
| { kind: "login_provider_oauth"; data: { providerId: string } }
| { kind: "logout_provider_oauth"; data: { providerId: string } }
| { kind: "retry_provider_delete"; data: { providerId: string } }
```

Extend `ProviderStatusSnapshot` with:

```ts
credentialStatus:
	| { kind: "none" }
	| { kind: "api-key"; present: boolean }
	| { kind: "oauth"; signedIn: boolean; accountId?: string; email?: string; expiresAt?: string };
```

- [ ] **Step 4: Implement cleanup-failed transitions**

Use `disabledReason: "credential-cleanup-failed"` for partial delete failure. Recovery actions should be present only when that reason is set.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test test/host/settings-control-plane.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/host/settings/control-plane.ts test/host/settings-control-plane.test.ts
git commit -m "feat: add oauth provider settings commands"
```

---

## Task 10: Bootstrap And Agent Runtime Wiring

**Files:**
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/bus/agent-process.ts`
- Test: `test/host/cli-bootstrap.test.ts`
- Test: `test/bus/agent-process.test.ts`

- [ ] **Step 1: Add runtime wiring tests**

Add tests proving:

```ts
test("cli bootstrap wires OpenAI Codex OAuth resolver into provider registry", async () => {
	const bootstrap = await createTestCliBootstrapWithOpenAICodex();
	expect(bootstrap.registryOptions.openAICodexOAuthService).toBeDefined();
});

test("agent process does not use OPENAI_API_KEY for openai-codex providers", async () => {
	const process = await createTestAgentProcess({
		env: { OPENAI_API_KEY: "api-key-should-not-be-used" },
		providerKind: "openai-codex",
	});
	expect(process.registryEntry.validationErrors).toContain(
		"ChatGPT OAuth login is required for OpenAI Codex",
	);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test test/host/cli-bootstrap.test.ts test/bus/agent-process.test.ts
```

Expected: fail until registry options accept OAuth services.

- [ ] **Step 3: Wire OAuth service**

Create one `OpenAICodexOAuthService` per host process and pass it into `ProviderRegistry` wherever registries are constructed.

- [ ] **Step 4: Run tests**

Run:

```bash
bun test test/host/cli-bootstrap.test.ts test/bus/agent-process.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/host/cli-bootstrap.ts src/bus/agent-process.ts test/host/cli-bootstrap.test.ts test/bus/agent-process.test.ts
git commit -m "feat: wire OpenAI Codex OAuth runtime"
```

---

## Task 11: TUI And Web Provider Settings

**Files:**
- Modify: `src/tui/provider-settings-editor.tsx`
- Modify: `web/src/components/settings/ProviderEditor.tsx`
- Test: `test/tui/provider-settings-editor.test.tsx`
- Test: `web/src/components/__tests__/provider-settings.test.tsx`

- [ ] **Step 1: Add UI tests**

Add tests proving:

```ts
test("OpenAI Codex appears as a provider kind", () => {
	renderProviderEditor({ mode: "create" });
	expect(screen.getByText("OpenAI Codex")).toBeTruthy();
});

test("OpenAI Codex hides API key and base URL controls", () => {
	renderProviderEditor({ provider: openAICodexProvider() });
	expect(screen.queryByLabelText("API key or token")).toBeNull();
	expect(screen.queryByLabelText("Base URL")).toBeNull();
});

test("OpenAI Codex shows login/logout controls", () => {
	renderProviderEditor({ provider: openAICodexProvider(), credentialStatus: signedOutOAuth() });
	expect(screen.getByText("Login with ChatGPT")).toBeTruthy();
});

test("cleanup-failed providers show retry delete and sign in again actions", () => {
	renderProviderEditor({
		provider: { ...openAICodexProvider(), enabled: false, disabledReason: "credential-cleanup-failed" },
	});
	expect(screen.getByText("Retry delete")).toBeTruthy();
	expect(screen.getByText("Sign in again")).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test test/tui/provider-settings-editor.test.tsx web/src/components/__tests__/provider-settings.test.tsx
```

Expected: fail until UI options exist.

- [ ] **Step 3: Implement UI controls**

Add `openai-codex` to provider kind option lists. Hide secret/base URL controls for that kind. Dispatch `login_provider_oauth`, `logout_provider_oauth`, and `retry_provider_delete` commands from buttons or TUI commands.

- [ ] **Step 4: Run tests**

Run:

```bash
bun test test/tui/provider-settings-editor.test.tsx web/src/components/__tests__/provider-settings.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/provider-settings-editor.tsx web/src/components/settings/ProviderEditor.tsx test/tui/provider-settings-editor.test.tsx web/src/components/__tests__/provider-settings.test.tsx
git commit -m "feat: expose OpenAI Codex provider settings"
```

---

## Task 12: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-05-19-openai-codex-oauth-design.md` only if implementation diverged.

- [ ] **Step 1: Update user docs**

Document that `OpenAI Codex` uses ChatGPT OAuth, not `OPENAI_API_KEY`, and that login happens from provider settings.

- [ ] **Step 2: Run focused OAuth/provider tests**

Run:

```bash
bun test test/host/openai-codex-oauth test/llm/openai-codex.test.ts test/llm/provider-registry.test.ts test/host/settings-control-plane.test.ts
```

Expected: pass.

- [ ] **Step 3: Run full precommit**

Run:

```bash
bun run precommit
```

Expected: pass.

- [ ] **Step 4: Commit docs**

```bash
git add README.md docs/superpowers/specs/2026-05-19-openai-codex-oauth-design.md
git commit -m "docs: document OpenAI Codex OAuth provider"
```
