# Default Models And Provider Settings Cleanup Design

## Summary

Sprout should expose one global `Default models` surface and one provider-configuration surface.
The root session picker should not have a separate provider selector. Instead, it should show:

- `Best`
- `Balanced`
- `Fast`
- exact models grouped by provider

The current UI and data model still carry wrong abstractions from previous iterations:

- `defaultProviderId`
- provider-scoped interpretation of `Best` / `Balanced` / `Fast`
- user-facing `Discovery strategy`
- manual model entry and manual/remote merge behavior
- bare exact-model resolution without an explicit provider

This spec removes those abstractions rather than hiding them behind more UI.

This design supersedes:

- `docs/superpowers/specs/2026-03-12-provider-tier-defaults-ux-design.md`
- the relevant parts of `docs/superpowers/specs/2026-03-11-provider-backends-and-config-ui-design.md`

## Goals

- Make `Default models` the only global shortcut concept.
- Remove the root-session provider selector from the main UI.
- Let exact model selection remain available, but always as an explicit `provider + model`.
- Separate `Default models` from provider tabs in settings so it does not look like just another
  provider.
- Remove `Discovery strategy` from the product entirely.
- Clean up vestigial settings/runtime code instead of preserving it.

## Non-Goals

- Preserving backward compatibility for old settings fields or old selection semantics.
- Keeping a fallback/default provider concept.
- Supporting bare exact-model input such as `/model gpt-4.1`.
- Keeping multiple discovery modes in the user-facing or persisted product model.
- Preserving existing settings files that still use the removed model-selection schema.

## Product Model

Sprout should expose only two model-selection concepts:

- `Default models`
  - `Best`
  - `Balanced`
  - `Fast`
  - each is one explicit `provider + model` tuple
- `Exact models`
  - exact provider/model pairs grouped under each provider

Session state may also be `inherit`, which means "use the agent's configured model selection with no
session override." `inherit` is not a default model and not an exact model; it is simply the
absence of a session-local override.

There is no separate provider choice in the root session UX. Provider only appears as part of an
exact-model option or as the provider component of a default-model tuple.

This means:

- `Best`, `Balanced`, and `Fast` are global defaults, not provider-relative aliases
- exact-model selection is always explicit
- a provider is never inferred implicitly for exact-model use
- `inherit` remains valid, but it never implies a hidden provider-selection mode

## Settings UX

Settings should have two clearly separate surfaces:

### Default models

A dedicated top-level section named `Default models` should contain exactly three selectors:

- `Best`
- `Balanced`
- `Fast`

Each selector should show available exact models grouped by provider. These controls define the
global provider/model tuple for each default model.

If no models are available yet, the section should say `Refresh models on a provider to configure
default models.`

### Providers

Each provider tab/editor should only manage provider configuration:

- provider kind
- label
- credentials
- connection test
- refresh models
- optional non-secret headers where supported

Provider editors must not contain:

- provider-owned best/balanced/fast fields
- discovery strategy controls
- manual model editors
- routing or priority controls

`Default models` must be visually and structurally distinct from the provider tabs so it does not
read as another provider.

## Root Session UX

The root status bar should expose a single model selector.

That selector should contain:

- `Use agent default`
- group `Default models`
  - `Best`
  - `Balanced`
  - `Fast`
- grouped exact models by provider

There should be no separate provider dropdown on the front page.

Exact-model labels should include both provider and model so the choice is self-contained.

If a default model is not configured, it should not appear as a selectable option in the root
picker. The place to configure it is settings, not the status bar.

`Use agent default` is the only affordance for returning to `inherit`. There should be no separate
provider selector or fallback-provider affordance in the root status bar.

## TUI UX

The TUI should follow the same product model:

- one model picker
- one `Use agent default` option
- no separate provider chooser for the root session
- `Default models` first
- exact models grouped by provider after that

The TUI settings flow should mirror the web information architecture:

- one `Default models` section
- separate provider editors
- no discovery strategy controls

## Runtime Model

The runtime should remove implicit-provider resolution for exact models.

Selection semantics become:

- `inherit`
- one of the global default models: `best`, `balanced`, `fast`
- an explicit `ModelRef { providerId, modelId }`

Resolution rules:

- `best`, `balanced`, and `fast` resolve only through the global default-model tuples
- exact models require an explicit provider
- there is no fallback/default provider path
- there is no provider-relative interpretation of default models

Slash-command behavior:

- `/model best|balanced|fast|inherit` stays valid
- `/model provider:model` stays valid
- `/model model` becomes a validation error with a clear message telling the user to specify
  `provider:model`

Agent-spec and frontmatter behavior must follow the same rule:

- agent model declarations may be `best`, `balanced`, `fast`, `inherit`, or `provider:model`
- bare exact-model ids are invalid everywhere, not just in root-session commands
- any parsing or runtime path that still accepts bare exact-model ids must be removed

## Provider Discovery Model

Sprout should always use one provider discovery behavior:

- fetch remote models
- cache the fetched catalog locally in settings/runtime state

There should be no user-facing discovery strategy choice, no persisted strategy field, and no
manual model entry path in the product model.

If a provider cannot be refreshed, the provider editor should show the error and keep the last known
catalog state semantics already used elsewhere. The important rule is that discovery mode is not a
thing the user configures.

## Data Model Direction

The persisted settings model should move toward:

```ts
interface DefaultsConfig {
	best?: ModelRef;
	balanced?: ModelRef;
	fast?: ModelRef;
}

interface ProviderConfig {
	id: string;
	kind: ProviderKind;
	label: string;
	enabled: boolean;
	baseUrl?: string;
	nonSecretHeaders?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
}
```

Fields and concepts to remove:

- `defaultProviderId`
- provider-owned default-model fields
- `discoveryStrategy`
- `manualModels`
- any remaining routing/priority fields
- any compatibility parsing for bare exact models

The implementation should prefer deleting dead abstractions over leaving hidden vestigial code
behind.

## Cleanup Requirement

This work must remove the abandoned settings/runtime concepts from both product behavior and code,
not merely hide them in the UI.

Specifically, implementation should remove or collapse:

- fallback/default provider semantics
- provider-relative default-model resolution
- user-facing and persisted discovery strategies
- manual model editing and manual/remote merge behavior
- stale normalization/migration paths that only exist to preserve these discarded concepts

If a helper, setting field, command, or UI branch exists only to support those old models, it
should be deleted.

## Failure Handling

- If a default model is unset, settings should show it as unset and the root picker should omit it.
- If an exact model is selected through a slash command without a provider prefix, the command
  should fail with a clear instruction.
- If a configured default model points at a provider/model that no longer exists, the runtime should
  fail clearly and settings should surface the broken reference.
- If a configured default model points at a provider/model that no longer exists in the current
  catalog, settings must still render the broken stored value explicitly, for example as
  `Unavailable: provider · model`, rather than hiding or silently clearing it.
- If a provider catalog is unavailable, the provider editor should explain that model refresh is
  needed or failed; the default-model picker should only show models that currently exist in the
  catalog snapshot.

## Testing

This redesign needs focused coverage across:

- settings validation and persistence
  - no `defaultProviderId`
  - no `discoveryStrategy`
  - default models stored as explicit `ModelRef`s
- selection parsing and runtime resolution
  - reject bare exact-model input
  - resolve `best|balanced|fast` only through global defaults
  - reject bare exact-model ids in agent specs/frontmatter
- web UI
  - no provider selector in the root status bar
  - explicit `Use agent default` option
  - grouped exact-model options in one selector
  - `Default models` rendered as a distinct settings section
  - no discovery controls in provider editors
- TUI
  - same single-picker behavior
  - same settings separation
  - no discovery commands/fields

- invalid default-model rendering
  - broken stored provider/model references remain visible and actionable in settings

## Migration Direction

No backward compatibility is required for this redesign.

This change should ship as a schema break:

- bump the settings schema version
- reject old settings documents that still contain removed fields or removed semantics
- recover the old file aside rather than loading it leniently

The implementation should not normalize old `defaultProviderId`, discovery, manual-model, or bare
exact-model settings into the new shape. It should reject the old shape and make the cleanup
explicit.
