# Provider Tier Defaults UX Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Sprout's global provider-priority/tier-routing model with provider-owned tier defaults, a default provider, and provider-relative session model selection in web, TUI, and runtime resolution.

**Architecture:** Remove the old routing structure from persisted settings and runtime resolution instead of layering new UX on top of it. Providers own optional `best / balanced / fast` model IDs, sessions carry a provider-relative selection, and the host/runtime resolve tiers only against the selected or default provider. There is no compatibility layer for legacy routing settings or unqualified session model selection.

**Tech Stack:** TypeScript on Bun, React web UI, Ink TUI, Bun tests, Biome, existing settings control plane / session controller / agent runtime.

---

## File Map

**Core settings and selection model**

- Modify: `src/host/settings/types.ts`
- Modify: `src/host/settings/validation.ts`
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/host/settings/env-import.ts`
- Modify: `src/host/session-selection.ts`
- Modify: `src/shared/session-selection.ts`
- Modify: `src/shared/available-models.ts`
- Modify: `src/kernel/protocol.ts`
- Modify: `src/kernel/types.ts`

**Runtime model resolution and host wiring**

- Modify: `src/agents/model-resolver.ts`
- Modify: `src/agents/agent.ts`
- Modify: `src/agents/factory.ts`
- Modify: `src/host/session-controller.ts`
- Modify: `src/host/session-metadata.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Modify: `src/host/cli.ts`
- Modify: `src/llm/model-catalog.ts`

**Web UI**

- Delete: `web/src/components/settings/DefaultsPanel.tsx`
- Modify: `web/src/components/settings/ProviderSettingsPanel.tsx`
- Modify: `web/src/components/settings/ProviderList.tsx`
- Modify: `web/src/components/settings/ProviderEditor.tsx`
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/hooks/useEvents.ts`

**TUI**

- Modify: `src/tui/settings-panel.tsx`
- Modify: `src/tui/provider-settings-editor.tsx`
- Modify: `src/tui/model-picker.tsx`
- Modify: `src/tui/status-bar.tsx`
- Modify: `src/tui/app.tsx`

**Tests and fixtures**

- Modify: `test/helpers/provider-settings.ts`
- Modify: `test/agents/model-resolver.test.ts`
- Modify: `test/host/settings-validation.test.ts`
- Modify: `test/host/settings-control-plane.test.ts`
- Modify: `test/host/session-selection.test.ts`
- Modify: `test/host/session-controller-selection.test.ts`
- Modify: `test/host/cli-bootstrap.test.ts`
- Modify: `test/host/cli.test.ts`
- Modify: `test/host/cli-resume.test.ts`
- Modify: `test/llm/model-catalog.test.ts`
- Modify: `web/src/components/__tests__/provider-settings.test.tsx`
- Modify: `web/src/components/__tests__/status-bar.test.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/hooks/useEvents.test.ts`
- Modify: `test/tui/model-picker.test.tsx`
- Modify: `test/tui/settings-panel.test.tsx`
- Modify: `test/tui/status-bar.test.tsx`
- Modify: `test/tui/app.test.tsx`
- Modify: `test/tui/slash-commands.test.ts`

## Chunk 1: Reset The Settings Schema And Command Contract

### Task 1: Replace Routing Settings With Default Provider + Provider Tier Defaults

**Files:**
- Modify: `src/host/settings/types.ts`
- Test: `test/host/settings-validation.test.ts`
- Test: `test/helpers/provider-settings.ts`

- [ ] **Step 1: Write the failing settings-shape tests**

Add tests covering:

```ts
test("requires enabled providers referenced by defaultProviderId to exist", () => {
	const settings = createEmptySettings();
	settings.providers.push(provider({ id: "openrouter-main", enabled: true }));
	settings.defaults.defaultProviderId = "missing";
	expect(() => validateSproutSettings(settings)).toThrow(
		"Default provider must reference an enabled provider: missing",
	);
});

test("allows providers with no tier defaults", () => {
	const settings = createEmptySettings();
	settings.providers.push(provider({ id: "lmstudio", enabled: true }));
	settings.defaults.defaultProviderId = "lmstudio";
	expect(() => validateSproutSettings(settings)).not.toThrow();
});
```

- [ ] **Step 2: Run the focused settings validation test**

Run: `bun test test/host/settings-validation.test.ts`

Expected: FAIL because `defaultProviderId` / `tierDefaults` do not exist yet.

- [ ] **Step 3: Replace the settings types**

In `src/host/settings/types.ts`:

- Remove `ManualModelConfig.tierHint`
- Remove `ManualModelConfig.rank`
- Add:

```ts
export interface ProviderTierDefaults {
	best?: string;
	balanced?: string;
	fast?: string;
}
```

- Add `tierDefaults?: ProviderTierDefaults` to `ProviderConfig`
- Replace:

```ts
export interface DefaultsConfig {
	selection: DefaultSelection;
}

export interface RoutingConfig {
	providerPriority: string[];
	tierOverrides: Partial<Record<Tier, string[]>>;
}
```

with:

```ts
export interface DefaultsConfig {
	defaultProviderId?: string;
}
```

- Remove `DefaultSelection`
- Remove `RoutingConfig`
- Change `SproutSettings` to:

```ts
export interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
}
```

- Update `createEmptySettings()` and `validateSproutSettings()` accordingly.

- [ ] **Step 4: Update shared fixtures**

Update `test/helpers/provider-settings.ts` so sample snapshots use:

- `defaults.defaultProviderId`
- provider-local `tierDefaults`
- no `routing`
- no `tierHint` / `rank`

- [ ] **Step 5: Re-run the focused tests**

Run: `bun test test/host/settings-validation.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/host/settings/types.ts test/host/settings-validation.test.ts test/helpers/provider-settings.ts
git commit -m "refactor: replace routing settings with provider tier defaults"
```

### Task 2: Replace Settings Commands With The New Control Surface

**Files:**
- Modify: `src/host/settings/control-plane.ts`
- Modify: `src/kernel/protocol.ts`
- Modify: `src/kernel/types.ts`
- Test: `test/host/settings-control-plane.test.ts`
- Test: `test/web/protocol.test.ts`

- [ ] **Step 1: Write failing control-plane and protocol tests**

Add tests for:

```ts
test("sets the default provider and clears it when deleted", async () => {
	const result = await plane.execute({
		kind: "set_default_provider",
		data: { providerId: "openrouter-main" },
	});
	expect(result.ok).toBe(true);
	expect(result.snapshot.settings.defaults.defaultProviderId).toBe("openrouter-main");
});

test("updates provider tier defaults from explicit model ids", async () => {
	const result = await plane.execute({
		kind: "set_provider_tier_defaults",
		data: {
			providerId: "openrouter-main",
			tierDefaults: { best: "anthropic/claude-opus-4.1", fast: "openai/gpt-4o-mini" },
		},
	});
	expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test test/host/settings-control-plane.test.ts
bun test test/web/protocol.test.ts
```

Expected: FAIL because the old commands still exist.

- [ ] **Step 3: Replace the command contract**

In `src/host/settings/control-plane.ts`:

- Remove:
  - `set_default_selection`
  - `set_provider_priority`
  - `set_tier_priority`
- Add:

```ts
| { kind: "set_default_provider"; data: { providerId: string } }
| {
		kind: "set_provider_tier_defaults";
		data: {
			providerId: string;
			tierDefaults: {
				best?: string;
				balanced?: string;
				fast?: string;
			};
		};
  }
```

- Update `update_provider` patch support to include `tierDefaults`
- Remove all routing mutation code from delete/enable/create flows
- Validate provider tier-default model IDs against the provider's catalog when available
- Clear `defaultProviderId` when its provider is deleted or disabled

In `src/kernel/protocol.ts`:

- remove validation for the deleted routing commands
- add validation for:
  - `set_default_provider`
  - `set_provider_tier_defaults`

In `src/kernel/types.ts`, make sure the kernel exports the new settings command types.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
bun test test/host/settings-control-plane.test.ts
bun test test/web/protocol.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/host/settings/control-plane.ts src/kernel/protocol.ts src/kernel/types.ts test/host/settings-control-plane.test.ts test/web/protocol.test.ts
git commit -m "refactor: replace routing commands with provider tier defaults"
```

## Chunk 2: Make Model Resolution Provider-Relative

### Task 3: Replace Heuristic Tier Routing With Explicit Provider Tier Defaults

**Files:**
- Modify: `src/agents/model-resolver.ts`
- Modify: `src/llm/model-catalog.ts`
- Test: `test/agents/model-resolver.test.ts`
- Test: `test/llm/model-catalog.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Add tests for:

```ts
test("resolves best only from the selected provider tier defaults", () => {
	const result = resolveModel(
		"best",
		settingsFor([
			provider({
				id: "openrouter-main",
				enabled: true,
				tierDefaults: { best: "anthropic/claude-opus-4.1" },
			}),
		], "openrouter-main"),
		catalogFor({
			"openrouter-main": ["anthropic/claude-opus-4.1"],
		}),
		{ providerId: "openrouter-main" },
	);
	expect(result).toEqual({
		provider: "openrouter-main",
		model: "anthropic/claude-opus-4.1",
	});
});

test("fails when a provider tier default is unset", () => {
	expect(() =>
		resolveModel("fast", settingsFor([provider({ id: "lmstudio", enabled: true })], "lmstudio"), new Map(), {
			providerId: "lmstudio",
		}),
	).toThrow("Provider 'lmstudio' does not define a 'fast' model");
});
```

- [ ] **Step 2: Run focused resolver tests**

Run:

```bash
bun test test/agents/model-resolver.test.ts
bun test test/llm/model-catalog.test.ts
```

Expected: FAIL because the resolver still uses provider priority and `classifyTier()`.

- [ ] **Step 3: Rewrite the resolver and catalog**

In `src/agents/model-resolver.ts`:

- Replace `ResolverSettings.routing` with:

```ts
providers: Array<{
	id: string;
	enabled: boolean;
	tierDefaults?: ProviderTierDefaults;
}>;
defaults: {
	defaultProviderId?: string;
};
```

- Change `resolveModel()` to accept provider context:

```ts
resolveModel(selection, settings, catalog, { providerId?: string })
```

- Tier resolution must:
  - choose `providerId` from the explicit context first
  - otherwise use `settings.defaults.defaultProviderId`
  - fail if no provider is available
  - fail if the provider tier default is unset

In `src/llm/model-catalog.ts`:

- Remove `classifyTier()`
- Remove `tierHint` / `rank` merging behavior
- Keep catalog behavior as plain fetched/manual models with labels and source

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
bun test test/agents/model-resolver.test.ts
bun test test/llm/model-catalog.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/model-resolver.ts src/llm/model-catalog.ts test/agents/model-resolver.test.ts test/llm/model-catalog.test.ts
git commit -m "refactor: make model resolution provider-relative"
```

### Task 4: Replace Session Selection With Provider-Relative Selection

**Files:**
- Modify: `src/shared/session-selection.ts`
- Modify: `src/host/session-selection.ts`
- Modify: `src/host/session-metadata.ts`
- Modify: `src/host/session-controller.ts`
- Modify: `src/agents/agent.ts`
- Modify: `src/agents/factory.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Test: `test/host/session-selection.test.ts`
- Test: `test/host/session-controller-selection.test.ts`
- Test: `test/host/session-metadata.test.ts`
- Test: `test/host/cli-bootstrap.test.ts`
- Test: `test/agents/factory.test.ts`
- Test: `test/agents/agent.test.ts`

- [ ] **Step 1: Write failing provider-relative session tests**

Add tests for:

```ts
test("stores provider on inherit selections", () => {
	const parsed = parseSessionSelectionRequest("inherit", "openrouter-main");
	expect(parsed).toEqual({ kind: "inherit", providerId: "openrouter-main" });
});

test("switching providers keeps a tier selection on the new provider", () => {
	const snapshot = resolveSessionSelectionRequest(
		{ kind: "tier", providerId: "openrouter-main", tier: "best" },
		context,
	);
	expect(snapshot.resolved?.providerId).toBe("openrouter-main");
});
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test test/host/session-selection.test.ts
bun test test/host/session-controller-selection.test.ts
bun test test/host/session-metadata.test.ts
```

Expected: FAIL because `SessionModelSelection` does not carry provider context.

- [ ] **Step 3: Replace selection shapes and agent resolver wiring**

In `src/shared/session-selection.ts` and `src/host/session-selection.ts`:

- remove `unqualified_model`
- require exact session models to be provider-qualified
- change `SessionModelSelection` to carry provider context:

```ts
| { kind: "inherit"; providerId?: string }
| { kind: "tier"; providerId: string; tier: Tier }
| { kind: "model"; model: ModelRef }
```

In `src/host/session-metadata.ts`:

- remove `LegacySessionMetadataSnapshot`
- persist only the new session-selection shape

In `src/agents/agent.ts` / `src/agents/factory.ts`:

- thread resolver settings / provider context into agent construction
- resolve agent-spec tiers relative to the selected or default provider
- remove fallback dependence on global provider ordering

In `src/host/cli-bootstrap.ts`:

- build runtime resolver settings from the live settings snapshot
- use `defaultProviderId` and provider `tierDefaults`
- remove routing-derived selection context

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
bun test test/host/session-selection.test.ts
bun test test/host/session-controller-selection.test.ts
bun test test/host/session-metadata.test.ts
bun test test/host/cli-bootstrap.test.ts
bun test test/agents/factory.test.ts
bun test test/agents/agent.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/session-selection.ts src/host/session-selection.ts src/host/session-metadata.ts src/host/session-controller.ts src/agents/agent.ts src/agents/factory.ts src/host/cli-bootstrap.ts test/host/session-selection.test.ts test/host/session-controller-selection.test.ts test/host/session-metadata.test.ts test/host/cli-bootstrap.test.ts test/agents/factory.test.ts test/agents/agent.test.ts
git commit -m "refactor: make session selection provider-relative"
```

## Chunk 3: Replace The Web Settings And Picker UX

### Task 5: Replace Defaults/Routing With Default Provider + Tier Defaults

**Files:**
- Delete: `web/src/components/settings/DefaultsPanel.tsx`
- Modify: `web/src/components/settings/ProviderSettingsPanel.tsx`
- Modify: `web/src/components/settings/ProviderList.tsx`
- Modify: `web/src/components/settings/ProviderEditor.tsx`
- Test: `web/src/components/__tests__/provider-settings.test.tsx`

- [ ] **Step 1: Write failing web settings tests**

Add tests for:

```tsx
test("renders default provider selection instead of routing controls", () => {
	const html = renderToStaticMarkup(
		<ProviderSettingsPanel settings={makeSettingsSnapshot()} lastResult={null} onCommand={() => {}} onClose={() => {}} />,
	);
	expect(html).toContain("Default provider");
	expect(html).not.toContain("Defaults and routing");
	expect(html).not.toContain("Provider priority");
});

test("renders provider tier-default selectors from the catalog", () => {
	const html = renderToStaticMarkup(
		<ProviderEditor ...provider={providerWithCatalog} ... />,
	);
	expect(html).toContain("Best model");
	expect(html).toContain("Balanced model");
	expect(html).toContain("Fast model");
});
```

- [ ] **Step 2: Run the focused web settings test**

Run: `bun test web/src/components/__tests__/provider-settings.test.tsx`

Expected: FAIL because the old routing UI still renders.

- [ ] **Step 3: Rewrite the settings UI**

In `ProviderSettingsPanel.tsx` / `ProviderList.tsx`:

- replace the `defaults` view with a `default provider` view
- remove every `routing` label and action

In `ProviderEditor.tsx`:

- remove manual model tier/rank configuration from the tier-default path
- add three provider-local dropdowns fed from `catalogEntry?.models`
- add a `Set default provider` action or move it to the top-level panel
- keep `Refresh models`, but make tier dropdowns disabled until the catalog exists

Delete `web/src/components/settings/DefaultsPanel.tsx` once the new provider/default controls own its responsibilities.

- [ ] **Step 4: Re-run the focused web settings test**

Run: `bun test web/src/components/__tests__/provider-settings.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/settings/ProviderSettingsPanel.tsx web/src/components/settings/ProviderList.tsx web/src/components/settings/ProviderEditor.tsx web/src/components/__tests__/provider-settings.test.tsx
git rm web/src/components/settings/DefaultsPanel.tsx
git commit -m "refactor: replace routing settings with provider tier defaults"
```

### Task 6: Replace The Web Session Picker With Provider + Selection

**Files:**
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/hooks/useEvents.ts`
- Modify: `web/src/App.tsx`
- Modify: `src/shared/available-models.ts`
- Test: `web/src/components/__tests__/status-bar.test.tsx`
- Test: `web/src/hooks/useEvents.test.ts`
- Test: `web/src/App.test.tsx`

- [ ] **Step 1: Write failing web picker tests**

Add tests for:

```tsx
test("builds grouped options for the selected provider", () => {
	const options = buildSessionSelectionOptions(statusWithProvider("openrouter-main"), settings);
	expect(options.map((option) => option.label)).toContain("Best");
	expect(options.map((option) => option.label)).toContain("Exact models");
});

test("switching provider keeps the active tier selection", () => {
	// Assert optimistic state becomes { kind: "tier", providerId: "lmstudio", tier: "best" }
});
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test web/src/components/__tests__/status-bar.test.tsx
bun test web/src/hooks/useEvents.test.ts
bun test web/src/App.test.tsx
```

Expected: FAIL because the picker is still a single routing-derived list.

- [ ] **Step 3: Rewrite the web picker**

In `StatusBar.tsx`:

- split the control into provider selection + provider-relative selection
- show tier defaults first, exact models second
- remove global tier availability from `deriveAvailableModels()`

In `useEvents.ts`:

- update optimistic `switch_model` handling for provider-relative selections
- keep `currentSelection` in sync with provider changes

In `App.tsx`:

- update slash-command handling so exact models require `provider:model`
- stop sending unqualified-model requests

In `src/shared/available-models.ts`:

- stop manufacturing global `best / balanced / fast`
- provide helpers that expose provider catalog models without pretending tiers exist globally

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
bun test web/src/components/__tests__/status-bar.test.tsx
bun test web/src/hooks/useEvents.test.ts
bun test web/src/App.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/StatusBar.tsx web/src/hooks/useEvents.ts web/src/App.tsx src/shared/available-models.ts web/src/components/__tests__/status-bar.test.tsx web/src/hooks/useEvents.test.ts web/src/App.test.tsx
git commit -m "refactor: replace web model picker with provider-relative selection"
```

## Chunk 4: Replace The TUI And Finish Integration

### Task 7: Rewrite The TUI Settings And Model Picker

**Files:**
- Modify: `src/tui/settings-panel.tsx`
- Modify: `src/tui/provider-settings-editor.tsx`
- Modify: `src/tui/model-picker.tsx`
- Modify: `src/tui/status-bar.tsx`
- Modify: `src/tui/app.tsx`
- Test: `test/tui/settings-panel.test.tsx`
- Test: `test/tui/model-picker.test.tsx`
- Test: `test/tui/status-bar.test.tsx`
- Test: `test/tui/app.test.tsx`
- Test: `test/tui/slash-commands.test.ts`

- [ ] **Step 1: Write failing TUI tests**

Add tests for:

```ts
test("shows default provider instead of defaults and routing", () => {
	expect(lastFrame()).toContain("Default provider");
	expect(lastFrame()).not.toContain("Defaults and routing");
});

test("lists tiers and exact models for the selected provider", () => {
	const options = buildModelPickerOptions(...);
	expect(options.map((option) => option.label)).toContain("Best");
	expect(options.map((option) => option.label)).toContain("OpenRouter · anthropic/claude-opus-4.1");
});
```

- [ ] **Step 2: Run focused TUI tests**

Run:

```bash
bun test test/tui/settings-panel.test.tsx
bun test test/tui/model-picker.test.tsx
bun test test/tui/status-bar.test.tsx
bun test test/tui/app.test.tsx
bun test test/tui/slash-commands.test.ts
```

Expected: FAIL because the TUI still exposes routing.

- [ ] **Step 3: Rewrite the TUI**

In `settings-panel.tsx` / `provider-settings-editor.tsx`:

- remove the routing summary and commands
- add default-provider controls
- add provider-local tier-default editing from the catalog list

In `model-picker.tsx` / `status-bar.tsx` / `app.tsx`:

- switch to provider-relative picker behavior
- preserve tiers on provider change
- require provider-qualified exact models in slash commands

- [ ] **Step 4: Re-run focused TUI tests**

Run:

```bash
bun test test/tui/settings-panel.test.tsx
bun test test/tui/model-picker.test.tsx
bun test test/tui/status-bar.test.tsx
bun test test/tui/app.test.tsx
bun test test/tui/slash-commands.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/settings-panel.tsx src/tui/provider-settings-editor.tsx src/tui/model-picker.tsx src/tui/status-bar.tsx src/tui/app.tsx test/tui/settings-panel.test.tsx test/tui/model-picker.test.tsx test/tui/status-bar.test.tsx test/tui/app.test.tsx test/tui/slash-commands.test.ts
git commit -m "refactor: replace tui routing controls with provider tier defaults"
```

### Task 8: Remove Dead Routing Code And Run Full Verification

**Files:**
- Modify: remaining touched files from prior tasks
- Test: `bun test`

- [ ] **Step 1: Remove dead routing helpers and obsolete tests**

Delete or inline code that should no longer exist:

- routing command helpers in web settings tests
- `deriveAvailableModels()` behavior that manufactures global tiers
- manual-model tier/rank handling left behind in shared helpers
- any unused routing labels, props, or test fixtures

- [ ] **Step 2: Run repo-wide quality checks**

Run:

```bash
bun run check
bun run typecheck
bun test
bun run precommit
```

Expected: all PASS

- [ ] **Step 3: Commit the integration cleanup**

```bash
git status --short
git add <only the files touched by this refactor>
git commit -m "refactor: finish provider tier defaults redesign"
```

- [ ] **Step 4: Manual sanity pass**

Run the app and verify:

```bash
bun src/host/cli.ts --web
```

Check:

- settings shows `Default provider`
- provider editor shows `Best model`, `Balanced model`, `Fast model`
- tier dropdowns stay disabled until models load
- session picker is provider-first
- changing provider while on a tier keeps the same tier
- selecting a provider without that tier configured fails clearly

## Notes For The Implementer

- Do not preserve the old routing schema in-memory or at the protocol boundary.
- Do not keep the unqualified-model request path.
- Do not leave unused routing helper code behind "for later".
- Keep commits small and verification real after each chunk.
