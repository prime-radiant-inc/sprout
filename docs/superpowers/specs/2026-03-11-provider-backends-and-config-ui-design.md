# Provider Backends And Configuration UI Design

## Summary

Sprout should move from env-driven provider bootstrapping and string-based model selection to a
persisted provider registry with explicit provider/model identity, OS-backed secret storage, and
full web/TUI configuration parity. This design adds first-class support for OpenRouter and LM
Studio without turning Sprout into a general plugin platform.

The clean version of this project is not "add two adapters and a form." The real work is creating
a settings/control-plane foundation that can own provider configuration, secrets, model discovery,
model selection, validation, and UI state across the host, web UI, and TUI.

## Goals

- Add OpenRouter as a first-class provider kind.
- Add LM Studio support through an `openai-compatible` provider kind.
- Make provider configuration persistent and machine-local using XDG config paths with a fallback
  to `~/.config/sprout`.
- Manage provider credentials through OS-backed secret storage instead of storing plaintext secrets
  in the main settings file.
- Replace string-inferred provider resolution with explicit `providerId + modelId` identity through
  runtime selection paths.
- Provide full configuration parity in both the web UI and the TUI.
- Preserve current env-based workflows through a one-time import path rather than forcing manual
  re-entry.

## Non-Goals

- Building a generic third-party provider plugin platform.
- Adding schema-driven form generation for arbitrary provider types.
- Preserving env vars and persisted settings as equal long-term sources of truth.
- Supporting every possible OpenAI-compatible server beyond the `openai-compatible` abstraction.
- Reworking the existing tier vocabulary (`best`, `balanced`, `fast`) beyond what is needed to make
  it provider-aware and deterministic.

## Current Constraints

The current architecture has three assumptions that block a solid implementation:

1. Providers are materialized from env vars in `src/llm/client.ts`.
2. Model selection infers provider identity from the model string in
   `src/agents/model-resolver.ts`.
3. The web and TUI surfaces only switch among already-known session-local model strings instead of
   editing durable settings.

Those assumptions work for a fixed set of providers with recognizable model prefixes. They do not
scale cleanly to OpenRouter, LM Studio, or any future deployment with multiple configured provider
instances.

## Architecture Overview

The solid version introduces five clear runtime units:

- `SettingsStore`
  - Loads and saves persisted Sprout settings.
  - Owns schema versioning, migration, XDG path resolution, atomic writes, and validation.
- `SecretStore`
  - Stores and retrieves provider credentials by reference.
  - Keeps plaintext secrets out of the main settings document.
- `ProviderRegistry`
  - Materializes enabled runtime provider instances from `SproutSettings + SecretStore`.
  - Validates provider configs and exposes provider descriptors to the rest of the host.
- `ModelCatalog`
  - Discovers and caches models per configured provider instance.
  - Produces a provider-aware catalog for UI display and model resolution.
- `SettingsControlPlane`
  - Exposes typed host commands and snapshot updates used by both the web UI and the TUI.

These units are deliberately narrower than a plugin framework. Sprout will support a fixed set of
provider kinds with a shared registry architecture, not a fully dynamic provider marketplace.

## Persisted Data Model

The top-level settings document lives at:

- `$XDG_CONFIG_HOME/sprout/settings.json`
- fallback: `~/.config/sprout/settings.json`

The document is versioned and contains provider configuration plus defaults/routing state.

```ts
interface SproutSettings {
	version: 1;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
	routing: RoutingConfig;
}

interface ProviderConfig {
	id: string;
	kind: "anthropic" | "openai" | "openai-compatible" | "openrouter" | "gemini";
	label: string;
	enabled: boolean;
	baseUrl?: string;
	nonSecretHeaders?: Record<string, string>;
	discoveryStrategy: "remote-only" | "manual-only" | "remote-with-manual";
	manualModels?: ManualModelConfig[];
	createdAt: string;
	updatedAt: string;
}

type Tier = "best" | "balanced" | "fast";

interface ManualModelConfig {
	id: string;
	label?: string;
	tierHint?: Tier;
	rank?: number;
}

interface DefaultsConfig {
	selection: DefaultSelection;
}

type DefaultSelection =
	| { kind: "none" }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; tier: Tier };

interface RoutingConfig {
	providerPriority: string[];
	tierOverrides: Partial<Record<Tier, string[]>>;
}

interface ModelRef {
	providerId: string;
	modelId: string;
}
```

Routing list invariants:

- `providerPriority` must contain every enabled provider exactly once
- disabled providers are removed from `providerPriority` until re-enabled
- `tierOverrides[tier]` may contain a subset of enabled providers with no duplicates
- create/import flows append newly enabled providers to the end of `providerPriority`
- delete/disable flows remove the provider from both `providerPriority` and all `tierOverrides`

`SettingsStore` recovery behavior is explicit:

- malformed JSON, unsupported schema versions, failed migrations, and partially written
  `settings.json` files are treated as unrecoverable load errors for that file
- on unrecoverable load error, Sprout preserves the bad file by renaming it to
  `settings.invalid.<timestamp>.json`
- after preserving the bad file, Sprout starts with an empty settings document and reports the
  recovery action clearly to the user
- after this recovery path, Sprout does not auto-import env settings during the same startup
- atomic writes use a temp-file-then-rename strategy so successful writes never leave a partial
  `settings.json` in place

The settings file stores no credentials, no secret values, and no persisted secret-presence flags.
Provider secret references are derived at runtime from provider IDs and the active secret-store
backend. `ProviderSecretRef` is a runtime shape, not a persisted field inside `settings.json`.

```ts
interface ProviderSecretRef {
	providerId: string;
	secretKind: "api-key";
	storageBackend: "macos-keychain" | "secret-service" | "memory";
	storageKey: string;
}
```

## Secret Management

The solid version manages credentials through a narrow `SecretStore` abstraction:

```ts
interface SecretStore {
	getSecret(ref: ProviderSecretRef): Promise<string | undefined>;
	setSecret(ref: ProviderSecretRef, value: string): Promise<void>;
	deleteSecret(ref: ProviderSecretRef): Promise<void>;
	hasSecret(ref: ProviderSecretRef): Promise<boolean>;
}
```

Backends for this version:

- `macos-keychain`
- `secret-service` for Linux environments
- `memory` for tests

Windows-native secret storage is out of scope for this version.

The main settings file stores no secret references or secret values. Secret presence is derived at
runtime and exposed through control-plane snapshots.
Provider metadata such as OpenRouter attribution headers must live in `nonSecretHeaders`, not in a
generic header bag that could accidentally carry credentials.

If a required secret backend is unavailable, Sprout still loads and edits settings, but providers
that require credentials cannot be enabled and the UI reports the unsupported secret backend
clearly. The solid version does not add a plaintext fallback store because that weakens the primary
design goal of managed credentials.

## Provider Kinds

Sprout supports these provider kinds:

- `anthropic`
- `openai`
- `gemini`
- `openrouter`
- `openai-compatible`

The separation between provider kind and provider instance is intentional. `kind` describes the
behavior contract; `id` identifies a specific configured provider. This allows multiple instances of
the same kind without leaking those assumptions into the rest of the runtime.

Examples:

- `openrouter-main` with kind `openrouter`
- `lmstudio-local` with kind `openai-compatible`
- `openai-prod` with kind `openai`

LM Studio is modeled as `openai-compatible` because the important distinction is transport and
configuration, not branding. OpenRouter is its own kind because it has distinct operational
semantics, model namespace behavior, and auth/header expectations that deserve explicit handling in
the registry, adapter layer, and UI.

Provider contract matrix:

| Kind | Required fields | Optional fields | Forbidden fields | Secret required | Base URL behavior | Discovery support |
|------|-----------------|-----------------|------------------|-----------------|-------------------|------------------|
| `anthropic` | `id`, `label`, `enabled` | `nonSecretHeaders` | `baseUrl` | yes | fixed by adapter | `remote-only`, `manual-only`, `remote-with-manual` |
| `openai` | `id`, `label`, `enabled` | `nonSecretHeaders` | `baseUrl` | yes | fixed by adapter | `remote-only`, `manual-only`, `remote-with-manual` |
| `gemini` | `id`, `label`, `enabled` | none | `baseUrl`, `nonSecretHeaders` | yes | fixed by adapter | `remote-only`, `manual-only`, `remote-with-manual` |
| `openrouter` | `id`, `label`, `enabled` | `nonSecretHeaders` | `baseUrl` | yes | fixed by adapter | `remote-only`, `manual-only`, `remote-with-manual` |
| `openai-compatible` | `id`, `label`, `enabled`, `baseUrl` | `nonSecretHeaders` | none | no | user-specified | `remote-only`, `manual-only`, `remote-with-manual` |

Additional provider rules:

- `openai-compatible` is the only kind that requires a user-editable `baseUrl`.
- `openai-compatible` may omit an API key for LM Studio-style local deployments.
- the host rejects `baseUrl` on provider kinds other than `openai-compatible`
- `gemini` does not expose arbitrary non-secret headers in the UI because this version does not
  need that surface for Gemini.
- `manual-only` is required when a provider cannot list models remotely but the user still wants it
  available for explicit selection.
- A provider can only be enabled if all required fields and required secrets are present.

## Runtime Registry And Model Catalog

`ProviderRegistry` is responsible for turning persisted config into runtime provider instances.

Responsibilities:

- load enabled providers from `SproutSettings`
- resolve required secrets through `SecretStore`
- validate config before adapter construction
- construct provider adapters
- expose provider descriptors to the host and control plane

`ProviderAdapter` is the runtime boundary between provider-specific behavior and the shared host
infrastructure.

```ts
interface ProviderAdapter {
	readonly providerId: string;
	readonly kind: ProviderConfig["kind"];
	listModels(): Promise<ProviderModel[]>;
	checkConnection(): Promise<{ ok: true } | { ok: false; message: string }>;
	complete(request: Request): Promise<Response>;
	stream(request: Request): AsyncIterable<StreamEvent>;
}
```

Adapter contract rules:

- `listModels()` returns provider-scoped model metadata for catalog construction
- `checkConnection()` performs the cheapest provider-valid health check and does not mutate catalog
  state
- `complete()` and `stream()` remain the request execution boundary already used by Sprout
- `ProviderRegistry` owns adapter construction; the UI and host control plane never instantiate
  adapters directly

`ModelCatalog` is responsible for provider-aware model discovery.

Responsibilities:

- fetch discovered models per enabled provider instance
- merge remote discovery results with manual model overrides when configured
- retain provider-scoped model metadata and refresh timestamps
- publish a normalized provider/model catalog for the host, web UI, and TUI

Discovery semantics are explicit:

- `remote-only`
  - only remote model discovery is used
- `manual-only`
  - only `manualModels` are exposed
- `remote-with-manual`
  - remote discovery is fetched first
  - `manualModels` are unioned in by model ID
  - manual entries fill gaps but do not replace remote-discovered metadata for the same model ID
  - manual `tierHint` and `rank` may fill missing values on a remote model but do not override
    remote-provided values

Catalog lifecycle is explicit:

- the catalog is in-memory for the lifetime of the host process and is not persisted to disk
- Sprout triggers a model refresh for each enabled provider during startup after the registry is
  materialized
- startup does not fail if refresh fails for one or more providers; failed providers remain visible
  with an error status and an empty or partial catalog entry
- explicit `ModelRef` selection is allowed when the provider exists and is enabled, even if the
  current catalog is empty or stale
- tier-based routing only uses models that are currently present in the in-memory catalog

Catalog membership and refresh semantics are explicit:

- enabled providers may have remote and/or manual models in the catalog
- disabled providers may still have catalog entries so the UI can display saved manual models and
  previously discovered models, but the resolver ignores them until re-enabled
- invalid providers keep status entries but do not expose remote-discovered catalog entries
- `refresh_provider_models` is valid for enabled providers and for `manual-only` providers whose
  catalog is rebuilt from `manualModels`
- `test_provider_connection` is valid whenever the provider config is sufficient to construct an
  adapter, even if the provider is currently disabled

Suggested runtime shapes:

```ts
interface RuntimeProvider {
	id: string;
	kind: ProviderConfig["kind"];
	label: string;
	enabled: boolean;
	adapter: ProviderAdapter;
}

interface ProviderModel {
	id: string;
	label: string;
	tierHint?: Tier;
	rank?: number;
	source: "remote" | "manual";
}

interface ProviderCatalogEntry {
	providerId: string;
	models: ProviderModel[];
	lastRefreshAt?: string;
}
```

This makes the model catalog provider-instance-aware everywhere instead of inferring provider
identity from model text.

Health ownership is explicit:

- `ProviderStatusSnapshot` is the only snapshot source for validation, connection, and catalog
  status
- `ProviderCatalogEntry` contains model data only
- every configured provider gets a `ProviderStatusSnapshot`
- disabled or invalid providers keep a status snapshot but expose an empty catalog entry until they
  can be refreshed or supply manual models

## Model Resolution

`src/agents/model-resolver.ts` should stop treating model selection as a bare string problem.

The resolver should accept:

- an explicit `ModelRef`, or
- a tier request (`best`, `balanced`, `fast`)
- a provider-aware catalog keyed by `providerId`
- routing/default settings from `SproutSettings`

Routing semantics are:

- `providerPriority` is the global fallback order.
- `tierOverrides[tier]` is an optional provider order for that specific tier.
- If `tierOverrides[tier]` exists, it is used first.
- If a tier override is absent, empty, or yields no matching model, the resolver falls back to the
  remaining providers in `providerPriority`.
- If neither list yields a matching enabled provider/model, model resolution fails clearly.

Resolver behavior:

1. If a request includes an explicit `ModelRef`, validate that the provider exists and is enabled.
   If the current catalog contains the model, use it. If the catalog is unavailable or stale, allow
   the explicit selection and let the provider request path surface any later runtime failure.
2. If a request asks for a tier, walk the configured provider priority for that tier and collect
   candidate models whose `tierHint` matches the requested tier.
3. Within a provider, sort candidates by descending `rank`, then ascending `id`, and choose the
   first result. Models without `tierHint` are never used for tier routing, but remain available for
   explicit selection.
4. `tierHint` comes from either the adapter/catalog or a provider-kind-specific classifier applied
   during catalog construction. Manual models may also provide `tierHint` and `rank`.
5. If a saved default points to a missing model, fail clearly with a provider-aware diagnostic.
6. Never infer provider identity from the model name in the core selection path.

Initial tier-classification rules are deterministic:

- adapters may emit `tierHint` and `rank` directly; when they do, those values win
- otherwise the catalog applies a name-based classifier during model refresh
- the initial classifier rules are:
  - `best`: model IDs containing `opus`, Gemini `pro`, or reasoning-family names such as `o1`,
    `o3`, or `o4`
  - `balanced`: model IDs containing `sonnet`, `gpt-4.1`, `gpt-4o`, or standalone `pro` for
    non-Gemini model families
  - `fast`: model IDs containing `haiku`, `mini`, `nano`, or `flash`
- models that match no rule remain explicit-select only
- classifier-assigned ranks are stable constants per matched bucket, so tie-breaking remains
  deterministic even when providers return models in different orders

The only compatibility exception is old session metadata that stores a raw model string. Old
sessions remain readable through a compatibility resolver, but new sessions should always persist
`providerId + modelId`.

## Selection Inputs

The solid version keeps the current high-level input surfaces, but makes their semantics explicit.

Agent-spec frontmatter:

- agent specs keep `model: string` for this version
- `best`, `balanced`, and `fast` continue to mean tier selection
- any other string is treated as an explicit model ID to be resolved across enabled providers
- explicit provider-qualified frontmatter such as `providerId:modelId` is out of scope for this
  version
- if a concrete model string matches multiple enabled providers, agent startup fails with a clear
  ambiguous-model error instead of guessing

Per-session interactive switching:

- `/model` remains the user-facing slash command and web/TUI session-level model switch action
- accepted inputs are:
  - `inherit`
  - `best`, `balanced`, `fast`
  - `providerId:modelId`
  - raw `modelId` as a compatibility input only when it resolves to exactly one enabled provider
- `inherit` clears the session override and returns selection precedence to agent spec and global
  defaults
- internal session/controller commands should move from raw string payloads to
  `{ selection: SessionModelSelection }`

Session protocol:

```ts
interface SwitchModelCommand {
	selection: SessionModelSelection;
}

interface SessionSelectionSnapshot {
	selection: SessionModelSelection;
	resolved?: ModelRef;
	source: "session" | "agent-spec" | "global-default" | "runtime-fallback";
}
```

- `switch_model` takes `SwitchModelCommand`
- raw slash-command input is parsed into `SessionModelSelection` before it reaches the controller
- both web and TUI should render `SessionSelectionSnapshot` as the authoritative per-session model
  state

## Session And Metadata Changes

Session state should move from `model: string` toward explicit model identity.

New persisted/runtime state:

```ts
type SessionModelSelection =
	| { kind: "inherit" }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; tier: Tier };
```

Session metadata should record the explicit provider/model identity for new sessions so resume is
deterministic even when multiple providers expose similar model names.

Selection precedence is explicit:

1. session selection if `kind` is `model` or `tier`
2. agent-spec model declaration for the current agent
3. global `DefaultsConfig.selection`
4. existing runtime fallback behavior when none of the above is set

`kind: "inherit"` means the session does not override agent-spec or global defaults.

Old sessions that only contain a raw model string should:

- load through a compatibility mapping path once
- resolve to a `ModelRef` if exactly one enabled provider currently exposes that raw model string
- fail resume with an explicit ambiguous-model error if multiple enabled providers expose the same
  raw model string
- fail resume with a missing-catalog error if the current catalog is empty or stale and no unique
  provider can be determined
- persist explicit identity on the next metadata save

This is the only backward-compatibility path required for the solid version.

Provider mutation semantics for active sessions:

- registry/settings mutations take effect for the next turn after the mutation is committed
- in-flight requests continue using the adapter instance they started with
- if a running or loaded session references a provider that is later disabled or deleted, the next
  attempted turn fails with a clear provider-unavailable error until the session selection is
  changed or reset to `inherit`
- provider reconfiguration does not rewrite active session history or stored selections; it only
  changes how future turns resolve and execute

## Host Control Plane

The host owns all settings mutations. Neither the web UI nor the TUI writes settings files or
touches secrets directly.

The control plane exposes:

- current settings snapshot
- provider catalog snapshot
- provider health/validation state
- mutation commands

Required host operations:

- `get_settings`
- `create_provider`
- `update_provider`
- `delete_provider`
- `set_provider_secret`
- `delete_provider_secret`
- `set_provider_enabled`
- `test_provider_connection`
- `refresh_provider_models`
- `set_default_selection`
- `set_provider_priority`
- `set_tier_priority`

The host should publish typed snapshot updates after each successful mutation so both frontends stay
in sync without inventing separate persistence logic.

The control plane should expose one shared snapshot shape:

```ts
interface SettingsSnapshot {
	settings: SproutSettings;
	providers: ProviderStatusSnapshot[];
	catalog: ProviderCatalogEntry[];
}

interface ProviderStatusSnapshot {
	providerId: string;
	hasSecret: boolean;
	validationErrors: string[];
	connectionStatus: "unknown" | "ok" | "error";
	connectionError?: string;
	catalogStatus: "never-loaded" | "current" | "stale" | "error";
	catalogError?: string;
}
```

Status transitions are explicit:

- `validationErrors.length > 0` means the provider is invalid regardless of connection or catalog
  state
- `connectionStatus` is updated by `test_provider_connection` and by `refresh_provider_models`
- `catalogStatus` is updated only by model refresh and by config/secret mutations that invalidate a
  previously current catalog
- `catalogStatus = "never-loaded"` before the first refresh attempt in the current process
- `catalogStatus = "current"` after a successful refresh in the current process
- `catalogStatus = "error"` after the most recent refresh fails
- `catalogStatus = "stale"` after provider settings or secrets change following a successful refresh

`test_provider_connection` semantics are explicit:

- it calls `ProviderAdapter.checkConnection()`
- it performs the cheapest provider-valid connectivity check available for that adapter
- it updates `connectionStatus` and `connectionError`, but does not populate or mutate the model
  catalog
- for `manual-only` providers, it still performs adapter-level connectivity/auth validation
- for secret-optional `openai-compatible` providers, success is based on the configured endpoint's
  response and does not require auth when the endpoint itself does not require auth

Mutation commands should return a consistent envelope:

```ts
type SettingsCommandResult =
	| { ok: true; snapshot: SettingsSnapshot }
	| { ok: false; code: string; message: string; fieldErrors?: Record<string, string> };
```

Command-result semantics are explicit:

- `ok: true` means the host processed the command and produced a new authoritative snapshot, even if
  provider status inside that snapshot is now `error`
- `test_provider_connection` and `refresh_provider_models` return `ok: true` for provider auth,
  timeout, or network failures because those outcomes are represented in provider status fields
- `ok: false` is reserved for malformed commands, validation failures that prevent the mutation from
  being applied, persistence failures, or other conditions where no authoritative post-command
  snapshot can be produced

Required command payloads:

| Command | Payload |
|---------|---------|
| `get_settings` | none |
| `create_provider` | `{ kind: ProviderConfig["kind"]; label: string; baseUrl?: string; nonSecretHeaders?: Record<string, string>; discoveryStrategy: ProviderConfig["discoveryStrategy"]; manualModels?: ManualModelConfig[] }` |
| `update_provider` | `{ providerId: string; patch: { label?: string; baseUrl?: string; nonSecretHeaders?: Record<string, string>; discoveryStrategy?: ProviderConfig["discoveryStrategy"]; manualModels?: ManualModelConfig[] } }` |
| `delete_provider` | `{ providerId: string }` |
| `set_provider_secret` | `{ providerId: string; secret: string }` |
| `delete_provider_secret` | `{ providerId: string }` |
| `set_provider_enabled` | `{ providerId: string; enabled: boolean }` |
| `test_provider_connection` | `{ providerId: string }` |
| `refresh_provider_models` | `{ providerId: string }` |
| `set_default_selection` | `{ selection: DefaultSelection }` |
| `set_provider_priority` | `{ providerIds: string[] }` |
| `set_tier_priority` | `{ tier: "best" \| "balanced" \| "fast"; providerIds: string[] }` |

Snapshot updates should use one event shape:

```ts
interface SettingsUpdatedEvent {
	kind: "settings_updated";
	data: SettingsSnapshot;
}
```

Mutation semantics are explicit:

- `providerId` is generated by the host at create time and is immutable afterward
- `create_provider` creates a new disabled provider record; enabling is always a separate step after
  validation and, when required, secret entry
- `update_provider` never changes provider identity, routing references, or secrets; the host
  updates `updatedAt` on every successful persisted change
- secrets are managed only through `set_provider_secret` and `delete_provider_secret`
- `create_provider` never writes secrets, and `update_provider` preserves the current secret state
- `delete_provider` deletes the provider secret, removes that provider from routing lists, and
  clears any default selection that points to it
- `set_default_selection` replaces the entire current default selection with exactly one of:
  `none`, explicit `model`, or tier-based `tier`
- historical session metadata is not rewritten on provider deletion; resumed sessions that reference
  a deleted provider fail with a clear missing-provider error

Transport integration should follow existing host ownership boundaries:

- the host owns `SettingsStore`, `SecretStore`, `ProviderRegistry`, and `ModelCatalog`
- the web server exposes these commands and snapshot updates over the existing web API/WebSocket
  surface
- the TUI calls the same command handlers in-process through the session/controller layer instead of
  inventing a second persistence path
- model-selection UI in both clients should migrate from raw model strings to `ModelRef` while still
  rendering readable model labels

This keeps one authority for settings while preserving the current split between host runtime and
presentation layers.

UI/control-plane action matrix:

| Action | Host command | Snapshot fields used |
|--------|--------------|----------------------|
| create provider | `create_provider` | `settings.providers`, `providers` |
| edit provider | `update_provider` | `settings.providers`, `providers` |
| enter/remove secret | `set_provider_secret`, `delete_provider_secret` | `providers.hasSecret`, `providers.validationErrors` |
| enable/disable provider | `set_provider_enabled` | `settings.providers`, `providers.validationErrors` |
| test connection | `test_provider_connection` | `providers.connectionStatus`, `providers.connectionError` |
| refresh models | `refresh_provider_models` | `catalog`, `providers.catalogStatus`, `providers.catalogError` |
| set default selection | `set_default_selection` | `settings.defaults` |
| reorder global priority | `set_provider_priority` | `settings.routing.providerPriority` |
| set tier override | `set_tier_priority` | `settings.routing.tierOverrides` |
| clear session override | session `switch_model` with `{ selection: { kind: "inherit" } }` | session model state |

## Web UI

The current web status bar model picker is too narrow for this project. The solid version adds a
real settings surface with three views:

- Provider list
  - configured providers
  - enabled state
  - provider kind
  - secret presence
  - last refresh
  - health state and error summary
- Provider editor
  - create/edit provider config
  - fields vary by provider kind
  - explicit secret entry flow
  - save/test/refresh actions
- Defaults and routing
  - choose a default selection: none, explicit model, or tier
  - configure global provider priority and per-tier overrides for tier-based routing
  - inspect discovered models

The web UI should use provider-kind-aware forms rather than a generalized dynamic form engine.
Sprout only has a small fixed set of provider kinds, and bespoke forms are simpler, clearer, and
less brittle here.

Required web states:

- loading: settings snapshot not yet available
- empty: no providers configured
- invalid: provider has validation errors
- unreachable: provider connection test or refresh failed
- stale: provider config changed since last successful catalog refresh

## TUI Parity

Full TUI parity means the TUI gets a settings mode, not just a larger model picker.

Required TUI capabilities:

- list providers and their health
- create/edit/delete providers
- enable/disable providers
- enter/remove secrets
- test provider connections
- refresh discovered models
- set default selection, global provider priority, and per-tier overrides

The TUI settings mode should use a simple list-detail flow:

- left pane or primary list for providers and routing sections
- detail pane or focused screen for editing the selected provider
- explicit action rows for enable, secret entry, connection test, and model refresh
- validation and health messages rendered inline with the selected provider/editor state

Required TUI states:

- loading: settings snapshot not yet available
- empty: no providers configured
- invalid: provider has validation errors
- unreachable: provider connection test or refresh failed
- stale: provider config changed since last successful catalog refresh

The TUI should reuse the same host snapshot types and mutation commands as the web UI. The layout
does not need to mirror the web UI, but the operation set must match.

## Validation And Failure Handling

Validation and runtime health need to be surfaced as distinct states.

Validation failures:

- missing required base URL
- malformed base URL
- missing required secret
- unsupported secret backend
- duplicate provider IDs
- invalid provider priority references

Runtime/provider failures:

- auth failure
- timeout
- network unavailability
- failed model discovery
- provider-specific API incompatibility

Model selection failures:

- requested `ModelRef` is missing or disabled
- explicit default selection points to a removed model
- no enabled provider can satisfy a requested tier

The host should tolerate partial failure. One broken provider must not block startup or make the
rest of the provider registry unavailable.

The UI should clearly distinguish:

- invalid config
- valid config but unreachable provider
- valid provider with stale or missing model catalog

## Migration Strategy

Persisted settings become canonical after migration. Env vars remain a bootstrap input, not an equal
ongoing configuration source.

Migration rules:

1. If `settings.json` exists, load it and ignore env-based provider creation.
2. If `settings.json` does not exist, inspect current env-based provider configuration and import it
   into a newly written settings file.
3. Imported providers get stable provider IDs and a canonical provider kind.
4. Secrets from env are written into the configured `SecretStore` only when a supported secret
   backend is available.
5. After first-run import, Sprout uses persisted settings as the source of truth.

Initial imported `providerPriority` is populated deterministically to preserve current behavior as
closely as possible:

- imported providers are ordered first by provider kind priority:
  `anthropic`, `openai`, `gemini`, `openrouter`, `openai-compatible`
- providers of the same kind keep their import order
- `tierOverrides` start empty on migration

If no supported secret backend is available during first-run import:

- provider metadata is still imported into `settings.json`
- providers that require secrets are created in a disabled state
- the host reports a validation error indicating that credential migration is blocked by the missing
  secret backend
- providers that do not require secrets, such as local `openai-compatible` LM Studio setups, may
  still import as enabled

This preserves current setups without keeping Sprout in a permanent split-brain config model.

## Testing Strategy

This feature spans persistence, runtime provider construction, protocol changes, and two frontends.
It needs broad automated coverage.

Unit tests:

- settings schema validation
- settings migration/import from env
- XDG path resolution
- secret reference generation and backend behavior
- provider registry validation/materialization
- provider-aware model resolver behavior
- session metadata compatibility mapping

Integration tests:

- first-run import from env into persisted settings
- provider create/edit/delete flows
- secret set/delete flows
- provider connection testing
- model refresh behavior
- explicit provider/model selection in new sessions
- old session resume compatibility

Web tests:

- provider list rendering
- provider editor validation
- secret presence and secret update flows
- defaults/routing controls
- provider health/error presentation

TUI tests:

- settings navigation
- provider edit flow
- secret entry/removal flow
- defaults/routing flow
- provider health/error presentation

Provider integration tests should use deterministic fake providers and fake secret stores rather
than relying only on live or VCR-backed network fixtures.

## Rollout Plan

The implementation should land in this order:

1. Shared Sprout paths utility and settings persistence layer.
2. `SecretStore` abstraction and production/test backends.
3. Provider registry and provider-aware model catalog.
4. Explicit `ModelRef` support through runtime/session state.
5. LM Studio support through `openai-compatible`.
6. OpenRouter support as a first-class provider kind.
7. Web settings UI.
8. TUI settings UI.
9. Migration cleanup, docs, and removal of obsolete env-only assumptions.

This order keeps UI work from outrunning the underlying architecture.

## Recommended Success Criteria

The solid version is complete when all of these are true:

- Sprout persists provider configuration under an XDG config path with a `~/.config/sprout`
  fallback.
- Provider secrets are managed through OS-backed secret storage and never written into
  `settings.json`.
- Runtime model selection uses explicit `providerId + modelId` identity for new sessions.
- LM Studio works through `openai-compatible`.
- OpenRouter works as a first-class provider kind.
- The web UI and TUI can both manage providers, credentials, defaults, routing, and model refresh.
- Existing env-based users migrate cleanly on first run.

## Design Summary

The core decision in this design is to build a provider registry and control plane, not a collection
of one-off adapter additions. That is the smallest architecture that still produces a solid result.

It keeps the system focused:

- fixed provider kinds instead of a plugin framework
- explicit provider/model identity instead of string inference
- persisted settings instead of env-only bootstrap
- OS-backed secrets instead of plaintext config
- one host-owned control plane shared by web and TUI

That foundation is what makes OpenRouter, LM Studio, and a real configuration UI fit Sprout
cleanly instead of becoming another layer of special cases.
