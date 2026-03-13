# Default Models And Provider Settings Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current provider-scoped/default-provider/discovery-strategy model with one global `Default models` surface, exact models grouped by provider, remote-only cached discovery, and explicit provider-qualified exact-model semantics everywhere.

**Architecture:** Make this a cleanup refactor, not a compatibility layer. Remove `defaultProviderId`, `discoveryStrategy`, `manualModels`, provider-relative default-model resolution, and bare exact-model parsing from shared types, persistence, runtime resolution, protocol, and both UIs. The result should have one canonical settings schema, one canonical picker model, and no hidden vestigial branches preserving the old concepts.

**Tech Stack:** TypeScript on Bun, React web UI, Ink TUI, Bun tests, Biome, existing settings control plane / session controller / model resolver stack.

---

## File Map

**Shared settings and selection model**

- Modify: `src/shared/provider-settings.ts`
- Modify: `src/shared/session-selection.ts`
- Modify: `src/shared/slash-commands.ts`
- Modify: `src/kernel/protocol.ts`
- Modify: `src/kernel/types.ts`

**Host settings persistence and control plane**

- Modify: `src/host/settings/types.ts`
- Modify: `src/host/settings/validation.ts`
- Modify: `src/host/settings/store.ts`
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/host/settings/env-import.ts`
- Modify: `src/host/session-selection.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/host/cli.ts`

**Runtime resolution and agent loading**

- Modify: `src/agents/model-resolver.ts`
- Modify: `src/agents/markdown-loader.ts`
- Modify: `src/agents/agent.ts`
- Modify: `src/agents/factory.ts`
- Modify: `src/llm/model-catalog.ts`

**Web UI**

- Delete: `web/src/components/settings/DefaultProviderPanel.tsx`
- Delete: `web/src/components/settings/ManualModelsEditor.tsx`
- Create: `web/src/components/settings/DefaultModelsPanel.tsx`
- Modify: `web/src/components/settings/ProviderEditor.tsx`
- Modify: `web/src/components/settings/ProviderList.tsx`
- Modify: `web/src/components/settings/ProviderSettingsPanel.tsx`
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/App.tsx`

**TUI**

- Modify: `src/tui/provider-settings-editor.tsx`
- Modify: `src/tui/settings-panel.tsx`
- Modify: `src/tui/model-picker.tsx`
- Modify: `src/tui/status-bar.tsx`
- Modify: `src/tui/app.tsx`

**Tests**

- Modify: `test/helpers/provider-settings.ts`
- Modify: `test/host/settings-validation.test.ts`
- Modify: `test/host/settings-store.test.ts`
- Modify: `test/host/settings-control-plane.test.ts`
- Modify: `test/host/session-selection.test.ts`
- Modify: `test/host/cli-bootstrap.test.ts`
- Modify: `test/agents/model-resolver.test.ts`
- Modify: `test/llm/model-catalog.test.ts`
- Modify: `test/web/protocol.test.ts`
- Modify: `test/web/server.test.ts`
- Modify: `web/src/components/__tests__/provider-settings.test.tsx`
- Modify: `web/src/components/__tests__/status-bar.test.tsx`
- Modify: `test/tui/provider-settings-editor.test.tsx`
- Modify: `test/tui/settings-panel.test.tsx`
- Modify: `test/tui/model-picker.test.tsx`
- Modify: `test/tui/app.test.tsx`

## Chunk 1: Break The Old Schema And Selection Semantics

### Task 1: Replace The Persisted Settings Schema With The Cleanup Model

**Files:**
- Modify: `src/shared/provider-settings.ts`
- Modify: `src/host/settings/types.ts`
- Modify: `src/host/settings/validation.ts`
- Modify: `src/host/settings/store.ts`
- Test: `test/host/settings-validation.test.ts`
- Test: `test/host/settings-store.test.ts`

- [ ] **Step 1: Write the failing schema tests**

Add tests covering:

```ts
test("rejects current-schema settings that still contain defaultProviderId", () => {
	const settings = {
		version: 2,
		providers: [],
		defaults: { defaultProviderId: "openrouter" },
	};
	expect(() => new SettingsStore({ ... }).load()).toThrow();
});

test("rejects providers that still contain discoveryStrategy or manualModels", () => {
	const result = validateProviderConfig({
		...provider(),
		discoveryStrategy: "remote-only",
		manualModels: [{ id: "foo" }],
	} as unknown as ProviderConfig);
	expect(result.errors).toContain("Discovery strategy is no longer supported");
});
```

- [ ] **Step 2: Run the focused tests and watch them fail**

Run:

```bash
bun test test/host/settings-validation.test.ts test/host/settings-store.test.ts
```

Expected: FAIL because the old schema still allows `defaultProviderId`, `discoveryStrategy`, and `manualModels`.

- [ ] **Step 3: Replace the shared settings types**

In `src/shared/provider-settings.ts`:

- bump `SETTINGS_SCHEMA_VERSION`
- remove `ProviderDiscoveryStrategy`
- remove `ManualModelConfig`
- remove `defaultProviderId` from `DefaultsConfig`
- replace `tierDefaults?: TierModelDefaults` with:

```ts
export interface DefaultsConfig {
	best?: ModelRef;
	balanced?: ModelRef;
	fast?: ModelRef;
}
```

- remove `discoveryStrategy` and `manualModels` from `ProviderConfig`

- [ ] **Step 4: Make validation and store loading strict**

In `src/host/settings/validation.ts` and `src/host/settings/store.ts`:

- validate only the new provider shape
- delete the current normalization helpers that preserve removed settings concepts
- make `SettingsStore.load()` reject old-version or old-shape settings files instead of normalizing them
- keep the existing invalid-file recovery behavior, but use it for the schema break rather than lenient loading

- [ ] **Step 5: Re-run the focused tests**

Run:

```bash
bun test test/host/settings-validation.test.ts test/host/settings-store.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/provider-settings.ts src/host/settings/types.ts src/host/settings/validation.ts src/host/settings/store.ts test/host/settings-validation.test.ts test/host/settings-store.test.ts
git commit -m "refactor: remove legacy settings schema concepts"
```

### Task 2: Make Exact Model Resolution Explicit Everywhere

**Files:**
- Modify: `src/shared/session-selection.ts`
- Modify: `src/shared/slash-commands.ts`
- Modify: `src/agents/markdown-loader.ts`
- Modify: `src/host/session-selection.ts`
- Test: `test/host/session-selection.test.ts`

- [ ] **Step 1: Write the failing parsing tests**

Add tests covering:

```ts
test("rejects bare exact session model ids", () => {
	expect(() => parseSessionSelectionRequest("gpt-4.1")).toThrow(/provider-qualified/i);
});

test("allows provider-qualified agent model declarations", () => {
	expect(parseAgentModelInput("openrouter:gpt-4.1")).toEqual({
		kind: "model",
		model: { providerId: "openrouter", modelId: "gpt-4.1" },
	});
});

test("rejects inherit in agent frontmatter", () => {
	expect(() => parseAgentModelInput("inherit")).toThrow(/inherit/);
});
```

- [ ] **Step 2: Run the focused parsing tests**

Run:

```bash
bun test test/host/session-selection.test.ts
```

Expected: FAIL because agent parsing still accepts bare exact-model ids and rejects provider-qualified ones.

- [ ] **Step 3: Replace the selection parsing model**

In `src/shared/session-selection.ts`:

- keep session requests as `inherit | tier | model`
- make `parseSessionSelectionRequest()` accept only:
  - `inherit`
  - `best|balanced|fast`
  - `provider:model`
- change `AgentModelInput` so explicit exact models are provider-qualified:

```ts
export type AgentModelInput =
	| { kind: "tier"; tier: Tier }
	| { kind: "model"; model: ModelRef };
```

- reject `inherit` in agent/frontmatter parsing
- remove any remaining `unqualified_model` branch

- [ ] **Step 4: Update the loader and host selection helpers**

In `src/agents/markdown-loader.ts` and `src/host/session-selection.ts`:

- update frontmatter handling to use the new explicit model input type
- ensure `inherit` remains session-only
- keep formatting helpers aligned with the new explicit format

- [ ] **Step 5: Re-run the focused parsing tests**

Run:

```bash
bun test test/host/session-selection.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/session-selection.ts src/shared/slash-commands.ts src/agents/markdown-loader.ts src/host/session-selection.ts test/host/session-selection.test.ts
git commit -m "refactor: require explicit provider-qualified model selection"
```

## Chunk 2: Remove Default-Provider And Discovery Logic From Runtime

### Task 3: Rewrite Resolver And Catalog Logic Around Global Default Models

**Files:**
- Modify: `src/agents/model-resolver.ts`
- Modify: `src/agents/agent.ts`
- Modify: `src/agents/factory.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/llm/model-catalog.ts`
- Test: `test/agents/model-resolver.test.ts`
- Test: `test/llm/model-catalog.test.ts`
- Test: `test/host/cli-bootstrap.test.ts`

- [ ] **Step 1: Write failing resolver/catalog tests**

Add tests covering:

```ts
test("resolves best through settings.defaults.best", () => {
	expect(resolveModel("best", settings, catalog)).toEqual({
		provider: "openrouter",
		model: "anthropic/claude-opus-4.1",
	});
});

test("does not support provider-relative exact-model resolution without providerId", () => {
	expect(() => resolveModel("gpt-4.1", settings, catalog)).toThrow(/explicit provider/i);
});

test("catalog uses cached remote models only and never merges manual models", () => {
	expect(buildCatalogEntry(provider, { cachedModels: [...] })).toEqual(...);
});
```

- [ ] **Step 2: Run the focused runtime tests**

Run:

```bash
bun test test/agents/model-resolver.test.ts test/llm/model-catalog.test.ts test/host/cli-bootstrap.test.ts
```

Expected: FAIL because resolver settings still rely on `defaultProviderId` and catalog logic still branches on discovery/manual semantics.

- [ ] **Step 3: Simplify resolver settings**

In `src/agents/model-resolver.ts`:

- remove `defaultProviderId`
- replace nested `tierDefaults` with direct `defaults.best|balanced|fast`
- remove provider-relative exact-model support
- resolve `best|balanced|fast` only from explicit `ModelRef`s

- [ ] **Step 4: Remove discovery/manual branches from the catalog**

In `src/llm/model-catalog.ts`:

- delete manual-model normalization/merge helpers
- make catalog building use only:
  - current remote fetch results
  - last known cached remote results
- remove branches for `manual-only` and `remote-with-manual`

- [ ] **Step 5: Update runtime wiring**

In `src/agents/agent.ts`, `src/agents/factory.ts`, and `src/host/cli-bootstrap.ts`:

- stop threading `defaultProviderId`
- stop synthesizing implicit provider context
- keep `inherit` as "no session override"
- ensure runtime available-model state reflects remote cached catalogs only

- [ ] **Step 6: Re-run the focused runtime tests**

Run:

```bash
bun test test/agents/model-resolver.test.ts test/llm/model-catalog.test.ts test/host/cli-bootstrap.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agents/model-resolver.ts src/agents/agent.ts src/agents/factory.ts src/host/cli-bootstrap.ts src/llm/model-catalog.ts test/agents/model-resolver.test.ts test/llm/model-catalog.test.ts test/host/cli-bootstrap.test.ts
git commit -m "refactor: remove default-provider and discovery runtime branches"
```

### Task 4: Replace The Settings Command Surface

**Files:**
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/kernel/protocol.ts`
- Modify: `src/kernel/types.ts`
- Modify: `src/web/server.ts`
- Test: `test/host/settings-control-plane.test.ts`
- Test: `test/web/protocol.test.ts`
- Test: `test/web/server.test.ts`

- [ ] **Step 1: Write failing command-contract tests**

Add tests covering:

```ts
test("sets a default model tuple directly", async () => {
	const result = await plane.execute({
		kind: "set_default_model",
		data: {
			slot: "fast",
			model: { providerId: "lmstudio", modelId: "qwen2.5-coder" },
		},
	});
	expect(result.ok).toBe(true);
});

test("does not accept set_default_provider", () => {
	expect(() => parseCommandMessage(...)).toThrow(/Unknown command kind/);
});
```

- [ ] **Step 2: Run the focused command tests**

Run:

```bash
bun test test/host/settings-control-plane.test.ts test/web/protocol.test.ts test/web/server.test.ts
```

Expected: FAIL because the old commands and payload shapes are still present.

- [ ] **Step 3: Replace the command model**

In `src/host/settings/control-plane.ts` and `src/kernel/protocol.ts`:

- remove `set_default_provider`
- remove `set_global_tier_default`
- add:

```ts
{ kind: "set_default_model"; data: { slot: Tier; model?: ModelRef } }
```

- remove `discoveryStrategy` and `manualModels` from create/update provider payloads
- make create/update providers implicitly use remote cached discovery only

- [ ] **Step 4: Rework control-plane validation and snapshots**

In `src/host/settings/control-plane.ts`:

- store defaults directly as `settings.defaults.best|balanced|fast`
- validate default-model refs against enabled providers and current catalog
- keep broken stored refs visible in the snapshot so the UI can render them explicitly

- [ ] **Step 5: Update the web settings-command routing**

In `src/web/server.ts`:

- route `set_default_model` as a settings command
- delete old command handling branches

- [ ] **Step 6: Re-run the focused command tests**

Run:

```bash
bun test test/host/settings-control-plane.test.ts test/web/protocol.test.ts test/web/server.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/host/settings/control-plane.ts src/kernel/protocol.ts src/kernel/types.ts src/web/server.ts test/host/settings-control-plane.test.ts test/web/protocol.test.ts test/web/server.test.ts
git commit -m "refactor: replace legacy settings commands with default model commands"
```

## Chunk 3: Rebuild The Web UI Around One Picker And One Default Models Panel

### Task 5: Replace The Settings UI Structure

**Files:**
- Delete: `web/src/components/settings/DefaultProviderPanel.tsx`
- Delete: `web/src/components/settings/ManualModelsEditor.tsx`
- Create: `web/src/components/settings/DefaultModelsPanel.tsx`
- Modify: `web/src/components/settings/ProviderEditor.tsx`
- Modify: `web/src/components/settings/ProviderSettingsPanel.tsx`
- Modify: `web/src/components/settings/ProviderList.tsx`
- Test: `web/src/components/__tests__/provider-settings.test.tsx`

- [ ] **Step 1: Write failing web-settings tests**

Add tests covering:

```tsx
test("renders a Default models section separate from provider tabs", () => {
	render(<ProviderSettingsPanel ... />);
	expect(screen.getByText("Default models")).toBeInTheDocument();
	expect(screen.queryByText("Fallback provider")).not.toBeInTheDocument();
});

test("does not render discovery strategy or manual model controls", () => {
	render(<ProviderEditor ... />);
	expect(screen.queryByLabelText(/Discovery/i)).toBeNull();
	expect(screen.queryByText(/Manual models/i)).toBeNull();
});
```

- [ ] **Step 2: Run the focused web-settings test**

Run:

```bash
bun test web/src/components/__tests__/provider-settings.test.tsx
```

Expected: FAIL because the old controls still render.

- [ ] **Step 3: Replace the settings components**

In the web settings components:

- delete `DefaultProviderPanel.tsx`
- create `DefaultModelsPanel.tsx` for:
  - `Best`
  - `Balanced`
  - `Fast`
  - explicit unavailable/broken stored values
- remove `ManualModelsEditor.tsx`
- simplify `ProviderEditor.tsx` so it only edits provider config/auth/refresh/headers
- update `ProviderSettingsPanel.tsx` and `ProviderList.tsx` so `Default models` is a distinct top-level section, not another provider-like tab

- [ ] **Step 4: Re-run the focused web-settings test**

Run:

```bash
bun test web/src/components/__tests__/provider-settings.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/settings/DefaultModelsPanel.tsx web/src/components/settings/ProviderEditor.tsx web/src/components/settings/ProviderList.tsx web/src/components/settings/ProviderSettingsPanel.tsx web/src/components/__tests__/provider-settings.test.tsx
git rm web/src/components/settings/DefaultProviderPanel.tsx web/src/components/settings/ManualModelsEditor.tsx
git commit -m "refactor: simplify web provider settings ui"
```

### Task 6: Remove The Root Provider Selector And Build The Single Web Picker

**Files:**
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/App.tsx`
- Test: `web/src/components/__tests__/status-bar.test.tsx`

- [ ] **Step 1: Write failing status-bar tests**

Add tests covering:

```tsx
test("does not render a provider selector", () => {
	render(<StatusBar ... />);
	expect(screen.queryByLabelText(/Provider/i)).toBeNull();
});

test("renders use agent default plus grouped exact models", () => {
	render(<StatusBar ... />);
	expect(screen.getByText("Use agent default")).toBeInTheDocument();
	expect(screen.getByText("Default models")).toBeInTheDocument();
	expect(screen.getByText("OpenRouter · GPT-4.1")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused status-bar tests**

Run:

```bash
bun test web/src/components/__tests__/status-bar.test.tsx
```

Expected: FAIL because the provider selector and old default-provider behavior still exist.

- [ ] **Step 3: Rebuild the web picker**

In `web/src/components/StatusBar.tsx`:

- remove the separate browse-provider state and selector
- build one selection list containing:
  - `Use agent default`
  - configured `Best`, `Balanced`, `Fast`
  - exact models grouped by provider
- ensure exact-model labels always include provider + model
- omit unconfigured default models

- [ ] **Step 4: Re-run the focused status-bar tests**

Run:

```bash
bun test web/src/components/__tests__/status-bar.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/StatusBar.tsx web/src/App.tsx web/src/components/__tests__/status-bar.test.tsx
git commit -m "refactor: replace web provider selector with grouped model picker"
```

## Chunk 4: Rebuild The TUI And Finish The Cleanup

### Task 7: Remove Discovery/Manual Editing From The TUI Provider Editor

**Files:**
- Modify: `src/tui/provider-settings-editor.tsx`
- Modify: `src/tui/settings-panel.tsx`
- Test: `test/tui/provider-settings-editor.test.tsx`
- Test: `test/tui/settings-panel.test.tsx`

- [ ] **Step 1: Write failing TUI-settings tests**

Add tests covering:

```tsx
test("does not expose discovery or manual model commands", () => {
	const frame = render(...).lastFrame();
	expect(frame).not.toContain("Discovery");
	expect(frame).not.toContain("manual");
});

test("renders Default models as a separate settings section", () => {
	const frame = render(<SettingsPanel ... />).lastFrame();
	expect(frame).toContain("Default models");
	expect(frame).not.toContain("fallback");
});
```

- [ ] **Step 2: Run the focused TUI-settings tests**

Run:

```bash
bun test test/tui/provider-settings-editor.test.tsx test/tui/settings-panel.test.tsx
```

Expected: FAIL because the old command surface still exists.

- [ ] **Step 3: Simplify the TUI settings flow**

In the TUI settings files:

- remove discovery/manual model commands and rendering
- remove default-provider language
- keep one `Default models` section with three exact-model tuple selectors
- keep provider editors focused on provider config/auth/refresh/headers

- [ ] **Step 4: Re-run the focused TUI-settings tests**

Run:

```bash
bun test test/tui/provider-settings-editor.test.tsx test/tui/settings-panel.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/provider-settings-editor.tsx src/tui/settings-panel.tsx test/tui/provider-settings-editor.test.tsx test/tui/settings-panel.test.tsx
git commit -m "refactor: simplify tui provider settings ui"
```

### Task 8: Replace The TUI Model Picker And Run Final Verification

**Files:**
- Modify: `src/tui/model-picker.tsx`
- Modify: `src/tui/status-bar.tsx`
- Modify: `src/tui/app.tsx`
- Test: `test/tui/model-picker.test.tsx`
- Test: `test/tui/app.test.tsx`

- [ ] **Step 1: Write failing TUI picker tests**

Add tests covering:

```tsx
test("shows use agent default and grouped exact models", () => {
	const options = buildModelPickerOptions(...);
	expect(options[0]?.label).toContain("Use agent default");
	expect(options.some((option) => option.group === "OpenRouter")).toBe(true);
});

test("does not depend on defaultProviderId", () => {
	expect(buildModelPickerOptions(settingsWithoutDefaultProvider, ...)).toEqual(...);
});
```

- [ ] **Step 2: Run the focused TUI picker tests**

Run:

```bash
bun test test/tui/model-picker.test.tsx test/tui/app.test.tsx
```

Expected: FAIL because the picker still depends on provider context.

- [ ] **Step 3: Rebuild the TUI picker**

In the TUI picker and app/status files:

- remove default-provider/provider-browse assumptions
- add `Use agent default`
- group exact models by provider
- keep only configured default models in the default-model group

- [ ] **Step 4: Run the full verification suite**

Run:

```bash
bun run check
bun run typecheck
bun test
bun run precommit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/model-picker.tsx src/tui/status-bar.tsx src/tui/app.tsx test/tui/model-picker.test.tsx test/tui/app.test.tsx test/helpers/provider-settings.ts
git commit -m "refactor: finish default models and picker cleanup"
```
