# Provider Backends And Configuration UI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build persisted provider configuration, provider-aware model selection, OpenRouter and LM Studio support, and full web/TUI settings parity without breaking current env-based workflows.

**Architecture:** Add a host-owned settings/control-plane layer that materializes runtime providers and model catalogs from persisted XDG-backed settings plus secret storage. Then thread explicit selection types through model resolution, session protocol, web/TUI transport, and operator-facing settings surfaces instead of passing raw model strings around.

**Tech Stack:** TypeScript on Bun, Bun test runner, Ink TUI, React web UI, Bun WebSocket server, YAML frontmatter agent specs, Bun/Node filesystem APIs, Biome.

**Spec:** `docs/superpowers/specs/2026-03-11-provider-backends-and-config-ui-design.md`

---

## File Structure

**Create**

- `src/host/settings/types.ts` — persisted settings types, runtime DTOs, selection types, validation helpers.
- `src/host/settings/paths.ts` — XDG config path resolution and settings file naming.
- `src/host/settings/store.ts` — load/save/migrate/recover `settings.json` with atomic writes.
- `src/host/settings/secret-store.ts` — `SecretStore` interface plus macOS/Linux/test backends.
- `src/host/settings/env-import.ts` — env-to-settings import and deterministic provider priority bootstrapping.
- `src/host/settings/control-plane.ts` — host commands/results/snapshot assembly for settings mutations.
- `src/llm/provider-registry.ts` — config validation and adapter construction from persisted settings.
- `src/llm/model-catalog.ts` — provider-aware model discovery, deterministic tier hints, refresh state.
- `src/host/session-selection.ts` — parsing, normalizing, and resolving session/agent/global model selection.
- `test/host/settings-paths.test.ts`
- `test/host/settings-validation.test.ts`
- `test/host/settings-store.test.ts`
- `test/host/secret-store.test.ts`
- `test/host/settings-env-import.test.ts`
- `test/host/settings-control-plane.test.ts`
- `test/llm/provider-registry.test.ts`
- `test/llm/model-catalog.test.ts`
- `test/host/session-selection.test.ts`
- `test/host/session-controller-selection.test.ts`
- `test/host/session-resume-selection.test.ts`
- `web/src/components/settings/ProviderSettingsPanel.tsx`
- `web/src/components/settings/ProviderList.tsx`
- `web/src/components/settings/ProviderEditor.tsx`
- `web/src/components/settings/DefaultsPanel.tsx`
- `web/src/components/settings/ProviderSettingsPanel.module.css`
- `web/src/components/__tests__/provider-settings.test.tsx`
- `web/src/App.test.tsx`
- `src/tui/settings-panel.tsx`
- `src/tui/provider-settings-editor.tsx`
- `test/tui/settings-panel.test.tsx`
- `test/tui/provider-settings-editor.test.tsx`

**Modify**

- `src/llm/types.ts` — provider adapter contract additions.
- `src/llm/client.ts` — registry-backed provider construction and model listing integration.
- `src/llm/openai.ts`
- `src/llm/anthropic.ts`
- `src/llm/gemini.ts`
- `src/agents/model-resolver.ts` — move from raw string/provider inference to provider-aware resolution.
- `src/kernel/types.ts` — session command payloads and agent-spec model contract updates.
- `src/agents/markdown-loader.ts` — preserve agent `model: string` semantics under the new resolver.
- `src/shared/slash-commands.ts` — parse `inherit`, tier names, `providerId:modelId`, and raw compatibility input.
- `src/host/cli.ts`
- `src/host/cli-bootstrap.ts` — load settings, registry, catalog, and settings control plane before controller boot.
- `src/host/cli-interactive.ts`
- `src/host/cli-resume.ts`
- `src/host/session-controller-commands.ts`
- `src/host/session-controller.ts`
- `src/host/session-state.ts`
- `src/host/session-metadata.ts`
- `src/kernel/protocol.ts` — browser snapshot/command transport for settings and session selection.
- `src/web/server.ts` — settings endpoints/WebSocket snapshot wiring.
- `src/agents/factory.ts`
- `src/agents/agent.ts`
- `web/src/hooks/useEvents.ts`
- `web/src/App.tsx`
- `web/src/components/StatusBar.tsx`
- `src/tui/app.tsx`
- `src/tui/model-picker.tsx`
- `src/tui/status-bar.tsx`
- `src/tui/slash-commands.ts`
- `test/host/cli.test.ts`
- `test/host/cli-interactive.test.ts`
- `test/host/cli-resume.test.ts`
- `test/web/protocol.test.ts`
- existing focused tests under `test/host`, `test/llm`, `test/agents`, `test/web`, `test/tui`, and `web/src/hooks`.

## Chunk 1: Settings Foundation

### Task 1: Add persisted settings types and XDG path helpers

**Files:**
- Create: `src/host/settings/types.ts`
- Create: `src/host/settings/paths.ts`
- Test: `test/host/settings-paths.test.ts`
- Test: `test/host/settings-validation.test.ts`
- Modify: `src/kernel/types.ts`

- [ ] **Step 1: Write failing settings-path tests**

Add coverage for:
- `$XDG_CONFIG_HOME/sprout/settings.json`
- `~/.config/sprout/settings.json` fallback
- settings-type/routing invariants rejecting duplicates / missing enabled providers
- deterministic invalid-file rename pattern

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/settings-paths.test.ts test/host/settings-validation.test.ts`
Expected: FAIL with missing module or export errors for `src/host/settings/paths.ts` / `src/host/settings/types.ts`

- [ ] **Step 3: Implement the shared settings types and path helpers**

Add `SproutSettings`, `ProviderConfig`, `DefaultSelection`, `ModelRef`, `SessionModelSelection`, and path helpers in the new files. Keep `src/kernel/types.ts` focused on session/agent protocol and import the new types instead of duplicating them there.

- [ ] **Step 4: Re-run the focused tests**

Run: `bun test test/host/settings-paths.test.ts test/host/settings-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the foundation types**

Run:
```bash
git add src/host/settings/types.ts src/host/settings/paths.ts src/kernel/types.ts test/host/settings-paths.test.ts test/host/settings-validation.test.ts
git commit -m "feat: add settings types and paths"
```

### Task 2: Implement settings storage, recovery, and secret backends

**Files:**
- Create: `src/host/settings/store.ts`
- Create: `src/host/settings/secret-store.ts`
- Test: `test/host/settings-store.test.ts`
- Test: `test/host/secret-store.test.ts`

- [ ] **Step 1: Write failing store and secret-store tests**

Cover:
- atomic temp-file writes
- invalid JSON rename to `settings.invalid.<timestamp>.json`
- unsupported schema version recovery
- failed migration recovery
- partially written `settings.json` recovery
- no env auto-import after invalid-file recovery
- `memory` secret backend behavior
- `macos-keychain` backend selection behavior
- `secret-service` backend selection behavior
- unsupported backend surfaced as configuration error

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/settings-store.test.ts test/host/secret-store.test.ts`
Expected: FAIL with missing module or missing method errors

- [ ] **Step 3: Implement `SettingsStore`**

In `src/host/settings/store.ts`, implement:
- `load()`
- `save(settings)`
- `recoverInvalidFile()`
- migration/version checks
- temp-file-then-rename persistence

- [ ] **Step 4: Implement `SecretStore` backends**

In `src/host/settings/secret-store.ts`, add:
- interface + factory
- `memory` backend for tests
- `macos-keychain` backend implementation or shell around the chosen OS API
- `secret-service` backend implementation or shell around the chosen Linux API
- clean unsupported-platform errors for environments outside this version's scope

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/host/settings-store.test.ts test/host/secret-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the persistence layer**

Run:
```bash
git add src/host/settings/store.ts src/host/settings/secret-store.ts test/host/settings-store.test.ts test/host/secret-store.test.ts
git commit -m "feat: add settings persistence and secret storage"
```

### Task 3: Implement env import and the host settings control plane

**Files:**
- Create: `src/host/settings/env-import.ts`
- Create: `src/host/settings/control-plane.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Test: `test/host/settings-env-import.test.ts`
- Test: `test/host/settings-control-plane.test.ts`
- Modify: `test/host/cli-bootstrap.test.ts`

- [ ] **Step 1: Write failing import/control-plane tests**

Cover:
- env import maps current providers into deterministic `providerPriority`
- empty `tierOverrides` on first import
- import runs only when `settings.json` is absent
- imported provider IDs are stable and provider kinds canonical
- imported providers become persisted source-of-truth settings
- blocked secret migration creates disabled providers with validation errors
- `get_settings`, `create_provider`, `update_provider`, `set_provider_secret`, `delete_provider_secret`
- `set_provider_enabled`, `delete_provider`, `set_default_selection`, `set_provider_priority`, `set_tier_priority`
- command/result contracts for `test_provider_connection` and `refresh_provider_models`
- `ok: true` snapshots on provider health failures vs `ok: false` on validation/persistence failures
- `SettingsSnapshot` / `ProviderStatusSnapshot` fields
- `settings_updated` event emission after successful mutations

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/settings-env-import.test.ts test/host/settings-control-plane.test.ts test/host/cli-bootstrap.test.ts`
Expected: FAIL with missing control-plane imports or wrong bootstrap behavior

- [ ] **Step 3: Implement env import**

Map current env inputs into persisted config and secret storage:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY` / `GOOGLE_API_KEY`

Preserve current provider ordering by seeding imported `providerPriority` with:
`anthropic`, `openai`, `gemini`, then newly introduced kinds after them.

- [ ] **Step 4: Implement the settings control plane**

Add the authoritative snapshot/result assembly in `src/host/settings/control-plane.ts`. This module should own settings mutation semantics, not `src/web/server.ts` or `src/host/session-controller.ts`.

- [ ] **Step 5: Wire first-run bootstrap behavior**

Update `src/host/cli-bootstrap.ts` so startup loads `settings.json`, imports env-backed providers only when the settings file is absent, and suppresses env import after invalid-file recovery.

- [ ] **Step 6: Re-run the focused tests**

Run: `bun test test/host/settings-env-import.test.ts test/host/settings-control-plane.test.ts test/host/cli-bootstrap.test.ts`
Expected: PASS

- [ ] **Step 7: Commit the settings control plane**

Run:
```bash
git add src/host/settings/env-import.ts src/host/settings/control-plane.ts src/host/cli-bootstrap.ts test/host/settings-env-import.test.ts test/host/settings-control-plane.test.ts test/host/cli-bootstrap.test.ts
git commit -m "feat: add settings import and control plane"
```

## Chunk 2: Provider Runtime

### Task 4: Extend provider adapters and add the provider registry

**Files:**
- Modify: `src/llm/types.ts`
- Modify: `src/llm/openai.ts`
- Modify: `src/llm/anthropic.ts`
- Modify: `src/llm/gemini.ts`
- Create: `src/llm/provider-registry.ts`
- Modify: `src/host/settings/control-plane.ts`
- Test: `test/llm/provider-registry.test.ts`
- Modify: `test/host/settings-control-plane.test.ts`
- Modify: `test/llm/openai.test.ts`
- Modify: `test/llm/anthropic.test.ts`
- Modify: `test/llm/gemini.test.ts`

- [ ] **Step 1: Write failing adapter/registry tests**

Cover:
- `ProviderAdapter.listModels()`
- `ProviderAdapter.checkConnection()`
- `openai-compatible` base URL support
- `nonSecretHeaders` threaded into adapter requests without carrying credentials
- secret-optional `openai-compatible` / LM Studio construction
- OpenRouter construction path
- required-secret validation before adapter creation

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/llm/provider-registry.test.ts test/host/settings-control-plane.test.ts test/llm/openai.test.ts test/llm/anthropic.test.ts test/llm/gemini.test.ts`
Expected: FAIL because `ProviderAdapter` lacks the new contract

- [ ] **Step 3: Update `src/llm/types.ts` and adapter implementations**

Add the `ProviderAdapter` contract from the spec:
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

- [ ] **Step 4: Implement `src/llm/provider-registry.ts`**

Build adapters from persisted settings + secrets, including provider-specific `nonSecretHeaders`. Keep this file responsible only for validation and construction; do not let it absorb model-catalog logic.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/llm/provider-registry.test.ts test/host/settings-control-plane.test.ts test/llm/openai.test.ts test/llm/anthropic.test.ts test/llm/gemini.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the adapter and registry work**

Run:
```bash
git add src/llm/types.ts src/llm/openai.ts src/llm/anthropic.ts src/llm/gemini.ts src/llm/provider-registry.ts src/host/settings/control-plane.ts test/llm/provider-registry.test.ts test/host/settings-control-plane.test.ts test/llm/openai.test.ts test/llm/anthropic.test.ts test/llm/gemini.test.ts
git commit -m "feat: add provider registry and adapter metadata"
```

### Task 5: Implement the model catalog and provider-aware resolver

**Files:**
- Create: `src/llm/model-catalog.ts`
- Modify: `src/agents/model-resolver.ts`
- Test: `test/llm/model-catalog.test.ts`
- Modify: `test/agents/model-resolver.test.ts`

- [ ] **Step 1: Write failing catalog/resolver tests**

Cover:
- deterministic `tierHint`/`rank`
- `remote-only`, `manual-only`, `remote-with-manual`
- `remote-with-manual` merges remote models first, unions by model ID, and only fills missing metadata from manual entries
- disabled providers may retain cached/manual catalog entries for UI display while the resolver ignores them
- invalid providers keep status snapshot entries but expose no remote-discovered catalog entries
- disabled providers ignored by resolver
- fallback from `tierOverrides` to global `providerPriority`
- ambiguous raw model IDs rejected
- explicit `ModelRef` selection allowed when the provider exists and is enabled but the catalog is empty or stale
- explicit default selection pointing to a removed model fails clearly
- within-provider candidate ordering uses descending `rank`, then ascending `id`

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/llm/model-catalog.test.ts test/agents/model-resolver.test.ts`
Expected: FAIL with missing catalog module and outdated resolver expectations

- [ ] **Step 3: Implement `src/llm/model-catalog.ts`**

Give the catalog sole ownership of:
- refresh policy
- cached `ProviderModel[]`
- deterministic classifier/rank assignment
- disabled/invalid provider catalog membership rules
- internal refresh-state bookkeeping that later feeds `ProviderStatusSnapshot`

- [ ] **Step 4: Rewrite `src/agents/model-resolver.ts`**

Consume `ModelRef`, `SessionModelSelection`, and provider-aware catalog entries instead of `detectProvider()` and raw model-prefix inference.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/llm/model-catalog.test.ts test/agents/model-resolver.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the catalog and resolver**

Run:
```bash
git add src/llm/model-catalog.ts src/agents/model-resolver.ts test/llm/model-catalog.test.ts test/agents/model-resolver.test.ts
git commit -m "feat: add provider-aware model catalog"
```

### Task 6: Integrate settings, registry, and catalog into client bootstrap

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/host/settings/control-plane.ts`
- Modify: `test/llm/client.test.ts`
- Modify: `test/host/cli-bootstrap.test.ts`
- Modify: `test/host/settings-control-plane.test.ts`

- [ ] **Step 1: Write failing bootstrap/client tests**

Cover:
- loading providers from settings instead of only `fromEnv()`
- catalog refresh on startup
- `availableModels` derived from catalog
- imported settings used when `settings.json` is absent
- startup still succeeds when one provider refresh fails and the rest of the registry/catalog remain available
- `test_provider_connection` and `refresh_provider_models` use the live registry/catalog and update provider status snapshots
- `test_provider_connection` updates connection status without mutating the model catalog

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/llm/client.test.ts test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts`
Expected: FAIL because bootstrap still uses env-only client creation

- [ ] **Step 3: Add settings-aware client construction**

Keep `Client.fromEnv()` as a test/dev helper only, and add a new path that accepts registry-built adapters and model-catalog data without making `Client` itself own persistence logic.

- [ ] **Step 4: Update bootstrap**

In `src/host/cli-bootstrap.ts`, load settings, initialize the secret store, registry, catalog, and control plane before constructing the session controller and web/TUI state. Finish the runtime-backed `test_provider_connection` and `refresh_provider_models` control-plane operations here once the registry/catalog exist, keeping connection testing separate from catalog refresh.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/llm/client.test.ts test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts`
Expected: PASS

- [ ] **Step 6: Commit bootstrap integration**

Run:
```bash
git add src/llm/client.ts src/host/cli-bootstrap.ts src/host/settings/control-plane.ts test/llm/client.test.ts test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts
git commit -m "feat: bootstrap runtime providers from settings"
```

## Chunk 3: Session And Transport

### Task 7: Add selection parsing for agent specs, slash commands, and session inputs

**Files:**
- Create: `src/host/session-selection.ts`
- Modify: `src/kernel/types.ts`
- Modify: `src/agents/markdown-loader.ts`
- Modify: `src/shared/slash-commands.ts`
- Modify: `src/host/cli.ts`
- Test: `test/host/session-selection.test.ts`
- Modify: `test/agents/markdown-loader.test.ts`
- Modify: `test/tui/slash-commands.test.ts`
- Modify: `test/host/cli.test.ts`

- [ ] **Step 1: Write failing selection-parser tests**

Cover:
- agent frontmatter `model: best|balanced|fast`
- agent frontmatter explicit raw model IDs
- slash-command parsing of `inherit`, `providerId:modelId`, raw compatibility input
- session selection precedence values
- CLI `/model` wiring emits the new `selection` payload shape

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/session-selection.test.ts test/agents/markdown-loader.test.ts test/tui/slash-commands.test.ts test/host/cli.test.ts`
Expected: FAIL because the parser/controller contract still only accepts raw strings

- [ ] **Step 3: Implement `src/host/session-selection.ts`**

Put all string-to-selection parsing and compatibility resolution here so `src/shared/slash-commands.ts`, `src/agents/markdown-loader.ts`, and the session controller can share one normalization path.

- [ ] **Step 4: Update frontmatter and slash-command parsing**

Keep agent spec input `model: string` for this version, but route it through the new selection parser/resolver so ambiguity and empty-catalog behavior are explicit. Preserve the narrower frontmatter contract by accepting only tier names or raw model IDs there; provider-qualified `providerId:modelId` stays a session/UI input form.

- [ ] **Step 5: Update CLI/TUI slash-command integration**

Wire `src/host/cli.ts` and the shared slash-command surfaces to emit `{ selection: SessionModelSelection }` instead of `{ model: string }`.

- [ ] **Step 6: Re-run the focused tests**

Run: `bun test test/host/session-selection.test.ts test/agents/markdown-loader.test.ts test/tui/slash-commands.test.ts test/host/cli.test.ts`
Expected: PASS

- [ ] **Step 7: Commit selection parsing**

Run:
```bash
git add src/host/session-selection.ts src/kernel/types.ts src/agents/markdown-loader.ts src/shared/slash-commands.ts src/host/cli.ts test/host/session-selection.test.ts test/agents/markdown-loader.test.ts test/tui/slash-commands.test.ts test/host/cli.test.ts
git commit -m "feat: add provider-aware selection parsing"
```

### Task 8: Update session controller, metadata, and browser protocol

**Files:**
- Modify: `src/host/session-controller-commands.ts`
- Modify: `src/host/session-controller.ts`
- Modify: `src/host/session-state.ts`
- Modify: `src/host/session-metadata.ts`
- Modify: `src/host/cli-resume.ts`
- Modify: `src/agents/factory.ts`
- Modify: `src/agents/agent.ts`
- Modify: `test/host/session-controller-commands.test.ts`
- Create: `test/host/session-controller-selection.test.ts`
- Modify: `test/host/session-metadata.test.ts`
- Modify: `test/host/cli-resume.test.ts`

- [ ] **Step 1: Write failing session/protocol tests**

Cover:
- `switch_model` carrying `{ selection: SessionModelSelection }`
- `SessionSelectionSnapshot` in session state
- session metadata storing explicit `providerId + modelId`
- unique raw-model resume succeeds and migrates to explicit identity
- ambiguous raw-model resume fails
- stale or missing catalog resume fails clearly
- deleted or disabled provider fails on the next turn

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/session-controller-commands.test.ts test/host/session-controller-selection.test.ts test/host/session-metadata.test.ts test/host/cli-resume.test.ts`
Expected: FAIL because commands, metadata, and resume paths still use `model: string`

- [ ] **Step 3: Update the controller command contract**

Move `switch_model` to:
```ts
{ kind: "switch_model", data: { selection: SessionModelSelection } }
```
and thread `SessionSelectionSnapshot` through controller state instead of `modelOverride?: string`.

- [ ] **Step 4: Update metadata, resume, and execution wiring**

Store explicit provider/model identity in `src/host/session-metadata.ts`, load/migrate old metadata in `src/host/cli-resume.ts`, and make sure `src/agents/factory.ts` / `src/agents/agent.ts` consume the new resolved selection path.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/host/session-controller-commands.test.ts test/host/session-controller-selection.test.ts test/host/session-metadata.test.ts test/host/cli-resume.test.ts`
Expected: PASS

- [ ] **Step 6: Commit session/protocol changes**

Run:
```bash
git add src/host/session-controller-commands.ts src/host/session-controller.ts src/host/session-state.ts src/host/session-metadata.ts src/host/cli-resume.ts src/agents/factory.ts src/agents/agent.ts test/host/session-controller-commands.test.ts test/host/session-controller-selection.test.ts test/host/session-metadata.test.ts test/host/cli-resume.test.ts
git commit -m "feat: add provider-aware session selection protocol"
```

### Task 9: Expose settings and selection data through the server transport

**Files:**
- Modify: `src/kernel/types.ts`
- Modify: `src/kernel/protocol.ts`
- Modify: `src/web/server.ts`
- Modify: `src/host/cli-interactive.ts`
- Modify: `web/src/hooks/useEvents.ts`
- Modify: `test/web/protocol.test.ts`
- Modify: `test/web/server.test.ts`
- Modify: `web/src/hooks/useEvents.test.ts`

- [ ] **Step 1: Write failing server/event-store tests**

Cover:
- settings control-plane commands (`get_settings`, `create_provider`, `update_provider`, etc.)
- settings command results transport `ok: true | ok: false` plus `fieldErrors` for validation failures
- snapshot includes settings-control-plane data needed by web UI
- live `settings_updated` events after successful settings mutations
- session snapshot includes `SessionSelectionSnapshot`
- event store updates model/status from the new session snapshot fields
- event store applies `settings_updated` without forcing a reconnect or full snapshot refresh

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/web/protocol.test.ts test/web/server.test.ts web/src/hooks/useEvents.test.ts`
Expected: FAIL because snapshot/session payloads do not contain the new fields

- [ ] **Step 3: Update the web server snapshot and command handling**

Use the settings control plane to serve settings snapshot data and authoritative session selection state, extend `src/kernel/protocol.ts` validation for the settings commands, typed settings command results, and the `settings_updated` event, and wire `src/host/cli-interactive.ts` so the `WebServer` receives the control plane it needs. Keep the server as a transport adapter; do not let it own settings mutation logic.

- [ ] **Step 4: Update the web event store**

Teach `web/src/hooks/useEvents.ts` to normalize the new snapshot/session shape, apply live `settings_updated` messages, and retain the latest settings command result payloads for UI validation/error states while keeping the live event store logic isolated from React rendering.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/web/protocol.test.ts test/web/server.test.ts web/src/hooks/useEvents.test.ts`
Expected: PASS

- [ ] **Step 6: Commit server transport changes**

Run:
```bash
git add src/kernel/types.ts src/kernel/protocol.ts src/web/server.ts src/host/cli-interactive.ts web/src/hooks/useEvents.ts test/web/protocol.test.ts test/web/server.test.ts web/src/hooks/useEvents.test.ts
git commit -m "feat: expose settings and session selection snapshots"
```

## Chunk 4: Web Settings UI

### Task 10: Migrate the existing web session model picker

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/App.test.tsx`
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/components/__tests__/status-bar.test.tsx`

- [ ] **Step 1: Write failing status-bar/app tests**

Cover:
- `inherit` rendering
- provider-aware display labels
- `switch_model` sending `SessionModelSelection`
- raw compatibility inputs still parsed in the input area
- App-level slash-command and status-bar paths both emit the new selection payload

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test web/src/App.test.tsx web/src/components/__tests__/status-bar.test.tsx`
Expected: FAIL because the picker still expects `string` values

- [ ] **Step 3: Update the session-selection UI**

Keep the compact session selector in the status bar, but drive it from `SessionSelectionSnapshot` and provider-aware selectable models instead of `availableModels: string[]` + `currentModel: string`.

- [ ] **Step 4: Re-run the focused tests**

Run: `bun test web/src/App.test.tsx web/src/components/__tests__/status-bar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit the session-picker migration**

Run:
```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/components/StatusBar.tsx web/src/components/__tests__/status-bar.test.tsx
git commit -m "feat: migrate web session model selector"
```

### Task 11: Build the web provider configuration surface

**Files:**
- Create: `web/src/components/settings/ProviderSettingsPanel.tsx`
- Create: `web/src/components/settings/ProviderList.tsx`
- Create: `web/src/components/settings/ProviderEditor.tsx`
- Create: `web/src/components/settings/DefaultsPanel.tsx`
- Create: `web/src/components/settings/ProviderSettingsPanel.module.css`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Create: `web/src/components/__tests__/provider-settings.test.tsx`

- [ ] **Step 1: Write failing settings-panel tests**

Cover:
- loading and empty states
- provider list, editor, and defaults/routing views
- invalid / unreachable / stale states
- unsupported secret backend messaging
- create / edit / save / test / enable / delete flows
- secret entry and removal
- model refresh
- default selection modes
- global provider priority and tier overrides
- discovered-model inspection

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test web/src/App.test.tsx web/src/components/__tests__/provider-settings.test.tsx`
Expected: FAIL because the settings components do not exist

- [ ] **Step 3: Implement the settings components**

Use provider-kind-aware forms. Do not introduce a schema-driven form engine. Keep provider list rendering in `ProviderList.tsx`, editing in `ProviderEditor.tsx`, and defaults/routing in `DefaultsPanel.tsx`. Include provider deletion and the resulting routing/default cleanup states in this surface.

- [ ] **Step 4: Integrate the panel into `web/src/App.tsx`**

Add one clear access path to settings, wire host commands through the existing websocket command sender, and consume the control-plane snapshot from `useEvents`.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test web/src/App.test.tsx web/src/components/__tests__/provider-settings.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit the web settings UI**

Run:
```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/components/settings/ProviderSettingsPanel.tsx web/src/components/settings/ProviderList.tsx web/src/components/settings/ProviderEditor.tsx web/src/components/settings/DefaultsPanel.tsx web/src/components/settings/ProviderSettingsPanel.module.css web/src/components/__tests__/provider-settings.test.tsx
git commit -m "feat: add web provider settings UI"
```

## Chunk 5: TUI Parity And Hardening

### Task 12: Add TUI settings mode and provider-aware session model selection

**Files:**
- Create: `src/tui/settings-panel.tsx`
- Create: `src/tui/provider-settings-editor.tsx`
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/model-picker.tsx`
- Modify: `src/tui/status-bar.tsx`
- Modify: `src/tui/slash-commands.ts`
- Create: `test/tui/settings-panel.test.tsx`
- Create: `test/tui/provider-settings-editor.test.tsx`
- Modify: `test/tui/app.test.tsx`
- Modify: `test/tui/model-picker.test.tsx`
- Modify: `test/tui/status-bar.test.tsx`
- Modify: `test/tui/slash-commands.test.ts`

- [ ] **Step 1: Write failing TUI tests**

Cover:
- loading and empty states
- settings-mode navigation
- create/edit/save/test/enable/disable/delete flow
- secret entry/removal
- refresh discovered models
- default selection and routing flow
- stale/unreachable/invalid state rendering
- provider-aware session model picker values
- `/model inherit` and `providerId:modelId`
- `/model best`, `/model balanced`, and `/model fast`

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/tui/settings-panel.test.tsx test/tui/provider-settings-editor.test.tsx test/tui/app.test.tsx test/tui/model-picker.test.tsx test/tui/status-bar.test.tsx test/tui/slash-commands.test.ts`
Expected: FAIL because the new settings mode and selection contract are not implemented

- [ ] **Step 3: Implement `src/tui/settings-panel.tsx`**

Use the simple list-detail flow from the spec. Keep provider list/navigation concerns in `settings-panel.tsx`, provider edit/detail concerns in `provider-settings-editor.tsx`, and session model selection in `model-picker.tsx`.

- [ ] **Step 4: Update `src/tui/app.tsx` and related components**

Wire settings-mode entry, host command dispatch, new session selection snapshot, and provider-aware status-bar display.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/tui/settings-panel.test.tsx test/tui/provider-settings-editor.test.tsx test/tui/app.test.tsx test/tui/model-picker.test.tsx test/tui/status-bar.test.tsx test/tui/slash-commands.test.ts`
Expected: PASS

- [ ] **Step 6: Commit TUI parity**

Run:
```bash
git add src/tui/settings-panel.tsx src/tui/provider-settings-editor.tsx src/tui/app.tsx src/tui/model-picker.tsx src/tui/status-bar.tsx src/tui/slash-commands.ts test/tui/settings-panel.test.tsx test/tui/provider-settings-editor.test.tsx test/tui/app.test.tsx test/tui/model-picker.test.tsx test/tui/status-bar.test.tsx test/tui/slash-commands.test.ts
git commit -m "feat: add tui provider settings mode"
```

### Task 13: End-to-end verification, integration regressions, and docs landing

**Files:**
- Modify: `test/host/cli-interactive.test.ts`
- Modify: `test/host/cli-web.test.ts`
- Modify: `test/tui/app.test.tsx`
- Modify: `test/web/e2e.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/testing.md`

- [ ] **Step 1: Add or update the final integration tests**

Cover:
- first-run env import
- session `/model` compatibility inputs
- secret set/delete flows
- provider connection testing
- model refresh behavior
- explicit provider/model selection in new sessions
- old-session resume compatibility
- provider disable/delete affecting subsequent turns, not in-flight turns
- web and TUI settings flows reaching the same host commands

- [ ] **Step 2: Run the focused integration tests and verify they fail where coverage is new**

Run: `bun test test/host/cli-interactive.test.ts test/host/cli-web.test.ts test/tui/app.test.tsx test/web/e2e.test.ts`
Expected: targeted failures or missing assertions for the new provider/settings behavior

- [ ] **Step 3: Update the user-facing docs**

Document:
- XDG settings location
- supported secret backends
- env import behavior
- `/model` input forms
- web and TUI settings entry points

- [ ] **Step 4: Run the full verification suite**

Run:
```bash
bun run check
bun run typecheck
bun test
bun run precommit
```
Expected: all commands PASS

- [ ] **Step 5: Commit the final integration pass**

Run:
```bash
git add test/host/cli-interactive.test.ts test/host/cli-web.test.ts test/tui/app.test.tsx test/web/e2e.test.ts docs/architecture.md docs/testing.md
git commit -m "feat: finish provider backends and config ui"
```
