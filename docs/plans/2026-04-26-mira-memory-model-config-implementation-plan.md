# MIRA Memory Model Configuration Implementation Plan

Date: 2026-04-26

Spec: `docs/plans/2026-04-26-mira-memory-model-config-spec.md`

Roborev design review:

- Jobs 284 and 285: failed on env/runtime and rollout ambiguity.
- Job 286: failed on catalog-refresh semantics.
- Job 287: passed after the spec made catalog-missing model refs diagnostic and
  call-time failures.

## Objective

Make every hidden MIRA memory LLM call resolve an exact provider/model from
Sprout settings, with env vars only as explicit runtime overrides. Expose stored
memory model settings and env overrides in the web config UI. Preserve existing
global model defaults, session model selection, local embeddings, and no-fallback
memory behavior.

## Ground Rules

- No hidden fallback from memory purposes to `best`, `balanced`, `fast`, current
  agent model, first provider, or first model.
- Stored model config lives in `SproutSettings`.
- Env model vars are overlays only after a settings file exists.
- Missing memory purposes do not block startup; the corresponding feature fails
  clearly when invoked.
- Local embeddings stay fixed to the existing local adapter.
- Keep low-level memory modules testable with explicit model/provider injection,
  but route production call sites through the settings-backed resolver.

## Phase 1: Settings Schema and Purpose Types

Primary files:

- `src/shared/provider-settings.ts`
- `src/host/settings/types.ts`
- `src/host/settings/store.ts`
- `test/host/settings-store.test.ts`
- `test/host/settings-validation.test.ts`
- `test/helpers/provider-settings.ts`

Tasks:

- Bump `SETTINGS_SCHEMA_VERSION` from `2` to `3`.
- Add `MemoryModelPurpose`, `MEMORY_MODEL_PURPOSES`, `MEMORY_MODEL_LABELS`, and
  `MemoryModelsConfig`.
- Add `memoryModels` to `SproutSettings` and `createEmptySettings()`.
- Make `SettingsStore` parse v2 settings into v3 by preserving providers and
  defaults and adding `memoryModels: {}`.
- Normalize v3 `memoryModels` by preserving only known purpose keys.
- Validate malformed memory model refs and disabled/unknown providers in stored
  settings.
- Update test fixtures to include `memoryModels`.

Tests:

- v2 settings load as v3 with empty `memoryModels`.
- v3 settings preserve all six purpose refs.
- Unknown purpose keys are dropped during file normalization.
- Disabled/unknown stored memory providers fail settings-file validation.
- Existing default-model validation tests still pass.

Commit target:

- `feat: add memory model settings schema`

## Phase 2: Env Override Overlay

Primary files:

- `src/host/settings/env-import.ts`
- `src/host/settings/control-plane.ts`
- `src/host/cli-bootstrap.ts`
- New `src/host/settings/model-overrides.ts`
- `test/host/settings-env-import.test.ts`
- `test/host/settings-control-plane.test.ts`
- `test/host/cli-bootstrap.test.ts`

Tasks:

- Keep `importSettingsFromEnv()` as first-run settings seeding only.
- Add runtime-only parsing for:
  `SPROUT_DEFAULT_BEST_MODEL`,
  `SPROUT_DEFAULT_BALANCED_MODEL`,
  `SPROUT_DEFAULT_FAST_MODEL`,
  `SPROUT_MEMORY_SUMMARY_MODEL`,
  `SPROUT_MEMORY_EXTRACTION_MODEL`,
  `SPROUT_MEMORY_RELATIONSHIP_MODEL`,
  `SPROUT_MEMORY_CONSOLIDATION_MODEL`,
  `SPROUT_MEMORY_ENTITY_GC_MODEL`,
  `SPROUT_MEMORY_SUBCORTICAL_MODEL`.
- Represent parsed overrides as `ModelConfigOverrides`.
- Validate override syntax, unknown providers, and disabled providers during
  bootstrap.
- Treat catalog-missing model IDs as diagnostics, not startup blockers.
- Add `SettingsRuntimeSnapshot.modelOverrides`.
- Add helpers to build effective resolver settings from stored settings plus
  overrides.
- Reject provider delete/disable when an active env override references that
  provider.
- Ensure settings commands mutate stored settings only.

Tests:

- Existing settings plus env vars do not persist env values to disk.
- Missing settings file still supports first-run `SPROUT_DEFAULT_*_MODEL`
  seeding.
- Unknown/disabled provider env override fails bootstrap with env var name.
- Catalog-missing env override appears in runtime snapshot diagnostics.
- Provider delete/disable is rejected when an env override references it.
- `SettingsSnapshot.settings` remains stored config; resolver context uses
  effective config.

Commit target:

- `feat: add model env override overlay`

## Phase 3: Resolver Support

Primary files:

- `src/agents/model-resolver.ts`
- `src/host/session-selection.ts`
- `src/host/cli-bootstrap.ts`
- `test/agents/model-resolver.test.ts`
- `test/host/session-selection.test.ts`
- `test/host/cli-bootstrap.test.ts`

Tasks:

- Add `memoryModels` to `ResolverSettings`.
- Update `createResolverSettings()` to accept defaults and memory models.
- Add `resolveMemoryModel(purpose, settings, catalog)`.
- Ensure `resolveMemoryModel()` never consults global defaults.
- Ensure `resolveModel()` behavior for user-facing models is unchanged.
- Update session/bootstrap resolver context to carry effective memory models.
- Update child/spawner resolver settings types where they cross process
  boundaries.

Tests:

- Every memory purpose resolves its configured provider/model.
- Missing purpose throws `No memory '<purpose>' model is configured`.
- Unknown/disabled provider throws.
- Populated catalog missing model throws at resolution time.
- Empty catalog allows exact model refs.
- Populated global defaults do not affect memory resolution.
- Existing `/model`, tier, and exact-session selection tests remain unchanged.

Commit target:

- `feat: resolve memory models by purpose`

## Phase 4: Settings Commands and UI Surfaces

Primary files:

- `src/host/settings/control-plane.ts`
- `src/kernel/protocol.ts`
- `src/tui/settings-panel.tsx`
- `web/src/components/settings/ProviderList.tsx`
- `web/src/components/settings/ProviderSettingsPanel.tsx`
- `web/src/components/settings/DefaultModelsPanel.tsx`
- New `web/src/components/settings/MemoryModelsPanel.tsx`
- `web/src/components/__tests__/provider-settings.test.tsx`
- `test/tui/settings-panel.test.tsx`

Tasks:

- Add `set_memory_model` to `SettingsCommand`.
- Add protocol validation for `purpose` and optional exact `model`.
- Add control-plane persistence, unset behavior, field errors, and provider
  lifecycle cleanup for stored memory models.
- Add web sidebar item `Memory models`.
- Add six memory model selects and shared option formatting.
- Show env override notes for global defaults and memory models.
- Show catalog-missing warnings for stored and env-overridden refs.
- Add TUI display of memory model settings and env overrides.
- Add TUI command:
  `memory-model <purpose> <provider-id:model-id|none>`.

Tests:

- Protocol rejects unknown purpose and malformed model refs.
- Control plane sets/unsets every memory purpose.
- Control plane returns `memoryModels.<purpose>` field errors.
- Web UI emits `set_memory_model`.
- Web UI displays env override notes without mutating stored select values.
- Web UI displays catalog-missing warnings.
- TUI command emits `set_memory_model` and rejects invalid inputs.

Commit target:

- `feat: expose memory model settings`

## Phase 5: Runtime Plumbing and Bus Configuration

Primary files:

- `src/host/cli-bootstrap.ts`
- `src/host/cli-shared.ts`
- `src/host/session-controller.ts`
- `src/agents/factory.ts`
- `src/bus/genome-service.ts`
- `src/bus/spawner.ts`
- `src/bus/agent-process.ts`
- `test/host/cli-bootstrap.test.ts`
- `test/bus/genome-service.test.ts`
- `test/bus/spawner.test.ts`
- `test/bus/agent-process.test.ts`

Tasks:

- Build one effective resolver settings object in bootstrap and pass it to
  `SessionController`, agent factory, learn process, spawner, and bus genome
  service.
- Update settings-change handling to rebuild effective resolver settings after
  stored settings or env-visible catalog diagnostics change.
- Add a runtime configuration update path for the already-started
  `GenomeMutationService`, because bus infrastructure starts before settings are
  loaded.
- Remove `GenomeMutationService` first-provider/default-tier fallback for memory
  extraction.
- Ensure child agent processes receive effective memory model settings.

Tests:

- Bootstrap passes effective stored-plus-env resolver settings to the controller.
- Updating settings updates effective resolver settings for subsequent work.
- Bus genome service fails loud when extraction is invoked with no configured
  `memoryModels.extraction`.
- Bus genome service uses configured `memoryModels.extraction`.
- Child process start messages preserve memory model settings.
- No tests rely on first-provider memory fallback.

Commit target:

- `feat: pass memory model config through runtime`

## Phase 6: Memory Call-Site Wiring

Primary files:

- `src/core/session-collapse.ts`
- `src/host/session-controller.ts`
- `src/learn/learn-process.ts`
- `src/bus/genome-service.ts`
- `src/genome/recall.ts`
- `src/genome/subcortical.ts`
- `src/genome/linking.ts`
- `src/genome/relationship-classifier.ts`
- `src/genome/maintenance.ts`
- `src/host/cli-genome.ts`
- `test/host/session-collapse.test.ts`
- `test/host/session-controller.test.ts`
- `test/learn/learn-process.test.ts`
- `test/bus/genome-service.test.ts`
- `test/genome/recall.test.ts`
- `test/genome/subcortical.test.ts`
- `test/genome/linking.test.ts`
- `test/genome/maintenance.test.ts`

Tasks:

- Split session collapse input into `summaryModel` and `extractionModel`.
- Resolve and use `memoryModels.summary` for segment summaries.
- Resolve and use `memoryModels.extraction` for collapse extraction,
  learn-process memory extraction, and bus learn-signal extraction.
- Keep the learn non-memory reasoner on its existing global model behavior.
- Resolve and use `memoryModels.subcortical` only when agent frontmatter opts
  into `subcortical_recall`.
- Add a minimal relationship production wrapper around candidate discovery,
  classification, and link persistence that resolves `memoryModels.relationship`.
- Keep low-level relationship/consolidation/entity-GC functions injectable for
  tests.
- Add maintenance/CLI wrapper behavior for LLM-drafted consolidation/entity-GC
  decisions if such drafting is exposed; reviewed JSON apply remains model-free.
- Make missing-purpose failures visible and non-fallback.

Tests:

- Session collapse sends summary and extraction requests to different configured
  models.
- Missing `summary` prevents segment creation and reports a memory-collapse
  failure.
- Missing `extraction` prevents memory writes.
- Learn extraction uses `memoryModels.extraction`; learn reasoner does not.
- Bus extraction uses `memoryModels.extraction`.
- Subcortical pre-pass uses `memoryModels.subcortical`.
- Relationship wrapper uses `memoryModels.relationship`.
- Consolidation/entity-GC drafting, if exposed, uses their configured purposes.

Commit target:

- `feat: route memory llm calls by purpose`

## Phase 7: Purpose Labels and Diagnostics

Primary files:

- `src/llm/types.ts`
- `src/llm/logging-middleware.ts`
- Memory call-site files from Phase 6
- `test/llm/logging-middleware.test.ts`
- Targeted memory call-site tests

Tasks:

- Add internal request metadata, for example
  `metadata?: { purpose?: string }`, to `llm/types.ts`.
- Log `purpose` in `loggingMiddleware` when present.
- Set required labels on hidden memory LLM requests:
  `memory.summary`,
  `memory.extraction`,
  `memory.relationship`,
  `memory.consolidation`,
  `memory.entityGc`,
  `memory.subcortical`.
- Keep provider adapters unaware of metadata beyond receiving the typed request.

Tests:

- Logging middleware includes purpose on success and failure.
- Each memory LLM call-site test asserts the expected purpose metadata.
- Existing agent LLM logging remains unchanged when purpose is absent.

Commit target:

- `feat: label memory llm requests`

## Phase 8: Docs, Help, and Final Verification

Primary files:

- `docs/plans/2026-04-25-mira-memory-port-completion-report.md`
- `docs/plans/2026-04-25-mira-memory-port-status.md`
- `src/host/cli-parse.ts`
- `src/tui/settings-panel.tsx`
- Web/TUI settings tests

Tasks:

- Document the six memory model env vars and runtime override behavior.
- Update CLI/TUI settings help for `memory-model`.
- Update the MIRA memory status/completion docs to record that memory model
  configuration is now production-gated through settings.
- Run focused tests from earlier phases.
- Run `bun run typecheck`.
- Run `bun run check`.
- Run `bun run precommit` if the focused suites and typecheck are clean.
- Run roborev on each implementation commit or at least each logical phase
  commit, consistent with the existing review loop.

Final verification target:

- `bun test test/host/settings-store.test.ts test/host/settings-validation.test.ts test/host/settings-control-plane.test.ts test/host/cli-bootstrap.test.ts test/agents/model-resolver.test.ts`
- `bun test test/tui/settings-panel.test.tsx web/src/components/__tests__/provider-settings.test.tsx`
- `bun test test/host/session-collapse.test.ts test/host/session-controller.test.ts test/learn/learn-process.test.ts test/bus/genome-service.test.ts`
- `bun test test/genome/subcortical.test.ts test/genome/recall.test.ts test/genome/linking.test.ts test/genome/maintenance.test.ts test/llm/logging-middleware.test.ts`
- `bun run typecheck`
- `bun run check`
- `bun run precommit`

Commit target:

- `docs: document memory model settings rollout`

## Self-Review Notes

- The highest-risk seam is bus startup ordering. `startBusInfrastructure()`
  currently creates `GenomeMutationService` before settings are loaded, so the
  implementation must add a safe update path rather than reintroducing a
  fallback.
- The second-highest-risk seam is env overrides. Keep parsing, validation, and
  effective-settings construction centralized; do not duplicate merge logic in
  bootstrap, control plane, web UI, and resolver.
- The LLM request type currently has no purpose metadata. Add a small internal
  metadata field instead of inventing separate logging side channels.
- Provider disable currently removes global defaults. Matching that behavior for
  memory models is intentionally simple, but the UI copy should make it clear
  that disable is a persistent settings edit.
- Do not let optional unset purposes turn into startup blockers. They should be
  visible and actionable in settings, then fail only when the corresponding
  feature tries to call an LLM.

