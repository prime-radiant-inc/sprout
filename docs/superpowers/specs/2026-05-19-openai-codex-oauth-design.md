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
- matching the Pi login flow after URL/scope/originator drift
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

The active secret backend is selected the same way existing API-key credentials select it. The
backend name is part of the runtime `ProviderSecretRef` because the secret-store implementation
needs it, but it is not persisted in provider settings.

Logout deletes only the OAuth secret for that provider id. Deleting a provider must delete both its
API-key and OAuth secret refs so abandoned credentials do not remain in the OS secret store.

Provider ids are stable identifiers. The settings UI may edit a provider label, but it should not
rename provider ids in this iteration. If provider-id renaming is added later, it must either move
the OAuth secret to the new deterministic key or require an explicit re-login. Silent orphaning is
not acceptable.

Multiple ChatGPT accounts are not a first-version goal. The data model allows more than one
`openai-codex` provider id, but the UI should present a single default `OpenAI Codex` provider path.
If a user manually creates multiple Codex providers later, each provider id owns its own OAuth
secret record and refresh lock.

## OAuth Flow

Use the Pi-compatible OAuth flow because Serf later had to align to it. The constants below were
verified against the local `inspo/codex`, local `inspo/serf`, and the Pi implementation on
2026-05-19. The login implementation must include an acceptance test or manual verification note
that proves these constants still complete a login before the feature is considered done.

Constants:

```text
authorize URL: https://auth.openai.com/oauth/authorize
token URL:     https://auth.openai.com/oauth/token
client id:     app_EMoamEEZ73f0CkXaXp7hrann
redirect path: /auth/callback
primary URI:   http://localhost:1455/auth/callback
fallback URI:  http://localhost:1457/auth/callback
scopes:        openid profile email offline_access
originator:    pi
```

Authorize requests must include:

```text
response_type=code
client_id=<client id>
redirect_uri=<selected redirect URI>
scope=openid profile email offline_access
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

Token exchange and refresh use form-encoded POSTs to the token URL. The initial exchange must return
a refresh token. Later refresh responses may rotate the refresh token; when they do, Sprout should
persist the replacement, and when they do not, Sprout should preserve the existing refresh token.
The refresh path should persist the current access token, refresh token, expiry, and account id. The
account id comes from the `https://api.openai.com/auth.chatgpt_account_id` JWT claim when available.

Account id extraction is decode-only. Sprout should base64url-decode the JWT payload to read
non-secret claims, but it should not claim cryptographic JWT validation unless it also implements
issuer, audience, expiry, and key validation. The supported account-id paths are:

1. `https://api.openai.com/auth.chatgpt_account_id` from the access token.
2. the same claim from the id token, if the access token does not contain it.
3. an already stored account id during refresh, when the refreshed token omits the claim.

Initial login must fail if no account id can be extracted from either token. Refresh must fail if
no account id can be extracted and no previously stored account id exists. Malformed JWTs should
produce an OAuth credential error that redacts the token value.

## Refresh Concurrency

Refreshing OAuth credentials must be serialized per provider id. Model refresh, connection checks,
streaming completions, and non-streaming completions may request a valid token at the same time.
If credentials are expired or inside the refresh skew window, only one refresh request should run
for that provider id; other callers should await the same in-flight refresh result.

Credential persistence should avoid stale writes. A refresh operation should load the current stored
record, refresh the current refresh token, and then persist the result only if it is still based on
the latest known credential generation. A simple implementation can store an `updatedAt` or
`version` field and re-read before writing. If another refresh already wrote a newer record, the
later caller should use the newer record instead of overwriting it with stale tokens.

Tests should cover two concurrent callers with an expired token where the token endpoint rotates the
refresh token. The expected behavior is one network refresh, both callers receive the new access
token, and the stored record contains the rotated refresh token.

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
- logs and errors redact callback codes and OAuth tokens

Credentials:

- secret store can store and retrieve OAuth JSON records
- OAuth storage keys are deterministic: `sprout/providers/<providerId>/oauth`
- logout and provider deletion delete the OAuth secret
- refresh persists rotated access token, refresh token, expiry, and account id
- refresh preserves the existing refresh token when the token endpoint does not rotate it
- concurrent refresh callers share one in-flight refresh and do not stale-write credentials
- account id is extracted from `https://api.openai.com/auth.chatgpt_account_id`
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
- no connector scopes in the Pi-compatible login flow
- no `originator=sprout` drift without an intentional design change
- no public `/v1/models` call for Codex OAuth providers
- no non-streaming-only completion path for Codex OAuth providers

## Implementation Slices

This is the expected implementation order after this spec is approved:

1. Add provider kind and credential-aware validation tests.
   - Focused verification: provider validation tests and typecheck.
2. Add deterministic OAuth secret references and storage tests.
   - Focused verification: secret-store tests.
3. Add OAuth authorize URL and PKCE/state tests.
   - Focused verification: auth URL/state tests.
4. Add callback listener tests and implementation.
   - Focused verification: callback method/path/state/timeout tests.
5. Add token exchange and initial credential persistence.
   - Focused verification: token exchange and redaction tests.
6. Add refresh persistence, refresh-token rotation handling, and per-provider singleflight.
   - Focused verification: concurrent refresh tests.
7. Add account-id extraction and decode-only token claim handling.
   - Focused verification: claim extraction tests with malformed and missing-claim tokens.
8. Add characterization tests around the current OpenAI adapter.
   - Focused verification: existing OpenAI adapter tests pass with no code movement.
9. Extract shared Responses request-building helpers.
   - Focused verification: characterization tests still pass.
10. Extract shared Responses parser helpers.
    - Focused verification: parser and existing adapter tests still pass.
11. Extract shared Responses stream accumulator.
    - Focused verification: streaming and tool-call tests still pass.
12. Add `OpenAICodexAdapter` using the OpenAI SDK with Codex base URL.
    - Focused verification: adapter URL/header tests.
13. Add Codex model endpoint parsing and cache-failure behavior.
    - Focused verification: model parser and model-cache tests.
14. Wire registry and settings control-plane OAuth operations.
    - Focused verification: registry and control-plane tests.
15. Update web provider settings.
    - Focused verification: web settings tests.
16. Update TUI provider settings.
    - Focused verification: TUI settings tests.
17. Update docs and run the full verification gate.
    - Final verification: `bun run precommit`, plus any targeted integration checks added during
      implementation.

## Open Decision

The only intentionally exposed design choice is the `originator` value. This spec uses
`originator=pi` because Pi and Serf converged there after URL fixes. Changing it to `sprout` would
be a product identity choice, not a refactor, and should require a fresh login-flow verification
pass before implementation.
