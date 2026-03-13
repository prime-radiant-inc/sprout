# Provider Tier Defaults UX Design

## Summary

Sprout should stop treating `best`, `balanced`, and `fast` as global routing concepts. Tiers should
belong to individual providers. A user should first choose a provider, then choose either one of
that provider's configured tier defaults or an exact model from that provider.

The current settings UI leaks internal routing abstractions like provider priority and tier override
lists. That makes a simple user goal like "make OpenRouter's fast model be `gpt-4o-mini`" feel
indirect and error-prone. The redesigned UX makes provider-owned tier defaults the primary model.

## Goals

- Make tier selection easy to understand for normal users.
- Let each provider define its own `best`, `balanced`, and `fast` models.
- Require the user to choose a provider before selecting a tier.
- Keep exact-model selection available without forcing users through tier abstractions.
- Auto-fetch provider model lists and use those fetched models as the only source for tier-default
  selection.
- Fail clearly when a selected provider does not have the requested tier configured.

## Non-Goals

- Preserving the existing provider-priority and tier-override UX.
- Supporting heuristic tier classification as a user-facing fallback.
- Allowing freeform tier model entry.
- Choosing a tier globally across providers without an active provider.

## Product Model

Sprout should expose two separate concepts in the session UI:

- `Provider`
- `Selection`

`Selection` can be one of:

- `Best`
- `Balanced`
- `Fast`
- an exact model from the selected provider

This makes the product rule simple:

- plain `Best` means "best for the currently selected provider"
- changing providers while on `Best`, `Balanced`, or `Fast` keeps the same tier and retargets it to
  the new provider
- if the new provider does not have that tier configured, the UI shows a clear error and tells the
  user to configure that tier on the provider

Every provider may optionally define:

- `Best model`
- `Balanced model`
- `Fast model`

Providers without tier defaults are still usable for exact-model selection.

## Settings UX

The settings experience should be organized around provider configuration, not global routing.

Top-level settings should include:

- `Default provider`
- the provider list

Each provider editor should include:

- connection details
- credentials
- `Refresh models`
- model catalog status
- three tier-default dropdowns:
  - `Best model`
  - `Balanced model`
  - `Fast model`

Rules for the tier-default dropdowns:

- the options come only from the provider's fetched model list
- the controls are disabled when no model list is available
- the empty state tells the user what to do next:
  - `Refresh models to configure tier defaults`
  - or the provider-specific connection failure if refresh failed
- the user can leave one or more tier defaults unset

The current global routing UI should be removed from the normal settings experience:

- no `provider priority`
- no global tier override lists
- no manual per-model tier tagging as the main tier-configuration path

## Session UX

The session picker should become a two-step interaction:

1. choose a `Provider`
2. choose a `Selection`

The `Selection` control should be grouped into:

- `Tier defaults`
  - `Best`
  - `Balanced`
  - `Fast`
- `Exact models`
  - the full fetched model list for the selected provider

Behavior:

- if the user selects a tier and then changes providers, the tier selection stays active and
  resolves against the new provider
- if the provider does not define that tier, the session enters a clear invalid-selection state
  rather than silently guessing
- exact-model selections always remain explicit `provider + model`

Language should match the user model:

- `Default provider`
- `Selected provider`
- `Best model`
- `Balanced model`
- `Fast model`
- `Exact model`

The UX should avoid exposing terms like `routing` or `priority`.

## Runtime Model

The runtime should treat tier resolution as provider-relative and explicit.

Provider configuration should own the tier defaults. The session state should carry:

- the selected provider
- the selection kind:
  - inherited default
  - provider-relative tier
  - explicit provider/model

Tier resolution rules:

- a tier selection only resolves within the selected provider
- if the provider lacks the tier default, resolution fails clearly
- there is no heuristic fallback based on model-name patterns
- exact-model selections do not depend on tier configuration

Model catalogs should still be fetched and refreshed per provider. Tier-default configuration is
blocked until that catalog is available.

## Data Model Direction

The clean implementation should replace the current global routing structure with provider-owned
tier defaults.

Settings should move toward this shape:

```ts
type Tier = "best" | "balanced" | "fast";

interface ProviderTierDefaults {
	best?: string;
	balanced?: string;
	fast?: string;
}

interface ProviderConfig {
	id: string;
	kind: ProviderKind;
	label: string;
	enabled: boolean;
	baseUrl?: string;
	nonSecretHeaders?: Record<string, string>;
	tierDefaults?: ProviderTierDefaults;
	createdAt: string;
	updatedAt: string;
}

interface DefaultsConfig {
	defaultProviderId?: string;
}
```

The old global routing structure should be removed:

- `providerPriority`
- `tierOverrides`

Session selection should continue distinguishing tier selection from exact-model selection, but tier
selection should always be interpreted relative to the active provider rather than across the whole
registry.

## Failure Handling

Failure states should be explicit and actionable.

If a provider has no fetched models:

- disable tier-default dropdowns
- show `Refresh models to configure tier defaults`

If a refresh fails:

- keep the controls disabled
- show the provider-specific error

If a session is on a tier and the selected provider lacks that tier:

- show the current selection as invalid
- explain which provider tier is missing
- provide a direct path to provider settings

The system should never silently substitute a different tier or model.

## Testing

The redesign needs coverage in three places:

- host settings/model-selection tests
  - provider-relative tier resolution
  - clear failure when a tier is unset
  - default-provider behavior
- web tests
  - provider-tier dropdown behavior
  - disabled and empty states before model refresh
  - session picker provider-switch behavior while a tier is selected
- TUI tests
  - provider-relative tier selection
  - clear invalid-selection state when a provider lacks the chosen tier

## Migration Direction

This redesign should not preserve the old routing semantics.

The current provider-priority and tier-override model is the wrong abstraction for the product.
When this design lands, Sprout should stop using those settings and require provider tier defaults
to be configured explicitly.

Providers themselves may be preserved, but users should expect to reconfigure tier defaults under
the new provider-owned model.
