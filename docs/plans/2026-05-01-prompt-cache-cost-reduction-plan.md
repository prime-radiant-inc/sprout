# Prompt Cache Cost Reduction Plan

## Purpose

The latest cacheprobe benchmark showed Sprout costing more than the comparable
Claude Code run. The first hypothesis was that Sprout pays too much cache setup
cost because it spawns many short-lived agents and each agent currently places
Anthropic cache breakpoints on system, tools, and recent history.

The adversarial reviews changed the order of operations: the current cost math
is not trustworthy enough to optimize against. The first implementation step is
therefore normalized usage and accurate cache billing. Only after that should we
flip cache behavior and measure whether history breakpoints are actually the
right lever.

## Sources Checked

- Anthropic prompt caching docs: `tools -> system -> messages` prefix order,
  four explicit breakpoint limit, separate `input_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`, 5m write pricing at
  1.25x input, 1h write pricing at 2x input, cache reads at 0.1x input, and
  exact-prefix matching requirements.
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- OpenAI prompt caching docs: prompt caching is automatic; `prompt_cache_key`
  affects routing/cache-hit locality rather than creating a separately billed
  cache write.
  https://developers.openai.com/api/docs/guides/prompt-caching
- Gemini context caching docs: explicit cached-content resources are a different
  provider mechanism with minimum input and storage-duration billing concerns.
  https://ai.google.dev/gemini-api/docs/caching

## Current Implementation

Sprout enables provider prompt caching in `buildPlanRequest()` when a session id
and agent name are present. For Anthropic, this currently becomes:

```ts
providerOptions.anthropic = {
	cache: { enabled: true, ...(opts.promptCache?.ttl ? { ttl: opts.promptCache.ttl } : {}) },
};
```

The Anthropic adapter translates that into explicit block-level `cache_control`
markers:

- system block: marked when cache is enabled
- last tool definition: marked when cache is enabled
- history blocks: `addHistoryCacheBreakpoints()` walks backward and marks two
  prior message content blocks

That exactly fills Anthropic's four-breakpoint limit when a request has both
system and tools.

Current cost accounting is wrong for Anthropic cache usage:

- Anthropic `input_tokens` is the non-cache input segment after the last
  breakpoint.
- Anthropic cache reads and cache writes are separate usage fields.
- Sprout currently treats `input_tokens` as if it includes cached tokens, then
  subtracts cache reads and ignores cache writes.
- Sprout discards Anthropic's TTL-specific cache creation split:
  `cache_creation.ephemeral_5m_input_tokens` vs
  `cache_creation.ephemeral_1h_input_tokens`.

## Design Principles

- Measure with correct billing before optimizing behavior.
- Cache stable prefixes, not volatile suffixes.
- Keep provider-specific behavior provider-specific; do not pretend Anthropic,
  OpenAI, and Gemini caching have the same semantics.
- Fail loudly on invalid cache configuration.
- Avoid new knobs until measurement proves they are needed.
- Do not add back-compat shims for invalid historical config; there are no
  legacy users.

## Phase 1: Normalize Usage And Cost Accounting

### Usage Model

Update `Usage` so cost and context accounting have explicit fields:

```ts
export interface Usage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	reasoning_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	cache_write_5m_tokens?: number;
	cache_write_1h_tokens?: number;
	total_input_tokens?: number;
}
```

Intended semantics:

- `input_tokens`: regular uncached input tokens billed at the base input rate.
- `cache_read_tokens`: tokens read from cache.
- `cache_write_tokens`: total tokens written to cache.
- `cache_write_5m_tokens`: 5-minute Anthropic cache writes.
- `cache_write_1h_tokens`: 1-hour Anthropic cache writes.
- `total_input_tokens`: all input/context tokens represented by the request:
  regular input plus cache reads plus cache writes when known.
- `total_tokens`: total input/context tokens plus output tokens when known.

Provider mapping:

- Anthropic: `input_tokens` stays Anthropic's raw non-cache input field.
  `cache_read_tokens` comes from `cache_read_input_tokens`.
  `cache_write_tokens` comes from `cache_creation_input_tokens`.
  TTL-specific fields come from `usage.cache_creation` when present.
  `total_input_tokens = input + cache_read + cache_write`.
- OpenAI: raw input includes cached tokens. Normalize `input_tokens` to
  `raw.input_tokens - cached_tokens`, set `cache_read_tokens` from cached token
  details, and set `total_input_tokens` to the raw input count.
- Gemini: raw prompt count appears to include cached content. Normalize
  `input_tokens` to `promptTokenCount - cachedContentTokenCount`, set
  `cache_read_tokens`, and set `total_input_tokens` to `promptTokenCount`.
  Do not add Gemini explicit-cache creation cost in this pass unless the
  adapter exposes reliable creation/storage usage.

### Cost Model

Extend pricing:

```ts
export interface ModelPricing {
	input: number;
	output: number;
	cached_input?: number;
	cache_write_5m?: number;
	cache_write_1h?: number;
}
```

Cost formula:

```ts
regular_input_cost = input_tokens * input_rate
cache_read_cost = cache_read_tokens * cached_input_rate
cache_write_5m_cost = cache_write_5m_tokens * cache_write_5m_rate
cache_write_1h_cost = cache_write_1h_tokens * cache_write_1h_rate
output_cost = output_tokens * output_rate
```

Rules:

- Do not subtract `cache_read_tokens` from `input_tokens` in cost code; adapters
  normalize the fields.
- For Anthropic fallback pricing, derive:
  `cached_input = input * 0.1`, `cache_write_5m = input * 1.25`,
  `cache_write_1h = input * 2`.
- For live pricing snapshots, preserve upstream cached input prices and derive
  Anthropic cache-write rates from documented multipliers when the upstream
  lacks explicit write rates.
- If aggregate `cache_write_tokens` exists without TTL-specific detail, cost is
  partial unless a request-level TTL proves which rate applies.
- If a provider has cache writes but no known write rate, mark the ATIF cost as
  partial rather than reporting writes as free.

### Observability

Add enough data to explain cache behavior after each run:

- ATIF final metrics should include `total_cache_write_tokens`.
- `llm_end` should include TTL-specific cache write fields when available.
- Cost metrics should expose a breakdown:
  `regular_input_cost_usd`, `cache_read_cost_usd`, `cache_write_cost_usd`,
  `output_cost_usd`, and whether the total is partial.
- Add a small Bun aggregation script or documented command that reports usage
  and cost by model and by agent.

### Tests

Required tests:

- Anthropic usage parse preserves non-cache input, cache read tokens, aggregate
  cache write tokens, 5m writes, 1h writes, `total_input_tokens`, and
  `total_tokens`.
- OpenAI usage normalizes cached tokens out of `input_tokens` while preserving
  `total_input_tokens`.
- Gemini usage normalizes cached content out of `input_tokens` while preserving
  `total_input_tokens`.
- ATIF cost includes Anthropic 5m cache writes at 1.25x input.
- ATIF cost includes Anthropic 1h cache writes at 2x input.
- Mixed 5m and 1h Anthropic cache writes are billed separately.
- Unknown-provider cache writes produce a partial-cost marker.
- `plan_end.context_tokens` uses `total_input_tokens` when present.

Commit: `fix: normalize cache usage and cost accounting`

## Phase 2: Re-Measure The Current Behavior

Before changing cache markers, rerun the same cacheprobe benchmark with current
behavior and corrected cost accounting.

Record:

- total cost
- total cache read tokens
- total cache write tokens
- cache write cost
- cache read cost
- output cost
- top cache-write agents
- generated-project quality checks

This gives a real baseline. The previous `$2.59` estimate was directionally
useful but was computed outside Sprout because ATIF billing was incomplete.

## Phase 3: Add Anthropic-Scoped History Cache Policy

Do not add a provider-neutral `history_breakpoints` field. History breakpoints
are an Anthropic explicit-cache concept and should stay scoped to Anthropic.

Extend `AgentPromptCacheConfig`:

```ts
export interface AgentPromptCacheConfig {
	enabled?: boolean;
	ttl?: PromptCacheTtl;
	anthropic?: {
		history_breakpoints?: 0 | 1 | 2;
	};
}
```

Validation:

- `prompt_cache` must be an object.
- `enabled`, when present, must be boolean.
- `ttl`, when present, must be `5m` or `1h`.
- `anthropic.history_breakpoints`, when present, must be integer `0`, `1`, or
  `2`.
- Unknown keys fail. This is intentional; no legacy compatibility.

Why max `2`:

- Anthropic allows four explicit breakpoints total.
- Sprout already uses up to two non-history breakpoints: system and final tool.
- Allowing `3` or `4` would be valid only for some request shapes and invalid
  for common system+tool requests.
- A smaller typed range is cleaner than runtime clamping.

Provider option threading:

- Anthropic receives `cache.history_breakpoints` only if configured.
- OpenAI receives the same `prompt_cache_key` behavior as before.
- Gemini receives the same explicit cache key and TTL behavior as before.
- Anthropic-only fields must not appear in OpenAI or Gemini provider options.

`prompt_cache.enabled: false` should be documented as disabling Sprout's
explicit cache/routing controls. It cannot guarantee provider-level caching is
disabled for providers that cache automatically.

Commit: `feat: add anthropic history cache policy`

## Phase 4: Test History Defaults

After Phase 1 and Phase 2 measurement, run an A/B comparison:

- Variant A: current default, two history breakpoints.
- Variant B: default zero history breakpoints.
- Optional Variant C: default one history breakpoint if A/B is inconclusive.

Implementation for Variant B:

- Change `resolveAnthropicCacheSettings()` default from `2` to `0`.
- Keep system and final tool breakpoints enabled.
- Do not modify agent frontmatter by default.
- Do not add root/tech-lead opt-ins until measurement proves they need them.

Required tests:

- Default Anthropic cache settings mark system and final tool, but no history.
- `anthropic.history_breakpoints: 1` marks one prior history block.
- `anthropic.history_breakpoints: 2` restores old two-history behavior.
- Invalid bypassed values fail before request construction.
- `buildPlanRequest()` omits Anthropic history policy when unspecified.
- `buildPlanRequest()` includes Anthropic history policy when configured.
- OpenAI and Gemini provider options are unchanged.

Keep Variant B only if:

- corrected total cost drops materially
- cache-write cost drops materially
- cache-read savings do not collapse enough to erase the benefit
- output quality and generated-project verification remain comparable

Commit if accepted: `fix: avoid default caching of volatile agent history`

## Phase 5: Decide Whether System Prompt Splitting Is Needed

The audits found a second likely source of churn: Sprout's cached system block
is not purely stable. It can include:

- today's date
- working directory
- project instructions
- recalled memories
- routing hints
- runtime observer or steering context

That means "cache system/tools" is not automatically "cache stable content."
If Phase 4 does not close the cost gap, the next YAGNI step is not pooling
agents; it is system prompt block splitting.

Possible design:

- Render stable identity/persona/tool-use instructions as one cached system
  block.
- Render volatile environment, project docs, memory recall, routing hints, and
  runtime observer context as later uncached system or user context.
- Place the explicit cache breakpoint at the end of the stable block.

Do not implement this in the first pass. It touches prompt construction broadly
and should be justified by corrected measurements showing system writes remain a
major cost source.

## Non-Goals For This Pass

- persistent utility-agent pools
- automatic Anthropic top-level caching
- per-agent cache auto-tuning
- web UI controls for cache policy
- provider-neutral cache policy DSL
- Gemini explicit-cache billing/storage redesign
- prompt stable/volatile splitting unless Phase 4 fails to move cost enough

## Rollout Summary

1. Fix usage normalization and cost accounting.
2. Re-measure current behavior.
3. Add validated Anthropic-scoped history cache policy.
4. Test default `0` history breakpoints against current `2`.
5. Keep the cheaper default only if corrected measurements prove it.
6. Revisit system prompt splitting only if history-cache tuning is insufficient.

## Acceptance Criteria

- ATIF costs include cache reads and TTL-specific cache writes correctly.
- `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, and
  `total_input_tokens` have documented provider-normalized semantics.
- Invalid `prompt_cache` frontmatter fails loudly.
- Anthropic history cache policy is scoped under `prompt_cache.anthropic`.
- Anthropic default history behavior is changed only after corrected
  before/after measurements.
- OpenAI and Gemini behavior is not accidentally changed by Anthropic-specific
  policy.
- The benchmark comparison is reproducible from checked-in docs or a Bun script.

## Adversarial Review Results

Three reviewers audited this plan against code and provider docs.

Agreed high-severity corrections:

- Cost accounting must precede cache behavior changes.
- Anthropic usage fields must be normalized; cache reads/writes are not part of
  Anthropic `input_tokens`.
- Cache writes require TTL-specific billing.
- History breakpoint config must be validated against the four-breakpoint
  provider limit.
- Gemini explicit caching is different enough that Anthropic policy must not
  leak into Gemini behavior.

Plan changes made after review:

- Moved cost accounting to Phase 1.
- Added provider-normalized usage semantics.
- Added TTL-specific cache write fields.
- Replaced provider-neutral `history_breakpoints` with
  `prompt_cache.anthropic.history_breakpoints`.
- Added corrected baseline measurement before changing defaults.
- Added system-prompt volatility as the next measured follow-up, not a first-pass
  implementation.
