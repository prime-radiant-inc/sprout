# Provider Backends And Config UI Gap-Closure Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps between the approved provider-settings design and the shipped implementation by finishing the missing validation contracts, degraded secret-backend behavior, runtime warning surfacing, full provider metadata editing, and the softened TUI settings workflow.

**Architecture:** Build on the existing provider settings control plane instead of redesigning the system. Extract the duplicated provider-validation logic into one host-owned module, extend snapshots/results with structured errors and runtime warnings, make bootstrap tolerate unavailable secret backends, then finish the web and TUI editors so every persisted provider field is operator-editable from both clients.

**Tech Stack:** TypeScript on Bun, Bun test runner, Bun WebSocket server, React web UI, Ink TUI, Biome, Node filesystem APIs.

**Spec:** `docs/superpowers/specs/2026-03-11-provider-backends-and-config-ui-design.md`

**Supersedes:** This follow-up closes the implementation gaps left after `docs/superpowers/plans/2026-03-11-provider-backends-and-config-ui.md`.

---

## File Structure

**Create**

- `src/host/settings/validation.ts` - single source of truth for provider validation, field-level errors, and secret-backend availability checks.
- `test/host/settings-validation.test.ts` - focused validation-contract coverage for provider config, malformed URLs, and secret-backend failure states.
- `web/src/components/settings/ManualModelsEditor.tsx` - focused web editor for manual model rows.
- `web/src/components/settings/HeadersEditor.tsx` - focused web editor for non-secret provider headers.

**Modify**

- `src/host/settings/control-plane.ts` - use shared validation, return `fieldErrors`, and expose runtime warnings/global settings state in snapshots.
- `src/llm/provider-registry.ts` - use shared validation logic so registry and control plane do not drift.
- `src/host/settings/secret-store.ts` - represent unavailable secret backends without aborting bootstrap.
- `src/host/cli-bootstrap.ts` - carry invalid-settings recovery and secret-backend status into the control plane instead of hard-failing startup.
- `src/host/settings/store.ts` - preserve existing recovery behavior and expose the warning inputs bootstrap needs.
- `src/host/settings/types.ts` - add snapshot-visible runtime warning types if needed.
- `src/kernel/types.ts` - export any new snapshot/result shapes used by the clients.
- `src/kernel/protocol.ts` - validate settings-command payload shapes, not just command kinds.
- `src/web/server.ts` - transport the richer settings snapshot/result shapes.
- `web/src/hooks/useEvents.ts` - retain structured settings results and global warnings.
- `web/src/hooks/useEvents.test.ts`
- `web/src/components/settings/ProviderSettingsPanel.tsx` - render global warnings and route richer editor state.
- `web/src/components/settings/ProviderEditor.tsx` - support `manualModels`, `nonSecretHeaders`, and field-level errors.
- `web/src/components/settings/ProviderList.tsx`
- `web/src/components/settings/DefaultsPanel.tsx`
- `web/src/components/settings/ProviderSettingsPanel.module.css`
- `web/src/components/__tests__/provider-settings.test.tsx`
- `test/web/protocol.test.ts`
- `test/web/server.test.ts`
- `test/host/settings-control-plane.test.ts`
- `test/host/secret-store.test.ts`
- `test/host/cli-bootstrap.test.ts`
- `test/llm/provider-registry.test.ts`
- `src/tui/settings-panel.tsx` - move from raw command-shell editing to a stronger list-detail/settings workflow and surface global warnings.
- `src/tui/provider-settings-editor.tsx` - support manual models, non-secret headers, explicit field errors, and focused actions.
- `test/tui/settings-panel.test.tsx`
- `test/tui/provider-settings-editor.test.tsx`
- `test/tui/app.test.tsx`

## Chunk 1: Validation Contract And Transport Tightening

### Task 1: Centralize provider validation and return structured field errors

**Files:**
- Create: `src/host/settings/validation.ts`
- Create: `test/host/settings-validation.test.ts`
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/llm/provider-registry.ts`
- Modify: `test/host/settings-control-plane.test.ts`
- Modify: `test/llm/provider-registry.test.ts`

- [ ] **Step 1: Write failing validation tests**

Cover:
- malformed `baseUrl` is rejected before any network call
- `baseUrl` is required only for `openai-compatible`
- Gemini rejects `nonSecretHeaders`
- providers that require secrets report a secret-related validation error when no secret is present
- unavailable secret backends report a distinct validation error
- control-plane mutation failures return `fieldErrors` keyed by the relevant field names
- registry validation and control-plane validation produce the same messages for the same provider config

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/settings-validation.test.ts test/host/settings-control-plane.test.ts test/llm/provider-registry.test.ts`
Expected: FAIL because malformed URLs are currently accepted, `fieldErrors` are empty, and validation logic is duplicated.

- [ ] **Step 3: Implement shared validation**

In `src/host/settings/validation.ts`, add a shared validator that returns both:
- human-readable validation messages
- `fieldErrors: Record<string, string>` for per-field feedback

Use field keys that map directly to operator inputs:
- `label`
- `baseUrl`
- `nonSecretHeaders`
- `manualModels`
- `secret`
- `enabled`

Keep the validator pure. It should accept:
- `ProviderConfig`
- secret availability
- secret-backend availability

and return structured validation without reading the filesystem or the network.

- [ ] **Step 4: Wire the validator through the control plane and registry**

Update `src/host/settings/control-plane.ts` so:
- all mutation-time validation failures return `fieldErrors`
- snapshot validation errors still render as provider health state
- connection/model-refresh failures remain `ok: true` with provider status updates

Update `src/llm/provider-registry.ts` to reuse the same validator instead of duplicating checks.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/host/settings-validation.test.ts test/host/settings-control-plane.test.ts test/llm/provider-registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the validation contract**

Run:
```bash
git add src/host/settings/validation.ts src/host/settings/control-plane.ts src/llm/provider-registry.ts test/host/settings-validation.test.ts test/host/settings-control-plane.test.ts test/llm/provider-registry.test.ts
git commit -m "fix: centralize provider validation contracts"
```

### Task 2: Tighten settings-command protocol validation

**Files:**
- Modify: `src/kernel/protocol.ts`
- Modify: `test/web/protocol.test.ts`
- Modify: `test/web/server.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Cover:
- `create_provider` rejects missing `kind`, empty `label`, invalid `discoveryStrategy`, malformed `manualModels`, and malformed `nonSecretHeaders`
- `update_provider` rejects non-object `patch`, invalid `providerId`, and malformed nested fields
- `set_default_selection` rejects malformed selection shapes
- `set_provider_priority` and `set_tier_priority` reject non-array payloads and invalid tier names

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/web/protocol.test.ts test/web/server.test.ts`
Expected: FAIL because `parseCommandMessage()` currently only validates command kind and that `data` is an object.

- [ ] **Step 3: Implement payload-shape validation**

Extend `src/kernel/protocol.ts` with lightweight, explicit validators for each settings command shape. Keep this transport-level validation shallow but real:
- verify required keys exist
- verify primitive types and arrays
- reject malformed nested objects

Do not move host business rules into protocol parsing. Keep provider-specific validation in the control plane.

- [ ] **Step 4: Re-run the focused tests**

Run: `bun test test/web/protocol.test.ts test/web/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the protocol hardening**

Run:
```bash
git add src/kernel/protocol.ts test/web/protocol.test.ts test/web/server.test.ts
git commit -m "fix: validate settings command payloads"
```

## Chunk 2: Bootstrap Degradation And Runtime Warning Surfacing

### Task 3: Degrade unsupported secret backends instead of aborting startup

**Files:**
- Modify: `src/host/settings/secret-store.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/host/settings/types.ts`
- Modify: `src/kernel/types.ts`
- Modify: `test/host/secret-store.test.ts`
- Modify: `test/host/cli-bootstrap.test.ts`
- Modify: `test/host/settings-control-plane.test.ts`

- [ ] **Step 1: Write failing degradation tests**

Cover:
- unsupported platforms do not abort interactive bootstrap
- settings still load when the secret backend is unavailable
- providers that require secrets remain invalid/disabled under an unavailable backend
- `set_provider_secret` and `delete_provider_secret` fail cleanly with a secret-backend-unavailable error
- settings snapshots expose enough runtime status for the clients to explain the backend problem

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/secret-store.test.ts test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts`
Expected: FAIL because bootstrap currently calls `resolveDefaultSecretStorageBackend()` eagerly and throws on unsupported platforms.

- [ ] **Step 3: Implement degraded secret-backend runtime state**

In `src/host/settings/secret-store.ts`, add a runtime representation for unavailable secret storage:
- keep the selected backend name if one was requested
- report `available: false`
- provide a non-persisting secret-store implementation that never claims a secret exists and throws a clear error on set/delete attempts

Do not add a plaintext fallback store.

- [ ] **Step 4: Propagate degraded backend status through bootstrap and the control plane**

Update `src/host/cli-bootstrap.ts` and `src/host/settings/control-plane.ts` so the settings snapshot carries global runtime state for:
- secret backend availability
- the user-facing error message

Use that state inside provider validation so secret-requiring providers surface a backend-specific validation error instead of a generic crash.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/host/secret-store.test.ts test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts`
Expected: PASS

- [ ] **Step 6: Commit degraded secret-backend support**

Run:
```bash
git add src/host/settings/secret-store.ts src/host/cli-bootstrap.ts src/host/settings/control-plane.ts src/host/settings/types.ts src/kernel/types.ts test/host/secret-store.test.ts test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts
git commit -m "fix: degrade unavailable secret backends"
```

### Task 4: Surface invalid-settings recovery and runtime warnings to clients

**Files:**
- Modify: `src/host/settings/store.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/kernel/types.ts`
- Modify: `src/web/server.ts`
- Modify: `web/src/hooks/useEvents.ts`
- Modify: `web/src/hooks/useEvents.test.ts`
- Modify: `test/host/settings-control-plane.test.ts`
- Modify: `test/host/cli-bootstrap.test.ts`

- [ ] **Step 1: Write failing warning-surfacing tests**

Cover:
- bootstrap preserves `recoveredInvalidFilePath` and carries it into the settings runtime snapshot
- web snapshot payload includes global warnings without reconnecting
- event store applies updated warning state from `snapshot` and `settings_updated`
- warning state survives settings edits until explicitly cleared by a fresh successful load

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts web/src/hooks/useEvents.test.ts`
Expected: FAIL because recovery metadata is currently dropped after bootstrap.

- [ ] **Step 3: Add snapshot-level runtime warnings**

Extend the settings snapshot with a small, explicit global runtime section for:
- invalid-settings recovery warnings
- secret-backend availability

Keep provider-local warnings in provider status. Use the global section only for non-provider-specific runtime issues.

- [ ] **Step 4: Thread warnings through the server and event store**

Update the web transport and event store so warning state is present on:
- initial snapshot
- successful settings mutations that update runtime state

Do not create a second warning channel; keep this data inside the authoritative settings snapshot.

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts web/src/hooks/useEvents.test.ts`
Expected: PASS

- [ ] **Step 6: Commit runtime warning surfacing**

Run:
```bash
git add src/host/settings/store.ts src/host/cli-bootstrap.ts src/host/settings/control-plane.ts src/kernel/types.ts src/web/server.ts web/src/hooks/useEvents.ts web/src/hooks/useEvents.test.ts test/host/cli-bootstrap.test.ts test/host/settings-control-plane.test.ts
git commit -m "fix: surface settings runtime warnings"
```

## Chunk 3: Complete The Operator Surfaces

### Task 5: Finish the web provider editor with manual models, non-secret headers, and field-level feedback

**Files:**
- Create: `web/src/components/settings/ManualModelsEditor.tsx`
- Create: `web/src/components/settings/HeadersEditor.tsx`
- Modify: `web/src/components/settings/ProviderEditor.tsx`
- Modify: `web/src/components/settings/ProviderSettingsPanel.tsx`
- Modify: `web/src/components/settings/ProviderList.tsx`
- Modify: `web/src/components/settings/ProviderSettingsPanel.module.css`
- Modify: `web/src/components/__tests__/provider-settings.test.tsx`

- [ ] **Step 1: Write failing provider-settings tests**

Cover:
- create/edit flows can save `manualModels`
- create/edit flows can save `nonSecretHeaders` for supported provider kinds
- Gemini hides or disables custom header editing
- field-level errors render next to the corresponding input, not only as a banner
- unsupported secret backend and invalid-settings recovery warnings render in the panel shell
- manual-only providers created through the UI expose manual models in discovered-model inspection

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test web/src/components/__tests__/provider-settings.test.tsx`
Expected: FAIL because the web editor does not currently expose these inputs or render `fieldErrors`.

- [ ] **Step 3: Add focused form subcomponents**

Keep `ProviderEditor.tsx` from turning into a monolith by extracting:
- `ManualModelsEditor.tsx` for add/remove/edit model rows
- `HeadersEditor.tsx` for key/value header rows

Use `ProviderEditor.tsx` only as the orchestration layer that:
- owns the draft
- builds `create_provider` / `update_provider` commands
- renders field-specific errors
- gates provider-kind-specific inputs

- [ ] **Step 4: Re-run the focused tests**

Run: `bun test web/src/components/__tests__/provider-settings.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit the web editor completion**

Run:
```bash
git add web/src/components/settings/ManualModelsEditor.tsx web/src/components/settings/HeadersEditor.tsx web/src/components/settings/ProviderEditor.tsx web/src/components/settings/ProviderSettingsPanel.tsx web/src/components/settings/ProviderList.tsx web/src/components/settings/ProviderSettingsPanel.module.css web/src/components/__tests__/provider-settings.test.tsx
git commit -m "feat: finish web provider editor surfaces"
```

### Task 6: Bring the TUI settings flow up to the approved list-detail interaction

**Files:**
- Modify: `src/tui/settings-panel.tsx`
- Modify: `src/tui/provider-settings-editor.tsx`
- Modify: `test/tui/settings-panel.test.tsx`
- Modify: `test/tui/provider-settings-editor.test.tsx`
- Modify: `test/tui/app.test.tsx`

- [ ] **Step 1: Write failing TUI tests**

Cover:
- global runtime warnings render in settings mode
- provider detail view shows field-level validation feedback
- manual models are viewable and editable from the selected-provider detail flow
- non-secret headers are viewable and editable for supported provider kinds
- the settings UI uses explicit list/detail actions instead of relying on a raw `settings>` command shell for normal editing

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test test/tui/settings-panel.test.tsx test/tui/provider-settings-editor.test.tsx test/tui/app.test.tsx`
Expected: FAIL because the current TUI settings surface still centers editing around freeform commands and does not expose the missing provider fields.

- [ ] **Step 3: Replace the command-shell editing path with focused list-detail actions**

Keep the current view structure, but move normal editing to explicit focused actions:
- select provider/defaults/create from the list
- enter field-edit mode for label/base URL/headers/manual models
- trigger enable/disable/test/refresh/delete from visible action rows

Retain terse keyboard commands only as shortcuts, not as the primary UI contract.

- [ ] **Step 4: Re-run the focused tests**

Run: `bun test test/tui/settings-panel.test.tsx test/tui/provider-settings-editor.test.tsx test/tui/app.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit the TUI parity work**

Run:
```bash
git add src/tui/settings-panel.tsx src/tui/provider-settings-editor.tsx test/tui/settings-panel.test.tsx test/tui/provider-settings-editor.test.tsx test/tui/app.test.tsx
git commit -m "feat: finish tui provider settings parity"
```

## Chunk 4: Final Verification

### Task 7: Run the full regression pass and update follow-up documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-03-12-provider-backends-config-ui-gap-closure.md`
- Modify: `docs/superpowers/specs/2026-03-11-provider-backends-and-config-ui-design.md` (only if the final implementation intentionally differs from the original language)

- [ ] **Step 1: Run the targeted suites for the completed follow-up**

Run:
```bash
bun test test/host/settings-validation.test.ts test/host/settings-control-plane.test.ts test/host/secret-store.test.ts test/host/cli-bootstrap.test.ts test/llm/provider-registry.test.ts test/web/protocol.test.ts test/web/server.test.ts web/src/hooks/useEvents.test.ts web/src/components/__tests__/provider-settings.test.tsx test/tui/settings-panel.test.tsx test/tui/provider-settings-editor.test.tsx test/tui/app.test.tsx
```
Expected: PASS

- [ ] **Step 2: Run the project-wide verification suite**

Run:
```bash
bun run check
bun run typecheck
bun test
bun run precommit
```
Expected: PASS

- [ ] **Step 3: Update follow-up docs if implementation decisions changed**

If the implementation required a deliberate deviation from the original design, update the spec and this follow-up plan so the written docs match reality. Do not rewrite the original project plan beyond cross-linking this follow-up.

- [ ] **Step 4: Commit the follow-up completion**

Run:
```bash
git add docs/superpowers/plans/2026-03-12-provider-backends-config-ui-gap-closure.md docs/superpowers/specs/2026-03-11-provider-backends-and-config-ui-design.md
git commit -m "docs: close provider settings follow-up gaps"
```
