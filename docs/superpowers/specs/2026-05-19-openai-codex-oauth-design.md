# OpenAI Codex OAuth Provider Design

## Summary

Sprout should add a new provider kind named `openai-codex`, displayed as `OpenAI Codex`, for
ChatGPT OAuth-backed Codex access. This provider is OAuth-only. It does not accept an API key, does
not use `OPENAI_API_KEY`, and does not expose a user-editable base URL in the settings UI.

The provider should reuse the installed OpenAI TypeScript SDK for transport. The SDK supports a
custom `baseURL`, dynamic async bearer tokens through `apiKey`, per-request headers, typed
Responses streaming, and custom requests through `client.get` / `client.post`. That means Sprout
does not need to clone the Responses HTTP transport or SSE parser. Sprout only needs to own the
Codex-specific seams: OAuth login and refresh, ChatGPT account headers, Codex model-list parsing,
and the runtime adapter boundary.

This design intentionally keeps `openai-codex` separate from the existing `openai` provider. The
public OpenAI API-key provider and the ChatGPT Codex OAuth provider share Responses request
building, response parsing, and stream accumulation, but they do not share auth semantics, model
listing, endpoint selection, or provider validation.

## Goals

- Add `OpenAI Codex` as a first-class provider type.
- Support only ChatGPT OAuth for this provider.
- Use the ChatGPT Codex backend endpoints for responses and model discovery.
- Preserve new GPT-5.x and Codex model IDs from the remote Codex model endpoint.
- Reuse the OpenAI TypeScript SDK wherever it correctly handles transport, streaming, retries, and
  request construction.
- Avoid subclassing the existing OpenAI adapter when the behavior contract is materially different.
- Avoid copying Sprout's existing Responses request/stream/parse logic by extracting shared helpers.
- Add regression coverage for the URL, model-list, and stream-tool-call issues that previously had
  to be fixed in Serf.
- Expose OAuth login/logout/status in both web and TUI provider settings.

## Non-Goals

- Reusing `OPENAI_API_KEY` or any existing OpenAI API-key secret for `OpenAI Codex`.
- Adding API-key mode to `OpenAI Codex`.
- Turning `openai` into a mixed API-key/OAuth provider.
- Exposing the Codex backend URL as normal user-facing provider configuration.
- Supporting arbitrary ChatGPT web session cookies.
- Supporting Codex WebSocket transports in this iteration.
- Supporting every possible Codex backend response field beyond what Sprout needs for text, usage,
  and tool calls.
- Preserving any previous draft or experimental OpenAI Codex settings shape.

## Reference Findings

The installed OpenAI SDK version is `openai@6.22.0`. Local verification showed that this works:

```ts
new OpenAI({
	apiKey: async () => refreshedToken,
	baseURL: "http://127.0.0.1:<port>/backend-api/codex",
});
```

With that client, the SDK issues the correct Codex-shaped requests:

```text
GET  /backend-api/codex/models?client_version=0.0.0
POST /backend-api/codex/responses
Authorization: Bearer <dynamic-token>
ChatGPT-Account-ID: <account-id>
```

The SDK also exposes:

- async `apiKey` resolution before each request
- `defaultHeaders` and per-request `headers`
- custom endpoint calls through `client.get`
- Responses streaming event types including `response.output_item.added` and
  `response.function_call_arguments.done`

The upstream Codex implementation confirms the backend model:

- ChatGPT Codex base URL: `https://chatgpt.com/backend-api/codex`
- models endpoint path: `models`
- models endpoint query: `client_version=<semver>`
- request auth: bearer token plus `ChatGPT-Account-ID`

Serf's history is also a design input. It had later fixes for:

- aligning the authorize URL with the Codex flow
- matching the Codex login flow after URL/scope/originator drift
- streaming OAuth-backed OpenAI responses instead of relying on non-streaming completion
- stabilizing streamed tool-call assembly
- switching model discovery to the Codex models endpoint

Those become explicit tests in Sprout rather than implementation notes.

## Provider Model

Add `openai-codex` to `ProviderKind`:

```ts
type ProviderKind =
	| "anthropic"
	| "openai"
	| "openai-codex"
	| "openai-compatible"
	| "openrouter"
	| "gemini";
```

Example provider config:

```ts
{
	id: "openai-codex",
	kind: "openai-codex",
	label: "OpenAI Codex",
	enabled: true,
	createdAt: "...",
	updatedAt: "..."
}
```

The settings model should not add Codex-only provider fields unless runtime evidence requires them.
The provider kind itself is enough to determine:

- OAuth-only credential requirements
- no API-key field
- no editable base URL
- Codex model endpoint
- Codex responses endpoint

## Credential Storage

The current secret store is API-key-only. It should be widened to support OAuth credential records
without storing tokens in `settings.json`.

Runtime secret references should support at least:

```ts
type ProviderSecretKind = "api-key" | "oauth";

interface ProviderSecretRef {
	providerId: string;
	secretKind: ProviderSecretKind;
	storageBackend: "macos-keychain" | "secret-service" | "memory";
	storageKey: string;
}
```

Each provider kind must declare the credential refs it owns. The declaration is the source of truth
for validation, logout, provider deletion, retry delete, cleanup-failed recovery, and tests.

```ts
const PROVIDER_CREDENTIAL_REFS = {
	"openai-codex": ["oauth"],
	openai: ["api-key"],
	anthropic: ["api-key"],
	gemini: ["api-key"],
	openrouter: ["api-key"],
	"openai-compatible": ["api-key"],
} as const;
```

`openai-compatible` still treats the API-key ref as optional for provider readiness; the ref
declaration only says which credential ref the provider kind can own.

The `openai-codex` OAuth record should be stored as JSON under the OAuth secret ref:

```ts
interface OpenAICodexOAuthCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: string;
	accountId: string;
	idToken?: string;
	email?: string;
	updatedAt: string;
}
```

`settings.json` stores the provider config only. It does not store access tokens, refresh tokens,
secret refs, or persisted `hasSecret` flags. Credential presence is derived at runtime by the
settings control plane.

OAuth storage keys are deterministic from the provider id:

```text
sprout/providers/<providerId>/oauth
```

Provider ids used in secret keys must already be validated to Sprout's safe provider-id character
set. If that validation does not guarantee no `/`, path-like segments, control characters, or
backend-significant delimiters, the secret-store layer must encode the provider id before composing
the storage key. The same helper must be used for get, set, status, logout, and provider deletion.

The active secret backend is selected the same way existing API-key credentials select it. The
backend name is part of the runtime `ProviderSecretRef` because the secret-store implementation
needs it, but it is not persisted in provider settings.

Logout deletes only the OAuth secret for that provider id and clears cached account display state
and cached Codex models for that provider. Deleting a provider must delete every credential ref
owned by that provider kind so abandoned credentials do not remain in the OS secret store. For
`openai-codex`, the owned credential ref set is only `oauth`; it never owns an API-key ref.

Provider deletion should report secret-deletion failures clearly; it must not silently leave
credentials behind. Secret deletion is idempotent: deleting an already-missing secret counts as
success. If deleting multiple secret refs partially fails, Sprout should keep the provider config,
set the existing `ProviderConfig.enabled` field to `false`, show a credential cleanup failure in the
delete command result, and let retry attempt all expected secret refs again. The retry path should
treat the refs already deleted in the previous attempt as success.

Cleanup-failure state needs a user-visible distinction from a normal user-disabled provider. Add a
small optional persisted marker to `ProviderConfig`:

```ts
disabledReason?: "user" | "credential-cleanup-failed";
```

Existing configs with `enabled: false` and no `disabledReason` are treated as user-disabled, so the
migration default is implicit. Normal user-disabled providers should omit `disabledReason`; do not
persist `"user"` unless a later schema needs it. A cleanup-failed provider is stored as:

```ts
enabled: false;
disabledReason: "credential-cleanup-failed";
```

`enabled: false` blocks all runtime use of the provider, including cached adapter reuse, model
refresh, connection checks, completions, and exact-model resolution. The registry should not
materialize disabled providers as usable runtime adapters. Any long-lived session or cached adapter
path must re-check provider enabled state before starting a new model request.

Cached model lists for a cleanup-failed provider may remain in settings for recovery/debugging, but
they must be shown as unavailable and must not appear as selectable exact models. Cached account
display state is cleared on logout and on successful provider deletion. On partial deletion failure,
the delete command result should include the safe names of failed refs, such as `api-key` or
`oauth`; it must not include storage backend internals or secret values.

Allowed public failed-ref labels are limited to domain credential kinds:

- `api-key`
- `oauth`

Failed-ref labels are derived from the provider kind's expected credential refs and the current
delete attempt result. They are not backend storage identifiers. If a future provider kind owns
multiple credential refs, recovery actions must reconcile all expected refs before clearing
cleanup-failed state.

Reconcile means:

- for a ref that the recovery action will replace, delete the stale ref before starting the new
  credential flow, then persist the new credential only after the new credential validates
- for a ref that the recovery action cannot replace, verify it is absent or delete it before
  starting the new credential flow
- if any expected ref cannot be deleted, verified absent, or replaced, abort recovery and keep
  `disabledReason: "credential-cleanup-failed"`

Recovery actions are provider-kind-specific. `OpenAI Codex` can offer sign-in-again because its
only expected ref is `oauth`, and the OAuth login can replace that ref. A future multi-ref provider
must declare which recovery actions can reconcile all of its expected refs; otherwise it should
offer retry delete only.

Backend-specific storage keys, keychain labels, file paths, command lines, token values, and raw
backend error text must not appear in user-facing delete results. Developer logs may include backend
error class names and operation names, but they must still redact secret values, authorization
headers, callback codes, and full callback URLs containing `code`.

Redaction happens at every boundary that can surface credential errors:

- the secret-store boundary maps backend failures to domain credential ref labels
- the logging boundary redacts token-like values and callback URLs before writing logs
- the UI/control-plane boundary returns only safe ref labels and redacted messages

Cleanup-failed provider UI should expose two actions:

- retry delete, which retries all expected secret refs idempotently and removes the provider on
  success
- sign in again, which first reconciles every expected credential ref for the provider kind under
  the lifecycle lock, then runs login and clears `disabledReason` only after a valid credential is
  persisted and no expected failed ref remains

Successful re-login should not silently re-enable a provider that the user had disabled before the
cleanup failure. Re-enable still goes through the existing provider enable path.

If sign-in-again starts but token exchange or persistence fails, the provider remains
cleanup-failed. If a future provider kind somehow persists a replacement credential and then
discovers another expected ref still failed reconciliation, it must keep the provider disabled and
cleanup-failed, discard the newly persisted replacement credential on a best-effort basis, and
report the remaining safe failed-ref labels.

State transitions:

| Action | Result |
| --- | --- |
| User disables provider | `enabled: false`, omit `disabledReason` |
| User enables provider | `enabled: true`, omit `disabledReason` |
| Logout succeeds | `enabled` unchanged, omit `disabledReason` unless already cleanup-failed |
| Delete succeeds | provider config removed, all expected secret refs absent |
| Delete partially fails | `enabled: false`, `disabledReason: "credential-cleanup-failed"` |
| Retry delete succeeds | provider config removed, all expected secret refs absent |
| Retry delete partially fails | keep cleanup-failed state and report safe failed-ref labels |
| Sign in again succeeds from cleanup-failed | `enabled: false`, omit `disabledReason` |
| Sign in again fails from cleanup-failed | keep cleanup-failed state |

The successful sign-in-again state deliberately remains disabled. This avoids needing to remember
whether the provider was enabled before the failed deletion attempt. The user can then explicitly
enable the provider through the existing enable action.

Provider ids are stable identifiers. The settings UI may edit a provider label, but it should not
rename provider ids in this iteration. If provider-id renaming is added later, it must either move
the OAuth secret to the new deterministic key or require an explicit re-login. Silent orphaning is
not acceptable.

Multiple ChatGPT accounts are not a first-version goal. The data model allows more than one
`openai-codex` provider id, but the UI should present a single default `OpenAI Codex` provider
path. If a user manually creates multiple Codex providers later, each provider id owns its own
OAuth secret record and credential lifecycle lock.

## OAuth Flow

Use the Codex-compatible OAuth flow because Serf later had to align to it. The constants below
follow local `inspo/codex` and local `inspo/serf`; the Pi implementation was the earlier baseline
before the connector-scope drift was found. The login implementation must include an acceptance test
or manual verification note that proves these constants still complete a login before the feature is
considered done.

Constants:

```text
authorize URL: https://auth.openai.com/oauth/authorize
token URL:     https://auth.openai.com/oauth/token
client id:     app_EMoamEEZ73f0CkXaXp7hrann
redirect path: /auth/callback
primary URI:   http://localhost:1455/auth/callback
fallback URI:  http://localhost:1457/auth/callback
scopes:        openid profile email offline_access api.connectors.read api.connectors.invoke
originator:    pi
```

Authorize requests must include:

```text
response_type=code
client_id=<client id>
redirect_uri=<selected redirect URI>
scope=openid profile email offline_access api.connectors.read api.connectors.invoke
code_challenge=<PKCE challenge>
code_challenge_method=S256
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=pi
state=<opaque state>
```

The callback listener should bind the primary port first and fall back to the fallback port only if
the primary port is unavailable. It should validate both the path and state before exchanging the
code.

The callback listener must be loopback-only. Bind to `127.0.0.1` or `localhost`; do not bind to
`0.0.0.0`. It should accept only `GET /auth/callback`, reject other methods and paths,
and stop the listener after the first terminal result. State and PKCE verifier values are one-shot
values; after a successful callback, failed callback, timeout, or cancellation, they must be
unusable.

The login flow should set a finite timeout, clean up the listener on timeout, and provide a manual
pasteback fallback with the same state validation. Auth codes, access tokens, refresh tokens, and
authorization headers must never be logged or rendered in error messages.

Manual pasteback should prefer the full callback URL because it carries the returned `state` value.
Full callback URLs must be parsed with the same path and state validation as the local callback
listener. Raw-code pasteback is optional; if supported, it must be a two-field UI form with one
field for the authorization code and one field for the returned state. Sprout should not print or
log the expected state value. Pasteback errors must redact `code`, `state`, and the original URL.

Token exchange and refresh use form-encoded POSTs to the token URL. The initial exchange must return
a refresh token. Later refresh responses may rotate the refresh token; when they do, Sprout should
persist the replacement, and when they do not, Sprout should preserve the existing refresh token.
The refresh path should persist the current access token, refresh token, expiry, and account id. The
account id comes from `chatgpt_account_id` inside the nested `https://api.openai.com/auth` JWT
claim when available.

Account id extraction is decode-only. Sprout should base64url-decode the JWT payload to read
non-secret claims, but it should not claim cryptographic JWT validation unless it also implements
issuer, audience, expiry, and key validation. The supported account-id paths are:

1. `chatgpt_account_id` nested under `https://api.openai.com/auth` from the access token.
2. the same nested claim from the id token, if the access token does not contain it.
3. an already stored account id during refresh, when the refreshed token omits the claim.

Initial login must fail if no account id can be extracted from either token. Refresh must fail if
no account id can be extracted and no previously stored account id exists. Malformed JWTs should
produce an OAuth credential error that redacts the token value.

Initial credential persistence must happen only after token exchange, expiry parsing, and account-id
extraction all succeed. Sprout should never write a partial initial OAuth record that lacks
`refreshToken`, `expiresAt`, or `accountId`.

## Refresh Concurrency

Refreshing OAuth credentials must be serialized per provider id. Model refresh, connection checks,
streaming completions, and non-streaming completions may request a valid token at the same time.
If credentials are expired or inside the refresh skew window, only one refresh request should run
for that provider id; other callers should await the same in-flight refresh result.

The first implementation only needs to guarantee this within one Sprout host process.
Multi-process coordination across two independent Sprout processes is out of scope unless the
existing secret-store backend already provides a usable compare-and-swap or lock primitive. If
Sprout later supports multiple simultaneous host processes against the same settings and secret
store, this spec must be extended with an interprocess credential lock or versioned write contract
before enabling that mode.

Credential persistence should avoid stale writes. A refresh operation should load the current stored
record, refresh the current refresh token, and then persist the result only if it is still based on
the latest known credential generation. A simple implementation can store an `updatedAt` or
`version` field and re-read before writing. If another refresh already wrote a newer record, the
later caller should use the newer record instead of overwriting it with stale tokens.

Refresh should use a fixed skew window before `expiresAt` so normal requests do not race the server
at token expiry. Use five minutes unless implementation evidence shows OpenAI tokens require a
different value. If the local clock makes `expiresAt` appear invalid or already expired immediately
after token exchange, treat that as an OAuth credential error rather than persisting unusable
credentials.

If the token endpoint fails during a shared refresh, all callers waiting on that refresh receive the
same redacted OAuth error, the in-flight lock is cleared, and stored credentials are left unchanged.
A later request may retry refresh normally.

Tests should cover two concurrent callers with an expired token where the token endpoint rotates the
refresh token. The expected behavior is one network refresh, both callers receive the new access
token, and the stored record contains the rotated refresh token.

Stored OAuth JSON is schema-checked before use. Missing required fields, malformed JSON, or an
unsupported future schema version should make the provider report an invalid OAuth credential state
and ask the user to sign in again. Sprout should not try to repair corrupt token records in place.

Logout and provider deletion use the same per-provider credential lifecycle lock as refresh. The
first implementation can satisfy this by making logout/delete wait for any in-flight refresh to
finish and then deleting credentials and caches under the lock. An implementation that lets token
refresh network calls run outside the lock must instead maintain a per-provider credential
generation and refuse to write refresh results if logout/delete advanced the generation while the
refresh was in flight.

Lifecycle-lock waits must be bounded. Refresh operations should have their own network timeout, and
logout/delete should fail clearly instead of waiting forever if the credential lifecycle lock cannot
be acquired within the configured credential-operation timeout. A failed lock acquisition should not
delete any secrets or caches.

Use a non-user-facing default credential-operation timeout of 30 seconds unless implementation
evidence shows this is too short for OpenAI token exchange. Tests should inject a stuck lifecycle
lock or fake clock rather than sleeping for the real timeout.

Provider reconfiguration does not get a new credential mutation path in this iteration. Label edits
do not affect credentials. Provider-id rename remains out of scope. Changing a provider across
credential modes should be implemented as delete plus create, so the deletion cleanup rules above
remain the only credential cleanup path.

Tests should prove that a refresh cannot recreate credentials after logout or provider deletion.
The acceptable outcomes are either:

1. refresh finishes first, then logout/delete removes the freshly written credentials; or
2. logout/delete invalidates the refresh generation, and the refresh result is discarded.

## Adapter Architecture

Add an `OpenAICodexAdapter` that implements `ProviderAdapter` directly. It should not subclass
`OpenAIAdapter`, because the meaningful behavior differs:

- auth source
- model-list endpoint and response shape
- provider validation
- connection status
- required headers
- completion strategy

Shared behavior should be extracted from the existing OpenAI adapter into focused helpers, for
example:

```text
src/llm/openai/responses-request.ts
src/llm/openai/responses-parse.ts
src/llm/openai/responses-stream.ts
src/llm/openai/model-filter.ts
```

The exact file names can follow the surrounding code style during implementation. The important
boundary is that shared helpers are pure Sprout protocol mapping code, while each adapter owns its
provider-specific client and endpoint behavior.

`OpenAIAdapter` remains responsible for:

- public OpenAI API-key provider
- existing OpenAI-compatible behavior
- OpenRouter chat-completions behavior where currently routed through this adapter

`OpenAICodexAdapter` is responsible for:

- resolving and refreshing OAuth credentials
- constructing an SDK client with `baseURL: "https://chatgpt.com/backend-api/codex"`
- attaching `ChatGPT-Account-ID`
- calling the Codex model endpoint through `client.get`
- using Responses streaming for both `stream()` and `complete()`

## SDK Usage

The Codex adapter should construct the SDK client with a dynamic token provider:

```ts
new OpenAI({
	apiKey: async () => credentialProvider.accessToken(),
	baseURL: "https://chatgpt.com/backend-api/codex",
	defaultHeaders: {
		"ChatGPT-Account-ID": accountId,
	},
});
```

If the account id can change during refresh, use per-request headers or recreate the client after
refresh. The implementation should not cache a stale account id in a way that survives credential
rotation.

Responses:

```ts
client.responses.create(
	{ ...sharedResponsesParams, stream: true },
	{ headers: { "ChatGPT-Account-ID": accountId } },
);
```

Models:

```ts
client.get("/models", {
	query: { client_version: "0.0.0" },
	headers: { "ChatGPT-Account-ID": accountId },
});
```

`client.models.list()` must not be used for Codex model discovery because it assumes the public
OpenAI `/models` response shape.

## Model Discovery

The Codex model endpoint returns a Codex-specific shape. Sprout should parse the known useful forms:

```ts
interface CodexModelsResponse {
	models?: Array<{
		slug?: string;
		model?: string;
		id?: string;
		display_name?: string;
	}>;
	data?: Array<{
		id: string;
	}>;
}
```

For `models[]`, choose the first non-empty id from:

1. `slug`
2. `model`
3. `id`

Use `display_name` as the label when present, otherwise use the model id. Preserve remote IDs
exactly. Do not maintain a hard-coded GPT-5.x allowlist. Filtering should only remove model classes
Sprout cannot use as text/reasoning models, matching the existing OpenAI filter behavior where
appropriate.

## Completion And Streaming

For `openai-codex`, `complete()` should internally consume the streaming Responses path and return
the accumulated final `Response`. Serf needed this because OAuth-backed Codex behavior was more
reliable through streaming.

The shared stream accumulator must handle these event types:

- `response.output_item.added`
- `response.output_text.delta`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`
- `response.incomplete`

Tool-call assembly must track both item ids and call ids. The failure mode to avoid is receiving
arguments by `item_id` and later only finalizing by `call_id`, or vice versa. The accumulator should
emit Sprout tool-call deltas as argument text arrives and emit one final tool call when the function
call is complete.

The final response should include:

- assistant text content, when present
- function tool calls, when present
- usage with cache-read and reasoning-token fields when available
- raw finish/status information for diagnostics

Streaming must honor cancellation and timeout signals from the caller. If a Sprout request is
aborted, the SDK request should receive the abort signal, the stream accumulator should stop
emitting events, and the final response should not be synthesized from a partial stream as if it
completed successfully.

## Settings Control Plane

The settings control plane should grow credential-aware provider operations rather than treating all
provider credentials as API keys.

Add commands equivalent to:

```ts
loginProviderOAuth(providerId: string): Promise<ProviderSettingsSnapshot>
logoutProviderOAuth(providerId: string): Promise<ProviderSettingsSnapshot>
refreshProviderOAuth(providerId: string): Promise<ProviderSettingsSnapshot>
```

The command names can follow existing command naming conventions. They should validate that the
provider kind supports OAuth before doing work.

Provider snapshots should distinguish credential kinds:

```ts
type ProviderCredentialStatus =
	| { kind: "none" }
	| { kind: "api-key"; present: boolean }
	| {
			kind: "oauth";
			signedIn: boolean;
			accountId?: string;
			email?: string;
			expiresAt?: string;
	  };
```

Existing `hasSecret` can remain temporarily if current UI paths need it, but new OpenAI Codex UI
should not describe OAuth credentials as an API key or secret token.

## Web And TUI UX

The provider kind selector should include `OpenAI Codex`.

When editing an `OpenAI Codex` provider:

- hide API-key/token fields
- hide base URL fields
- show `Login with ChatGPT`
- show `Logout` when signed in
- show signed-in status using email or account id when available
- show expiry/refresh errors when relevant
- allow model refresh only when OAuth credentials are present

The TUI provider editor should expose equivalent commands, for example:

```text
login
logout
refresh-models
test
```

The exact command names should match the existing TUI style. The important behavior is that `secret
<token>` is not the path for `OpenAI Codex`.

## Validation

Provider validation should become credential-aware:

| Provider kind | Required credential | Notes |
| --- | --- | --- |
| `openai` | API key | Uses public OpenAI API. |
| `openai-codex` | OAuth | Must not use `OPENAI_API_KEY`. |
| `anthropic` | API key | Existing behavior. |
| `gemini` | API key | Existing behavior. |
| `openrouter` | API key | Existing behavior. |
| `openai-compatible` | optional token | Base URL remains required. |

Missing OpenAI Codex OAuth should report a specific message such as:

```text
ChatGPT OAuth login is required for OpenAI Codex.
```

It should not report:

```text
API key is required.
```

## Runtime Flow

Model refresh:

1. Registry resolves the `openai-codex` provider.
2. Adapter asks the OAuth credential provider for a valid access token and account id.
3. Credential provider refreshes and persists credentials if needed through the per-provider
   singleflight path.
4. Adapter calls `GET /models?client_version=0.0.0` through the SDK.
5. Adapter parses Codex `models[]` and returns `ProviderModel[]`.

If model refresh fails after a previous successful refresh, Sprout may continue showing the last
cached remote model list with a visible refresh error. A failed refresh must not replace the cached
list with an empty list unless the user deletes the provider or explicitly clears the cache.

Completion:

1. Runtime routes explicit `providerId + modelId` to `OpenAICodexAdapter`.
2. Adapter builds Responses params through shared helpers.
3. Adapter resolves fresh OAuth credentials.
4. Adapter calls `client.responses.create(..., stream: true)`.
5. Shared stream accumulator yields Sprout stream events.
6. `complete()` consumes the same stream path and returns the accumulated response.

Connection check:

1. Resolve OAuth credentials.
2. Call the Codex models endpoint with a short timeout.
3. Report OAuth-specific failures separately from network and endpoint failures where possible.

## Error Handling

OAuth login errors should be specific:

- callback port unavailable on both `1455` and `1457`
- callback state mismatch
- authorization server returned `error`
- token exchange failed
- initial token response missing refresh token
- account id unavailable after all supported extraction paths

Runtime errors should preserve useful OpenAI/Codex response headers where available:

- request id
- authorization error headers
- Cloudflare/debug headers when present

Runtime errors and logs must redact:

- OAuth authorization codes
- access tokens
- refresh tokens
- `Authorization` header values
- full callback URLs that contain `code`

Redaction tests should include representative inputs for:

- `Authorization: Bearer <token>`
- callback URLs containing `code` and `state`
- raw pasted authorization codes
- backend storage paths or keys
- backend error text containing a token-looking value

The UI should show clear remediation:

- missing OAuth: sign in with ChatGPT
- expired or refresh failed: sign in again
- model endpoint unauthorized: sign out and sign in again

## Tests

Add tests before implementation for these behaviors.

OAuth URL and callback:

- authorize URL includes `id_token_add_organizations=true`
- authorize URL includes `codex_cli_simplified_flow=true`
- authorize URL uses `originator=pi`
- authorize URL uses `http://localhost:1455/auth/callback`
- fallback uses `http://localhost:1457/auth/callback`
- callback rejects wrong path
- callback rejects wrong method
- callback rejects wrong state
- callback listener binds loopback-only
- callback state and PKCE are one-shot
- callback listener is cleaned up on timeout
- manual pasteback parses full callback URLs with state validation
- optional raw-code pasteback requires separate code and returned-state fields
- logs and errors redact callback codes, OAuth tokens, authorization headers, callback URLs,
  backend storage keys, and backend errors containing token-like values

Credentials:

- secret store can store and retrieve OAuth JSON records
- provider-kind credential ref declarations drive validation, deletion, retry, and recovery
- OAuth storage keys are deterministic: `sprout/providers/<providerId>/oauth`
- provider ids are validated or encoded before they are used in storage keys
- logout and provider deletion delete the OAuth secret
- logout clears cached account display state and cached Codex models
- corrupt or unsupported OAuth JSON asks the user to sign in again
- provider deletion reports secret-deletion failures instead of silently orphaning credentials
- partial provider deletion failure disables the provider and retries all secret refs idempotently
- disabled providers cannot refresh models, check connections, or complete requests
- disabled providers cannot expose cached models as selectable exact models
- cleanup-failed disabled providers persist `disabledReason: "credential-cleanup-failed"`
- user-disabled providers have no cleanup-failed recovery actions
- cleanup-failed delete results include only safe failed-ref names
- cleanup-failed state transitions match the spec table
- user-facing failed-ref labels are allowlisted to `api-key` and `oauth`
- sign-in-again from cleanup-failed clears recovery state only after all expected refs reconcile
- `openai-codex` expected credential refs contain only `oauth`
- redaction is enforced at secret-store, logging, and UI/control-plane boundaries
- retrying deletion after partial failure treats already-missing secret refs as success
- initial credentials are persisted only after account-id extraction succeeds
- refresh persists rotated access token, refresh token, expiry, and account id
- refresh preserves the existing refresh token when the token endpoint does not rotate it
- concurrent refresh callers share one in-flight refresh and do not stale-write credentials
- concurrent refresh failure clears the in-flight lock and leaves stored credentials unchanged
- logout/delete cannot be undone by an in-flight refresh writing credentials afterward
- logout/delete lock waits are bounded and fail without deleting secrets when the lock is stuck
- credential-operation timeout behavior is testable with injected fake locks or clocks
- refresh uses a five-minute expiry skew unless implementation evidence changes that value
- account id is extracted from `chatgpt_account_id` nested under `https://api.openai.com/auth`
- account id can fall back from access token to id token on initial login
- refresh can use a stored account id when refreshed tokens omit the claim
- malformed JWT payloads return redacted OAuth credential errors
- `OPENAI_API_KEY` does not satisfy `openai-codex`

Adapter:

- model refresh calls `/backend-api/codex/models?client_version=0.0.0`
- model refresh sends `Authorization` and `ChatGPT-Account-ID`
- model parser accepts Codex `models[]`
- model parser preserves GPT-5.x ids exactly
- responses call `/backend-api/codex/responses`
- `complete()` uses the streaming path
- stream accumulator handles `output_item.added`, argument deltas, argument done, item done, and
  response completed
- request abort propagates to the SDK stream
- failed model refresh preserves the previous cached model list and reports the refresh error

Settings UI:

- `OpenAI Codex` appears as a provider kind
- API-key field is hidden for `OpenAI Codex`
- base URL field is hidden for `OpenAI Codex`
- OAuth login/logout controls are visible
- missing OAuth reports OAuth login required, not API key required

Regression tests from Serf history:

- no random callback port in the authorize URL
- connector scopes stay present in the Codex-compatible login flow
- no `originator=sprout` drift without an intentional design change
- no public `/v1/models` call for Codex OAuth providers
- no non-streaming-only completion path for Codex OAuth providers

## Implementation Slices

This is the expected implementation order after this spec is approved:

1. Add provider kind and credential-aware validation tests.
   - Focused verification: provider validation tests and typecheck.
2. Add deterministic OAuth secret references, provider-id key safety, and storage tests.
   - Focused verification: secret-store tests.
3. Add provider-kind expected credential ref declarations.
   - Focused verification: validation, deletion, retry, and recovery all use the shared
     declaration.
4. Characterize provider materialization and provider-enabled gating paths.
   - Focused verification: registry materialization, exact-model resolution, model refresh, and
     connection checks have baseline tests.
5. Characterize request-time provider-use and cache paths.
   - Focused verification: completions, cached adapters, and cached model reads have baseline
     tests.
6. Add shared enabled-provider guard and disabled-reason settings behavior.
   - Focused verification: disabled provider runtime and cached-model gating tests.
7. Add OAuth authorize URL and PKCE/state tests.
   - Focused verification: auth URL/state tests.
8. Add callback listener tests and implementation.
   - Focused verification: callback method/path/state/timeout tests.
9. Add manual pasteback parsing and redaction tests.
   - Focused verification: pasteback URL/raw-code/state tests.
10. Add account-id extraction and decode-only token claim handling.
   - Focused verification: claim extraction tests with malformed and missing-claim tokens.
11. Add token exchange and initial credential persistence.
   - Focused verification: exchange persists only fully valid credentials.
12. Add corrupt stored-credential handling and logout cleanup behavior.
   - Focused verification: invalid JSON and logout tests.
13. Add refresh persistence, refresh-token rotation handling, and per-provider singleflight.
   - Focused verification: concurrent refresh tests.
14. Add provider deletion cleanup, cleanup-failed state, and retry behavior.
    - Focused verification: partial deletion, cleanup-failed UI state, retry deletion, and
      deletion-path redaction tests.
15. Add cleanup-failed control-plane recovery action contract.
    - Focused verification: retry delete and sign-in-again actions appear only in cleanup-failed
      state, never for ordinary user-disabled providers, and sign-in-again reconciles expected refs.
16. Add refresh/logout/delete coordination tests.
    - Focused verification: refresh cannot recreate credentials after logout or deletion.
17. Add lifecycle-lock timeout tests with injected fake locks or clocks.
    - Focused verification: stuck lock does not delete secrets or caches.
18. Add refresh failure, expiry skew, and stale-write tests.
    - Focused verification: refresh failure and skew tests.
19. Add characterization tests around the current OpenAI adapter.
   - Focused verification: existing OpenAI adapter tests pass with no code movement.
20. Extract shared Responses request-building helpers.
   - Focused verification: characterization tests still pass.
21. Extract shared Responses parser helpers.
    - Focused verification: parser and existing adapter tests still pass.
22. Extract shared Responses stream accumulator.
    - Focused verification: streaming and tool-call tests still pass.
23. Add `OpenAICodexAdapter` using the OpenAI SDK with Codex base URL.
    - Focused verification: adapter URL/header tests.
24. Add Codex model endpoint parsing and cache-failure behavior.
    - Focused verification: model parser and model-cache tests.
25. Wire registry and settings control-plane OAuth operations.
    - Focused verification: registry and control-plane tests.
26. Update web provider settings.
    - Focused verification: web settings tests.
27. Update TUI provider settings.
    - Focused verification: TUI settings tests.
28. Update docs and run the full verification gate.
    - Final verification: `bun run precommit`, plus any targeted integration checks added during
      implementation.

## Open Decision

The only intentionally exposed design choice is the `originator` value. This spec uses
`originator=pi` because Pi and Serf converged there after URL fixes. Changing it to `sprout` would
be a product identity choice, not a refactor, and should require a fresh login-flow verification
pass before implementation.
