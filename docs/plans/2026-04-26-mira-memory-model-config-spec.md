# MIRA Memory Model Configuration Spec

Date: 2026-04-26

Status: draft for design review

Related docs:

- `docs/reference/mira-memory-architecture.md`
- `docs/plans/2026-04-25-mira-memory-port-design.md`
- `docs/plans/2026-04-25-mira-memory-port-execution-plan.md`
- `docs/plans/2026-04-25-mira-memory-port-completion-report.md`

## Problem

The MIRA memory port is implemented through Phase 10, but the memory LLM calls
do not yet have MIRA-style internal model routing. Sprout currently has global
`best`, `balanced`, and `fast` defaults stored in settings plus exact
session/agent model selection. Hidden memory work still inherits the
root/session model, resolves global `best`, or accepts manually injected
model/provider pairs in tests and low-level functions.

That is not production-ready. Memory extraction, summary, relationship
classification, consolidation, entity GC, and subcortical recall have different
cost/latency/quality envelopes. Operators need to choose an exact provider and
model for each memory purpose without changing the active user-facing agent
model.

The MIRA reference is explicit: internal LLM calls route by purpose key, not by
hardcoded model name or inherited user model. CodeMira reaches the same shape
with deployment-time environment variables for extraction, subcortical, and
consolidation. Sprout should keep its embedded SQLite/local-embedding design,
but it needs the same exact-purpose LLM routing discipline.

## Current State

Settings:

- `SproutSettings` only stores `defaults.best`, `defaults.balanced`, and
  `defaults.fast`.
- `SettingsStore.normalizeSettings()` drops unknown settings fields.
- `SettingsControlPlane` only supports `set_default_model`.
- `kernel/protocol.ts` only validates `set_default_model` for the three global
  tier slots.
- The web provider settings modal only renders `DefaultModelsPanel`.

Memory LLM calls:

- Session collapse summary uses the root agent resolved model/provider.
- Session collapse extraction uses the same root agent resolved model/provider.
- Learn-process memory extraction uses global `best`.
- Bus learn-signal extraction uses global `best` or an ad hoc first-model
  fallback in standalone bus infrastructure.
- Relationship classification, consolidation, and entity GC APIs accept
  explicit model/provider parameters, but there is no settings-backed resolver
  feeding them.
- Subcortical recall uses the active agent resolved model/provider when the
  agent frontmatter opts into `subcortical_recall`.

## Adversarial Review

This fix must avoid these failure modes:

1. **Silent fallback to global defaults.** If `memory.extraction` is unset,
   extraction must fail loudly. Reusing `balanced` or `best` would reproduce the
   current bug with a different name.
2. **Provider-only or model-only config.** Every memory purpose must store a
   full `{ providerId, modelId }` tuple. Bare model names are ambiguous.
3. **UI-only config with backend drift.** The web UI must use the same command
   and validation path as all other settings writes.
4. **Backend-only config with no operator surface.** A JSON-only setting is not
   enough; the web config UI must expose all memory purposes.
5. **Subcortical hidden cost regression.** Enabling `subcortical_recall` should
   use `memory.subcortical`, but it should still remain opt-in per agent.
6. **Accidental changes to user-facing model selection.** Global tiers,
   `/model`, agent frontmatter `model`, and the status bar are separate
   concerns. This work must not change their semantics.
7. **Embedding-provider confusion.** Local embeddings are not part of this
   setting. The production embedding path remains the fixed local
   `MongoDB/mdbr-leaf-ir` adapter with fail-fast behavior and no alternate
   production provider.
8. **Manual injection left as production path.** Low-level test helpers may pass
   explicit model/provider pairs, but production call sites must route through
   the memory-purpose resolver.
9. **Provider deletion leaves dangling memory models.** Deleting or disabling a
   provider must make affected memory settings invalid or remove them through
   the same policy as global defaults.
10. **Large generic abstraction.** Sprout only needs memory internal models now.
    Do not build a general internal-LLM framework for assessment, portrait,
    critic, or other MIRA features that Sprout has not implemented.

## Goals

- Add exact provider/model settings for every implemented hidden memory LLM
  purpose.
- Keep Sprout settings as the durable source of truth for all configured model
  choices.
- Allow environment variables only as explicit runtime overrides of stored
  settings, never as a hidden fallback or alternate persisted config store.
- Expose those settings in the web provider settings UI.
- Resolve memory models through one strict helper with no implicit fallbacks.
- Wire every production memory LLM call to that helper.
- Preserve the existing global model defaults and session/agent model behavior.
- Keep the implementation TypeScript/Bun-only and consistent with the current
  settings control plane.
- Add tests that prove memory calls use the configured memory-purpose models and
  fail loudly when missing or invalid.

## Non-Goals

- Do not add alternate embedding providers.
- Do not add Postgres or a daemon.
- Do not introduce MIRA user-model, portrait, assessment, critic, or synthesis
  pipelines.
- Do not make subcortical recall globally mandatory.
- Do not make maintenance apply mode automatically call consolidation/entity-GC
  LLMs without reviewed operator decisions.
- Do not change provider secret storage.
- Do not add compatibility migration logic for legacy memory users; there are no
  legacy memory users for this port.

## Memory Model Purposes

Add one exact model setting for each implemented hidden memory LLM call:

| Purpose | Config key | Used by | Expected model class |
| --- | --- | --- | --- |
| Segment summary | `summary` | Session collapse transcript summarization | high-quality, longer-context model |
| Memory extraction | `extraction` | Session collapse extraction, learn-process extraction, bus learn-signal extraction | high-quality structured-output model |
| Relationship classification | `relationship` | Memory link classifier | cheap deterministic classifier model |
| Consolidation review | `consolidation` | Optional consolidation decision generation | conservative structured-output model |
| Entity GC review | `entityGc` | Optional entity alias merge/reject review | cheap deterministic classifier model |
| Subcortical recall | `subcortical` | Opt-in recall query expansion/entity pinning | cheap low-latency model |

Do not add a separate `learn` memory model. The learn non-memory reasoner is not
a hidden memory LLM call; it may continue to use the existing global model
selection. Learn memory creation itself must use `memoryModels.extraction`.

Do not add an `archivist` memory model. Archivist is a real agent with a
frontmatter `model` and user-visible tool loop, not a hidden internal memory
call. It should continue to use normal agent model resolution unless separately
redesigned later.

## Settings Schema

Extend `SproutSettings` with a new top-level field:

```ts
export type MemoryModelPurpose =
	| "summary"
	| "extraction"
	| "relationship"
	| "consolidation"
	| "entityGc"
	| "subcortical";

export interface MemoryModelsConfig {
	summary?: ModelRef;
	extraction?: ModelRef;
	relationship?: ModelRef;
	consolidation?: ModelRef;
	entityGc?: ModelRef;
	subcortical?: ModelRef;
}

export interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
	memoryModels: MemoryModelsConfig;
}
```

`memoryModels` is optional at the JSON compatibility boundary but normalized to
`{}` in memory. Existing settings files should load after the schema bump, but
missing memory model purposes remain unset until the corresponding memory call
is resolved. Resolution falls back to that purpose's configured global tier
instead of copying tier values into `memoryModels`.

Schema version should bump from `2` to `3` because the normalized settings shape
changes. The migration is simple and local:

- v2 settings parse as before.
- v2 settings normalize to v3 with `memoryModels: {}`.
- v3 settings preserve `memoryModels`.
- Unknown `memoryModels` keys are dropped during settings-file normalization.
- Malformed `memoryModels` entries fail settings validation.

Because there are no legacy memory users, no memory data migration is required.

## Runtime and Upgrade Behavior

Startup must not require every memory model purpose to be configured. Missing
memory purposes are valid stored settings because some features are optional or
not invoked in every run. The strict rule applies at the moment a hidden memory
LLM call is needed.

Unset purpose fallback behavior:

| Purpose | Fallback tier | When neither exact model nor fallback tier is configured |
| --- | --- | --- |
| `summary` | `best` | Session collapse cannot summarize; collapse records/logs a visible memory-collapse failure and does not create a segment. |
| `extraction` | `balanced` | Session collapse and learn/bus memory creation fail before any memory write. Learn/bus paths emit warning/failure events. |
| `relationship` | `fast` | Relationship classification actions fail before LLM call and persist no links. Deterministic candidate discovery may still run. |
| `consolidation` | `balanced` | LLM-drafted consolidation review is unavailable. Reviewed JSON apply mode remains available because it does not call an LLM. |
| `entityGc` | `fast` | LLM-drafted entity-GC review is unavailable. Reviewed JSON apply mode remains available because it does not call an LLM. |
| `subcortical` | `fast` | Agents that opt into `subcortical_recall` fail recall with a clear configuration error. Agents without the opt-in are unaffected. |

The web settings UI should make unset purposes visually acceptable but explain
that the task will use its fallback tier. If the fallback tier is also missing,
the corresponding feature fails when invoked without blocking startup or
unrelated work.

## Strict Resolver

Add a memory-specific resolver next to the existing model resolver:

```ts
export function resolveMemoryModel(
	purpose: MemoryModelPurpose,
	settings: ResolverSettings,
	catalog: ProviderCatalogEntry[] | Map<string, ProviderModel[]>,
): ResolvedModel
```

`ResolverSettings` should gain:

```ts
memoryModels: MemoryModelsConfig;
```

Resolver behavior:

- If `settings.memoryModels[purpose]` is present, resolve that exact model.
- If `settings.memoryModels[purpose]` is missing, resolve the purpose's fallback
  tier: `summary` -> `best`, `extraction`/`consolidation` -> `balanced`, and
  `relationship`/`entityGc`/`subcortical` -> `fast`.
- If the referenced provider is unknown, throw.
- If the referenced provider is disabled, throw.
- If the provider catalog has loaded models and the model is absent, throw.
- If the provider catalog is empty, allow exact model refs the same way
  `resolveModel()` already allows exact refs for enabled providers. This keeps
  tests and openai-compatible/local endpoints usable before remote discovery.
- Never inspect current agent/session model.
- Never choose the first available provider/model.

The existing `resolveModel()` remains unchanged for user-facing agent/session
selection.

## Settings Control Plane

Add a new command:

```ts
type SettingsCommand =
	| ...
	| {
			kind: "set_memory_model";
			data: {
				purpose: MemoryModelPurpose;
				model?: ModelRef;
			};
	  };
```

Control-plane behavior:

- `set_memory_model` with `model` validates provider existence, enabled status,
  catalog availability, and model membership using the same policy as
  `set_default_model`.
- `set_memory_model` without `model` unsets that purpose.
- Field errors use keys like `memoryModels.extraction`.
- `getSelectionContext()` includes `memoryModels` so session/bootstrap/spawner
  wiring can pass one resolver settings object everywhere.
- `SettingsRuntimeSnapshot` includes active model env overrides, grouped into
  global defaults and memory models, for read-only UI display.
- Deleting or disabling a provider removes any global defaults and memory model
  settings that referenced that provider. This mirrors the current
  global-default behavior and avoids persisting dangling config after an
  explicit provider lifecycle action.

Protocol validation:

- `VALID_COMMAND_KINDS` and `SETTINGS_COMMAND_KINDS` include
  `set_memory_model`.
- `validateSettingsCommand()` accepts only `purpose` and `model`.
- `purpose` must be one of the six known purpose keys.
- `model` must be a full `{ providerId, modelId }` object when present.

Environment import:

- Support explicit memory model env vars only:
  - `SPROUT_MEMORY_SUMMARY_MODEL`
  - `SPROUT_MEMORY_EXTRACTION_MODEL`
  - `SPROUT_MEMORY_RELATIONSHIP_MODEL`
  - `SPROUT_MEMORY_CONSOLIDATION_MODEL`
  - `SPROUT_MEMORY_ENTITY_GC_MODEL`
  - `SPROUT_MEMORY_SUBCORTICAL_MODEL`
- Values use the existing `provider-id:model-id` format.
- These env vars are runtime overrides over `settings.memoryModels`; they are
  not written back into `sprout` settings.
- Do not infer any memory model from `SPROUT_DEFAULT_*_MODEL`.
- Malformed memory model env vars throw with a memory-specific error message.

Global model env vars:

- Existing `SPROUT_DEFAULT_BEST_MODEL`, `SPROUT_DEFAULT_BALANCED_MODEL`, and
  `SPROUT_DEFAULT_FAST_MODEL` should follow the same policy: they may override
  effective runtime defaults, but durable configured defaults live in
  `SproutSettings.defaults`.
- If the current bootstrap path seeds a missing settings file from env, keep
  that behavior only as first-run initialization. Once a settings file exists,
  env model vars are overlays, not persisted mutations.

Runtime override handling:

- Add a small `ModelConfigOverrides` overlay parsed from env during startup.
- Effective resolver settings are:
  stored settings plus explicit env overrides for matching keys.
- `SettingsSnapshot.settings` remains the stored settings object. Runtime code
  that resolves models uses the effective settings object with overrides
  applied.
- The overlay must be visible in `SettingsRuntimeSnapshot` so UIs can explain
  when a select's stored value differs from the effective runtime value.
- Settings commands always edit stored settings, not env overrides.
- A stored missing memory purpose plus an env override for that purpose is valid
  at runtime, but the web UI should still show the stored purpose as unset and
  mark the effective value as env-overridden.

Override validation:

- Env override values must parse as exact `{ providerId, modelId }` refs.
- Unknown providers fail startup/settings bootstrap with a clear env-var-specific
  error.
- Disabled providers fail startup/settings bootstrap with a clear env-var-specific
  error.
- Catalog membership is not a startup blocker. If a provider catalog is empty,
  the exact model ref is treated as an operator assertion and displayed with the
  raw model id. If a populated catalog does not contain the model id, the
  settings snapshot reports the model as catalog-missing and the resolver fails
  when that model is used. This rule applies equally to stored refs and
  env-overridden refs.
- Provider delete/disable commands must be rejected when an active env override
  still references that provider, because settings cannot remove environment
  state. The error should tell the operator which env var to unset first.
- Invalid env overrides are never ignored and never downgraded to stored
  settings.

Runtime snapshot contract:

```ts
export interface ModelConfigOverrides {
	defaults: Partial<Record<Tier, ModelConfigOverride>>;
	memoryModels: Partial<Record<MemoryModelPurpose, ModelConfigOverride>>;
}

export interface ModelConfigOverride {
	source: "env";
	envVar: string;
	model: ModelRef;
	catalogStatus: "not_loaded" | "matched" | "missing";
	displayLabel?: string;
	diagnostic?: string;
}

export interface SettingsRuntimeSnapshot {
	secretBackend: SecretBackendState;
	warnings: SettingsRuntimeWarning[];
	modelOverrides: ModelConfigOverrides;
}
```

`catalogStatus: "missing"` is a diagnostic state, not a fallback. Runtime
resolution for that model still fails until the stored setting or env override
is corrected or the catalog is refreshed with that model. Snapshot data contains
provider/model ids but no secrets, so it is safe to expose to every client that
can already view provider settings.

## Web Config UI

Add a `MemoryModelsPanel` sibling to `DefaultModelsPanel`.

Navigation:

- `ProviderList` gains a second settings-level item named `Memory models`.
- `ProviderSettingsPanel` gets a selected view key, for example
  `"memory-models"`.
- The initial view can remain `defaults` when providers exist.

Panel behavior:

- Render six selects, one for each memory purpose.
- Use the same enabled-provider/catalog option set as `DefaultModelsPanel`.
- Each select value is `providerId:modelId`.
- The empty option is `Not configured`.
- Changing a select sends `set_memory_model`.
- Field errors render under the corresponding purpose.
- If an env override is active for a purpose, show the stored setting in the
  select and display a non-editable note with the effective override value.
- If a stored or overridden model is catalog-missing, show a warning note for
  that row.
- The explanatory text should call these `Memory system models`, explain that
  exact model assignments override fallback tiers, and avoid reference-project
  terminology in the settings UI.
- If no enabled providers have refreshed models, show the same refresh guidance
  as the default-model panel.

Labels:

- `summary`: `Segment summary`
- `extraction`: `Memory extraction`
- `relationship`: `Relationship classifier`
- `consolidation`: `Consolidation reviewer`
- `entityGc`: `Entity GC reviewer`
- `subcortical`: `Subcortical recall`

The UI should not suggest vendor-specific default recommendations in code.
Operators can choose exact models; unset rows use the purpose fallback tier.

Also update `DefaultModelsPanel` to render env override notes for
`best`/`balanced`/`fast` if global default model env vars are active. The select
continues to edit the stored setting; the note explains the effective runtime
override.

## TUI Settings Surface

The user specifically requires the web config UI. The TUI should still avoid
becoming misleading once the settings schema changes.

Minimum acceptable TUI work:

- Display the configured memory models below global defaults.
- Display active env overrides for global and memory model settings as
  read-only effective values.
- Add command parsing for:
  `memory-model <purpose> <provider-id:model-id|none>`
- Emit `set_memory_model`.
- Validate purpose and provider/model membership with the current settings
  snapshot before sending.

This keeps the terminal settings panel consistent with the web control plane
without adding a second bespoke editor.

## Provider Lifecycle Policy

Provider ids are immutable in the current settings UI and control plane.
Operators can edit labels, URLs, headers, secrets, enabled state, and catalog
state, but not ids.

- Provider label changes do not affect model config.
- Provider delete removes stored defaults and stored memory models for that
  provider unless an active env override references it, in which case deletion
  is rejected until the env var is removed.
- Provider disable removes stored defaults and stored memory models for that
  provider unless an active env override references it, in which case disable is
  rejected until the env var is removed. This is intentionally a persistent
  settings edit, matching current global-default behavior; temporary provider
  outages should be handled by leaving the provider enabled and fixing the
  credential/network issue.
- Provider catalog refresh does not mutate stored model refs. If a refreshed
  catalog no longer contains a stored or env-overridden model, settings
  snapshots show a catalog-missing diagnostic and resolution fails loudly the
  next time that model is used.

## Production Call-Site Wiring

All production hidden memory LLM calls must receive a resolved memory-purpose
model from settings.

Session collapse:

- `createSessionController()` should resolve `memoryModels.summary` and
  `memoryModels.extraction` for `collapseMemory`.
- `collapseSessionToMemory()` should accept separate `summaryModel` and
  `extractionModel` resolved tuples instead of one inherited `model/provider`.
- Summary prompt call uses `summary`.
- Extraction prompt call uses `extraction`.

Learn process:

- Keep the non-memory improvement reasoner on the existing resolved global
  model.
- Resolve `memoryModels.extraction` separately for
  `extractAndApplyLearnMemories()`.
- If extraction is needed and unset, emit a clear learn warning/failure rather
  than writing a fallback memory.

Bus genome service:

- Replace `resolveModel("best", ...)` for learn-signal extraction with
  `resolveMemoryModel("extraction", ...)`.
- Delete the first-provider/default-tier fallback for memory extraction.
- If standalone bus infrastructure lacks settings-backed resolver data,
  extraction must fail clearly until settings are passed through. Do not guess.

Relationship classification:

- Add the minimal production wrapper in `src/genome/linking.ts` or the existing
  caller that owns candidate discovery and link persistence. It resolves
  `memoryModels.relationship`, calls `classifyMemoryRelationship()`, and passes
  the classified results to `persistMemoryRelationships()`.
- Tests may keep low-level explicit model/provider injection, but production
  code should not manually pass arbitrary current-agent model values.

Maintenance LLM review:

- Keep `src/genome/consolidation.ts` and `src/genome/entity-gc.ts` as low-level
  pure request/parse/apply modules that accept explicit model/provider inputs
  for tests.
- Production orchestration belongs in `src/genome/maintenance.ts` and
  `src/host/cli-genome.ts`. If an operator command asks Sprout to draft
  decisions with an LLM, that wrapper resolves `memoryModels.consolidation` or
  `memoryModels.entityGc` before calling the low-level request function.
- Existing dry-run/apply maintenance with reviewed JSON decisions remains valid
  and should not require LLM config unless it actually asks the LLM to draft
  decisions.

Subcortical recall:

- Keep `subcortical_recall` as an agent-level opt-in.
- When enabled, resolve `memoryModels.subcortical` or the `fast` fallback tier.
- The active agent model is not used for the subcortical pre-pass.
- Missing `memoryModels.subcortical` and missing `fast` should fail clearly
  during recall for that agent, not silently skip the pre-pass.

## Observability

Existing LLM events already carry provider/model. Memory-purpose routing should
make failures and usage easy to diagnose.

Required labels:

- Error messages include the memory purpose key.
- Every hidden memory LLM request path that already emits LLM metadata must
  include a stable purpose label.
- Required labels are:
  - `memory.summary`
  - `memory.extraction`
  - `memory.relationship`
  - `memory.consolidation`
  - `memory.entityGc`
  - `memory.subcortical`
- Tests assert the provider/model seen by fake clients for each purpose.

Do not add a new metrics subsystem as part of this fix.

## Documentation Updates

- Update the provider settings UI copy to explain that stored settings are the
  durable model config and env vars are runtime overrides.
- Update CLI/settings help for `memory-model`.
- Update the MIRA memory completion report or status tracker with this
  production-readiness fix once implemented.
- Document the six memory model env vars in the same location as existing
  `SPROUT_DEFAULT_*_MODEL` variables.
- Include the unset-purpose runtime behavior table in operator-facing docs or
  help text so configuration failures are actionable.

## Test Plan

Settings/schema:

- v2 settings normalize to v3 with `memoryModels: {}`.
- v3 settings preserve all six memory purposes.
- Unknown memory purpose keys are dropped during settings-file normalization and
  rejected by command/protocol validation.
- Disabled/unknown providers in `memoryModels` fail settings-file validation.
- Provider deletion and provider disable remove matching memory model entries.
- Env override parsing handles all six explicit memory vars and does not infer
  from global defaults.
- Env model overrides affect effective resolver settings without mutating stored
  `SproutSettings`.
- Env overrides with unknown or disabled providers fail startup/settings
  bootstrap with the env var name in the error.
- Env overrides with catalog-missing model ids appear in runtime diagnostics and
  fail at resolution time.
- Existing settings files plus env model vars do not persist env values back to
  disk.
- Missing settings files may still be initialized from existing
  `SPROUT_DEFAULT_*_MODEL` env vars as first-run seed behavior.
- Runtime snapshots expose active model overrides for UI display.
- Provider delete/disable rejects when active env overrides reference the
  provider.
- Catalog refresh that removes a configured model does not mutate settings but
  makes the affected stored/env model visibly catalog-missing and unresolved.

Resolver:

- Each purpose resolves its configured provider/model.
- Missing purpose throws.
- Disabled provider throws.
- Unknown provider throws.
- Missing catalog model throws when catalog is populated.
- Empty catalog allows exact model refs for enabled providers.
- Global defaults are ignored even when populated.

Control plane/protocol:

- `set_memory_model` validates payload shape.
- `set_memory_model` persists and unsets each purpose.
- Field errors point at `memoryModels.<purpose>`.
- `getSelectionContext()` includes memory models.

Web UI:

- Provider settings sidebar renders `Memory models`.
- Panel renders six labeled selects.
- Selecting a model emits `set_memory_model` with exact provider/model.
- Selecting empty emits `set_memory_model` without model.
- Field errors render for memory purposes.
- Active env overrides render as effective-value notes without changing the
  stored select value.
- Catalog-missing stored and env-overridden models render warning notes.
- Existing default-model tests remain green.

TUI:

- Settings panel displays memory model config.
- `memory-model <purpose> <provider:model>` emits `set_memory_model`.
- `memory-model <purpose> none` unsets.
- Invalid purpose/model/provider returns a local command error.

Memory call sites:

- Session collapse summary and extraction use distinct configured models.
- Learn memory extraction uses `memoryModels.extraction` while non-memory learn
  reasoning still uses global model selection.
- Bus learn-signal extraction uses `memoryModels.extraction` and has no
  first-provider fallback.
- Subcortical recall uses `memoryModels.subcortical`.
- Relationship/consolidation/entity-GC production wrappers use their purpose
  models.
- Missing configured purpose causes a clear failure and no fallback write.
- Hidden memory LLM requests that emit metadata include the expected purpose
  label.

## Acceptance Criteria

- Operators can set, unset, and view all six memory model purposes in the web
  config UI.
- Stored model configuration lives in `SproutSettings`; env vars only override
  effective runtime model choices and are visible as overrides.
- Unset optional memory purposes and catalog-missing models are visible in
  settings diagnostics with actionable remediation text.
- Every hidden memory LLM call uses the configured exact purpose model.
- No hidden memory LLM call inherits the active agent/session model.
- No hidden memory LLM call falls back to global `best`, `balanced`, or `fast`.
- Existing user-facing model selection still works unchanged.
- Local embeddings remain fixed and fail-fast.
- Targeted tests, `bun run typecheck`, and `bun run check` pass.

## Implementation Staging

The implementation should land in small verified slices:

1. Schema/types/migration: add `memoryModels`, schema v3 normalization, and
   settings validation tests.
2. Env override layer: parse global and memory model override env vars, validate
   centrally, expose `SettingsRuntimeSnapshot.modelOverrides`, and preserve
   first-run env seeding semantics.
3. Resolver: add `resolveMemoryModel()` and effective resolver settings with
   focused tests proving no default-tier fallback.
4. Control plane/protocol: add `set_memory_model`, provider lifecycle cleanup,
   env-override delete/disable guards, and protocol validation tests.
5. Web/TUI surfaces: add memory-model configuration UI and override display
   notes.
6. Production call-site wiring: session collapse, learn, bus, subcortical,
   relationship, consolidation, and entity-GC wrappers.
7. Integration/docs cleanup: targeted memory-call tests, operator docs/status
   updates, typecheck, check, and relevant unit suites.

## Implementation Risks

- The most likely integration bug is missing resolver settings in standalone bus
  infrastructure. The correct failure mode is loud failure, not first-provider
  guessing.
- Session collapse currently has a compact single `model/provider` input; split
  summary and extraction carefully to avoid swapping them.
- Web settings tests construct snapshots manually; helper fixtures need
  `memoryModels`.
- Schema migration must preserve existing provider/default config while adding
  empty memory config.
- TUI and web command validation must share the same purpose set to avoid drift.
