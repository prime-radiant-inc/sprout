# Agent Model Policy Overrides Implementation Plan

> **For Claude/Codex:** Execute this plan in small verified commits. Do not skip tests.
> Keep the implementation clean: no legacy compatibility shims, no implicit fallbacks, and
> no special model-purpose case for `observer.metacognitive`.

## Goal

Expose every stable Sprout agent type in the web Models UI and let the user configure
how each agent selects a model:

- Use the model declared in the agent markdown spec.
- Use one of the standard configured tiers: `best`, `balanced`, or `fast`.
- Pin the agent to an exact `provider:model`.

This fixes the current failure mode where runtime can require
`observer.metacognitive` but the web UI cannot configure it. The correct product shape
is not to add a one-off metacognitive row. The correct shape is to make all agent types
discoverable and configurable using the same model-selection vocabulary.

## Constraints And Decisions

- Use stable agent type/spec keys, not runtime agent handles.
- Keep memory jobs in the same Models pane, but do not model them as agents.
- Remove `observer.metacognitive` as a user-facing model-purpose concept.
- Store configurable model behavior in Sprout settings.
- Allow environment overrides only through generic env vars, not per-agent special cases.
- Absence of an agent override means "use the agent markdown default."
- No back-compat migrations are required. Update schema and fixtures directly.
- No silent fallback. If a tier or exact model is unavailable, surface a settings error.

## Product Shape

The Models pane should have one place to reason about model selection:

- **Default Tiers:** configure exact models for `best`, `balanced`, and `fast`.
- **Agent Types:** list all discovered agent specs and configure each as inherit, tier,
  or exact model.
- **Memory Jobs:** configure exact models for memory-specific calls.
- **Providers:** keep provider credentials/configuration in the same area, either in a
  sibling tab/section or below the model sections.

Agent rows should show:

- Display name, for example `metacognitive`, `root`, `utility/reader`.
- Stable key used by settings.
- Markdown default, for example `balanced` or `anthropic:claude-sonnet-4-5`.
- Current override, if any.
- Effective resolved model or a clear validation error.

The row selector should support:

- `Use agent default`
- `Best`
- `Balanced`
- `Fast`
- Exact provider/model options grouped by provider

## Settings Model

Add schema version 4 and replace special-purpose agent model settings with general
agent model overrides.

```ts
export type ModelTier = "best" | "balanced" | "fast";

export type ModelRef = {
	providerId: string;
	modelId: string;
};

export type AgentModelOverride =
	| { kind: "tier"; tier: ModelTier }
	| { kind: "model"; model: ModelRef };

export type AgentModelOverridesConfig = Record<string, AgentModelOverride>;

export type ProviderSettingsV4 = {
	version: 4;
	defaultModels: Record<ModelTier, ModelRef | null>;
	memoryModels: MemoryModelsConfig;
	agentModelOverrides: AgentModelOverridesConfig;
	providers: ProviderConfig[];
};
```

Do not persist `{ kind: "inherit" }`. Inherit is represented by a missing key.

Keep memory models exact-only unless there is already code that strongly benefits from
sharing the same union. Memory jobs are system calls, not agent specs, and the prior
memory-design decision was "no fallbacks."

## Environment Overrides

Keep existing env overrides for default tiers and memory jobs if they already exist and
are current. Remove the special metacognitive env override.

Add one generic agent override env var:

```bash
SPROUT_AGENT_MODEL_OVERRIDES='{
  "root": "best",
  "metacognitive": "balanced",
  "utility/reader": "openai:gpt-4.1-mini"
}'
```

Parsing rules:

- `best`, `balanced`, and `fast` become tier overrides.
- `provider:model` becomes an exact-model override.
- Unknown tiers, malformed refs, unavailable providers, and unavailable models are
  validation errors.
- Env overrides take precedence over stored settings.
- Env overrides do not mutate the settings file.

## Agent Keys

Use stable spec keys:

- Root agent key: `root`.
- File-tree agents: tree path relative to `root/agents`, without `.md`.
- Overlay-only/genome agents: agent name.

Examples:

- `root`
- `metacognitive`
- `balcony`
- `utility/reader`
- `tech-lead/engineer`

If duplicate keys are discovered, the catalog builder must produce a validation error
instead of choosing one arbitrarily.

## Runtime Resolution

Current agent model resolution is centered around the markdown `model` field and a
session-level model override. Replace the special-purpose handling with a general
agent policy lookup.

Resolution precedence:

1. Runtime/session explicit model override, when present. This is mainly the root
   session model selection and should continue to work.
2. Agent model override from settings/env, looked up by stable agent key.
3. Agent markdown `model` field.

The resolver must validate every final selection. It must not silently substitute a
different model.

Expected helper:

```ts
export function resolveAgentModelSelection(input: {
	agentKey: string;
	agentName: string;
	specModel: string;
	sessionOverride?: SessionModelSelection;
	settings: ResolvedProviderSettings;
	catalog: ModelCatalog;
}): ResolvedModelSelection;
```

If both `agentKey` and `agentName` are useful during transition inside the runtime,
lookup by `agentKey` first and `agentName` second. The public settings key should still
be the catalog key.

## Agent Catalog Discovery

Add a host-side catalog builder that discovers agent specs for settings/UI.

Likely new file:

```text
src/host/settings/agent-model-catalog.ts
```

Responsibilities:

- Read `root.md` and include it as key `root`.
- Scan `root/agents/**.md` using the existing agent tree scanning utilities.
- Include overlay-only agents from the active `Genome`.
- Extract display name, key, source, path, description, and markdown default model.
- Compute effective selection and validation status using current settings.
- Return stable sorted descriptors for UI.

Descriptor shape:

```ts
export type AgentModelDescriptor = {
	key: string;
	name: string;
	source: "root" | "tree" | "overlay";
	path?: string;
	description?: string;
	defaultModel: string;
	override?: AgentModelOverride;
	effective: {
		selection: "default" | "tier" | "model";
		label: string;
		model?: ModelRef;
		error?: string;
	};
};
```

Build the catalog on settings snapshot reads rather than only once at process start if
that fits the existing control-plane shape. If that is awkward, startup discovery is
acceptable for v1, but document that newly learned agents appear after restart.

## Backend Implementation Tasks

1. Update provider settings types.

- Move to schema version 4.
- Add `agentModelOverrides`.
- Remove `agentModels`/`AgentModelPurpose` special-purpose configuration.
- Remove `observer.metacognitive` from required model-purpose validation.
- Update all settings fixtures and tests to version 4.

2. Add generic parsing and validation.

- Parse stored agent overrides.
- Parse `SPROUT_AGENT_MODEL_OVERRIDES`.
- Validate exact provider/model refs.
- Validate tier refs against configured default tiers.
- Return precise warnings/errors for incomplete rows.

3. Build the agent model catalog.

- Add catalog builder.
- Include root, file-tree agents, and overlay-only agents.
- Detect duplicate keys.
- Include effective model information and validation errors.

4. Wire settings control-plane commands.

- Add a command to set or clear an agent model override.
- Reuse existing provider/model validation helpers.
- Return updated snapshot after changes.

Suggested command payload:

```ts
type SetAgentModelOverrideCommand = {
	type: "set_agent_model_override";
	agentKey: string;
	override: AgentModelOverride | null;
};
```

5. Apply agent overrides at runtime.

- Thread `agentKey` into agent construction/spawning.
- Root uses `root`.
- Child agents use discovered tree key when available.
- Overlay-only agents use their stable genome name.
- Replace special metacognitive model-purpose resolution with generic lookup.
- Keep session override precedence intact.

6. Update observer defaults.

- Change `root/agents/metacognitive.md` from special `observer.metacognitive` model
  purpose to a standard tier, likely `balanced`.
- If `root/agents/balcony.md` uses a standard tier already, leave it alone.
- Do not add a metacognitive-specific setting or env var.

## Web UI Tasks

1. Rework the provider settings panel into one Models area.

Likely files:

```text
web/src/components/provider-settings.tsx
web/src/components/provider-settings/
web/src/components/__tests__/provider-settings.test.tsx
```

Keep naming churn low if component names are already established, but the rendered UI
should present this as "Models" rather than separate "Default models" and "Memory
models" panes.

2. Add an Agent Types section.

- Render all `AgentModelDescriptor` rows.
- Add a search/filter box if the list is long.
- Group or sort by key.
- Show default, override, effective model, and validation error.
- Allow setting inherit/tier/exact model.
- Clear override when user chooses `Use agent default`.

3. Merge default and memory model controls into the same pane.

- Default tiers remain exact provider/model selectors.
- Memory jobs remain exact provider/model selectors.
- Provider credential configuration remains available without hiding model validation.

4. Preserve "no fallback" UX.

- Missing tiers used by agent defaults should be visible.
- Missing exact models should be visible.
- The UI should not silently pick another available model.

## Test Plan

Unit tests:

- Settings parser accepts version 4 with `agentModelOverrides`.
- Settings parser rejects malformed agent override values.
- Env parser accepts tier and exact-model overrides.
- Env parser rejects malformed or unavailable overrides.
- Snapshot validation reports missing tiers used by agent specs.
- Snapshot validation reports exact provider/model refs that are unavailable.
- Catalog builder includes `root`, file-tree agents, and overlay-only agents.
- Catalog builder rejects duplicate keys.
- Resolver precedence is session override, agent override, markdown default.
- Resolver does not fall back when tier or exact model is missing.

Runtime tests:

- Root agent can start with no per-agent override and uses markdown default.
- Metacognitive observer starts with a standard tier default and no special purpose.
- A configured `metacognitive -> fast` override is applied.
- A configured nested agent path override is applied to that nested agent only.
- Session `/model` override still wins for the root session.

Web tests:

- Models pane renders default tiers, memory jobs, providers, and agent types.
- Agent row shows `Use agent default` when no override is stored.
- Selecting `fast` sends `set_agent_model_override`.
- Selecting an exact model sends `set_agent_model_override`.
- Selecting `Use agent default` clears the stored override.
- Validation errors are rendered for missing tier/exact-model rows.

Suggested commands:

```bash
bun test test/host/settings-store.test.ts test/host/settings-control-plane.test.ts
bun test test/host/settings/agent-model-catalog.test.ts test/agents/model-resolver.test.ts
bun test web/src/components/__tests__/provider-settings.test.tsx
bun run check
bun run typecheck
bun test
```

If web build scripts exist in this repo, also run the web build after UI changes.

## Manual Verification

1. Start Sprout with clean settings.
2. Open the web Models UI.
3. Confirm `metacognitive` appears as a normal agent type.
4. Set `metacognitive` to `fast`.
5. Start a session that enables the metacognitive observer.
6. Confirm the session does not fail with `observer.metacognitive`.
7. Confirm logs/runtime state show the observer using the configured fast model.
8. Pin `metacognitive` to an exact model and repeat.
9. Remove the override and confirm it returns to the markdown default.

Also run a negative smoke:

1. Set `SPROUT_AGENT_MODEL_OVERRIDES='{"metacognitive":"missing:bad"}'`.
2. Start settings/runtime.
3. Confirm the error is explicit and no fallback model is used.

## Commit Plan

Commit 1:

```text
feat: add agent model override settings
```

- Schema v4.
- Generic override types and env parsing.
- Tests for settings validation.

Commit 2:

```text
feat: discover configurable agent model targets
```

- Agent model catalog builder.
- Snapshot integration.
- Catalog tests.

Commit 3:

```text
feat: apply agent model overrides at runtime
```

- Resolver changes.
- Agent key threading.
- Remove `observer.metacognitive` special handling.
- Runtime tests.

Commit 4:

```text
feat: expose agent model policies in settings UI
```

- Unified Models pane.
- Agent type controls.
- Web tests.

Commit 5, only if needed:

```text
test: cover agent model policy smoke paths
```

- Manual-test harness or additional integration tests discovered during implementation.

## Risks

- Agent key threading may expose places where runtime constructs agents without tree
  context. Fix by making the key explicit at construction boundaries, not by inferring
  from names deep inside the resolver.
- Genome overlay agents may not have a path. Use their stable names and reject
  duplicates.
- The Models UI may get long. Start with search and stable sorting, not a complex
  hierarchy.
- Tests may have many version-3 settings fixtures. Update them directly instead of
  adding compatibility normalization.
- Existing code may assume memory models and default models live in separate panels.
  Refactor around shared controls rather than duplicating selector logic.

## Definition Of Done

- `observer.metacognitive` is gone from settings and runtime model requirements.
- `metacognitive` appears in the web UI as a normal configurable agent type.
- Every discovered agent type can inherit, use a tier, or pin exact provider/model.
- Settings are stored in Sprout settings and can be overridden by generic env config.
- Missing/incomplete model configuration fails explicitly without fallback.
- Unit, runtime, and web tests pass.
- A manual smoke confirms metacognitive observer startup with default, tier override,
  exact override, and invalid override paths.
