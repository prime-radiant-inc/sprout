# Global Tier Tuples Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace provider-owned tier defaults with global `provider + model` tuples for `best`, `balanced`, and `fast`.

**Architecture:** Keep `defaultProviderId` only as the default provider for exact-model browsing and `inherit`. Move tier defaults into the global defaults config as explicit `ModelRef`s, resolve tiers without provider context, and remove provider-tier editing from provider editors.

**Tech Stack:** TypeScript on Bun, React web UI, Ink TUI, Bun tests, Biome.

---

## Chunk 1: Core Data Model And Resolver

### Task 1: Move Tier Defaults Into Global Defaults

**Files:**
- Modify: `src/shared/provider-settings.ts`
- Modify: `src/host/settings/types.ts`
- Modify: `src/agents/model-resolver.ts`
- Test: `test/agents/model-resolver.test.ts`
- Test: `test/host/settings-validation.test.ts`

- [ ] **Step 1: Write failing tests for global tier defaults**
- [ ] **Step 2: Remove `tierDefaults` from `ProviderConfig` and add global tier model refs under `defaults`**
- [ ] **Step 3: Resolve `best|balanced|fast` from global defaults instead of selected provider**
- [ ] **Step 4: Run focused tests until green**
- [ ] **Step 5: Commit**

### Task 2: Replace Control-Plane Commands And Validation

**Files:**
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/kernel/protocol.ts`
- Test: `test/host/settings-control-plane.test.ts`
- Test: `test/web/protocol.test.ts`

- [ ] **Step 1: Write failing tests for global tier-default commands**
- [ ] **Step 2: Replace `set_provider_tier_defaults` style handling with `set_global_tier_defaults`**
- [ ] **Step 3: Validate global tier refs against the provider catalog**
- [ ] **Step 4: Run focused tests until green**
- [ ] **Step 5: Commit**

## Chunk 2: Session Selection And Host Wiring

### Task 3: Remove Provider-Relative Tier Selection

**Files:**
- Modify: `src/shared/session-selection.ts`
- Modify: `src/host/session-selection.ts`
- Modify: `src/host/session-controller.ts`
- Modify: `src/host/session-metadata.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/host/cli-resume.ts`
- Test: `test/host/session-selection.test.ts`
- Test: `test/host/session-controller-selection.test.ts`
- Test: `test/host/cli-resume.test.ts`

- [ ] **Step 1: Write failing tests showing tier selections no longer carry provider ids**
- [ ] **Step 2: Remove provider ids from `inherit`/`tier` selection shapes**
- [ ] **Step 3: Keep exact-model selections explicit `provider + model`**
- [ ] **Step 4: Run focused tests until green**
- [ ] **Step 5: Commit**

## Chunk 3: Web And TUI UX

### Task 4: Replace Provider Tier Editors With Global Tier Defaults UI

**Files:**
- Modify: `web/src/components/settings/DefaultProviderPanel.tsx`
- Modify: `web/src/components/settings/ProviderEditor.tsx`
- Modify: `web/src/components/settings/ProviderSettingsPanel.tsx`
- Modify: `src/tui/settings-panel.tsx`
- Modify: `src/tui/provider-settings-editor.tsx`
- Test: `web/src/components/__tests__/provider-settings.test.tsx`
- Test: `test/tui/settings-panel.test.tsx`

- [ ] **Step 1: Write failing UI tests for global tier default editing**
- [ ] **Step 2: Add global `Best / Balanced / Fast` provider-model selectors**
- [ ] **Step 3: Remove provider-owned tier dropdowns from provider editors**
- [ ] **Step 4: Run focused tests until green**
- [ ] **Step 5: Commit**

### Task 5: Make Session Pickers Use Global Tiers And Provider-Scoped Exact Models

**Files:**
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/App.tsx`
- Modify: `src/tui/model-picker.tsx`
- Modify: `src/tui/status-bar.tsx`
- Test: `web/src/components/__tests__/status-bar.test.tsx`
- Test: `test/tui/model-picker.test.tsx`
- Test: `test/tui/status-bar.test.tsx`

- [ ] **Step 1: Write failing picker tests for global tiers**
- [ ] **Step 2: Keep provider choice only as exact-model browsing context**
- [ ] **Step 3: Make `best|balanced|fast` always point at the global tuple**
- [ ] **Step 4: Run focused tests until green**
- [ ] **Step 5: Commit**

## Chunk 4: Final Verification

### Task 6: Full Regression Pass

**Files:**
- Modify as needed: touched tests/fixtures

- [ ] **Step 1: Run `bun run check`**
- [ ] **Step 2: Run `bun run typecheck`**
- [ ] **Step 3: Run `bun test`**
- [ ] **Step 4: Run `bun run precommit`**
- [ ] **Step 5: Commit final cleanup**
