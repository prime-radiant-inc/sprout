# Agent Intent Controls Spec

Date: 2026-05-02

Status: draft for implementation review

Related docs:

- `docs/plans/2026-04-28-agent-model-policy-overrides-plan.md`
- `docs/plans/2026-05-01-prompt-cache-cost-reduction-plan.md`
- `root/agents/quartermaster/resources/sprout-architecture/agent-system.md`

## Problem

The Qwen editor failure exposed a broader design smell: Sprout sometimes lets
provider or model identity imply agent behavior. The first deterministic-local
fix solved the symptom, but it was too broad because it changed all
`openai-compatible` agents, including agents whose job is expressive commentary.

The cleaner shape is explicit agent intent:

- Agent definitions describe what an agent needs from the planner request.
- Sprout settings describe operator-selected models.
- Provider adapters translate already-explicit request fields to provider APIs.
- Runtime code does not guess behavior from provider names, model names, or
  prompt folklore.

## Minimality Doctrine

Every change in this spec must be implemented as the smallest change that fixes
the observed class of failure.

Prefer, in order:

1. Delete hidden inference or duplicated prompt text.
2. Tighten validation on an existing field.
3. Thread an existing typed field through a missing runtime seam.
4. Add one narrowly typed field only when the first three options cannot solve
   the concrete problem.

Do not build a generic capability framework, policy engine, model-behavior DSL,
or compatibility layer. There are no legacy users for invalid or experimental
agent config. If old config becomes wrong, update the config and fixtures
directly.

Each implementation must start with a failing test or a saved live trace that
demonstrates the current behavior. If the current code already satisfies the
behavior, the correct outcome is to document that fact and remove redundant
prompt/runtime code, not to add another abstraction.

## Global Non-Goals

- Do not add fallback model selection.
- Do not infer sampling, token budgets, tool requirements, reasoning, or cache
  behavior from provider kind.
- Do not make hidden changes to all local models, all OpenAI-compatible models,
  or all Anthropic models.
- Do not expose half-implemented knobs in the web UI.
- Do not add compatibility migrations for old frontmatter experiments.
- Do not add fields that have no production consumer.

## Spec 1: Structured Task Payloads

### Problem

Some delegations contain exact data contracts: file paths, tool arguments,
schemas, replacement strings, or command arguments. Today that exact data is
usually embedded in prose inside `goal` or `hints`. Exactness-sensitive agents
then have to rediscover or copy it from natural language, which lets small local
models mutate strings before calling tools.

### Current State

- `delegate` accepts `agent_name`, `goal`, `description`, `hints`, `blocking`,
  and `shared`.
- `Delegation` stores `goal` and optional string `hints`.
- Both in-process delegation and bus/spawner delegation concatenate hints into
  text before running the child.
- The editor prompt currently carries a lot of instructions telling it to treat
  JSON in prose as exact.

### Smallest Viable Design

Add one optional structured payload path for agents that explicitly opt in.

Agent frontmatter:

```yaml
task_payload: true
```

Delegate tool:

```ts
payload?: Record<string, unknown>
```

Runtime behavior:

- The `payload` field is accepted only when the target agent spec has
  `task_payload: true`.
- The payload is preserved as structured JSON on `Delegation`.
- The payload must be a JSON-serializable object.
- The runtime renders it to the child in one canonical deterministic block after
  the goal:

  ```text
  <task_payload type="json">
  {"path":"src/cli.ts","old_string":"...","new_string":"..."}
  </task_payload>
  ```

- The runtime logs payload metadata only, never full payload content, on parent
  delegation events.
- The first consumer should be `editor`. Add other agents only when a real trace
  proves they need structured payloads.

This is intentionally not a new arbitrary inter-agent data bus. It is only a
cleaner representation of the delegation task.

### Payload Validation

Validation should be one small helper used by tool-call classification and both
delegation execution paths.

Rules:

- Top-level payload must be a plain object.
- Values must be JSON-serializable: string, number, boolean, null, arrays, and
  plain objects.
- Reject `undefined`, functions, symbols, bigint, non-finite numbers, class
  instances, and cycles.
- Maximum serialized size is 64 KiB in v1.
- Serialized size means UTF-8 byte length of the canonical JSON string.
- Maximum nesting depth is 8.
- Do not truncate or repair payloads. Invalid payloads fail before the child
  agent starts.

Error messages must identify the failing field or limit without echoing payload
content.

### Canonical Rendering

Use one canonical renderer:

- Recursively sort object keys lexicographically.
- Render with `JSON.stringify(canonicalPayload)` and no extra whitespace.
- Preserve array order.
- Preserve string contents exactly.
- End the `<task_payload>` block with one newline before `</task_payload>`.

The goal formatter should be a shared helper so in-process delegation,
bus/spawner delegation, tests, and future tooling cannot drift.

### Payload Observability Policy

Full payload content is task input. It is necessary for the child agent, but it
should not be duplicated into parent-level telemetry.

Surfaces:

- Parent `act_start`, `act_end`, delegate observer owner events, summaries, and
  error/stumble records store metadata only.
- Payload metadata shape is `{ present: true, bytes: number, key_count: number }`.
- The `bytes` value uses the same UTF-8 canonical JSON byte length as
  validation.
- Top-level key names are not logged in v1; even keys can contain sensitive or
  proprietary labels.
- Bus/spawner start messages may carry the full structured payload as transport
  data, but debug logs for those messages must use metadata only.
- The child initial user message contains the full canonical payload block,
  because that is the product behavior. Existing transcript or provider-request
  logs that store child messages may therefore contain payload content; this spec
  does not add new redaction infrastructure.
- Observer subscriptions that receive child prompt/input events follow the same
  rules as existing child prompt visibility. Parent delegation events still
  expose metadata only.

### Prefer Removing

- Remove editor prompt paragraphs whose only job is compensating for JSON buried
  in prose.
- Remove any duplicated hint-concatenation code by sharing one helper that builds
  the child goal text from `{ goal, hints, payload }`.

### Explicitly Out Of Scope

- No schema registry.
- No per-agent JSON Schema validation in v1.
- No automatic primitive execution from payload.
- No special editor-only runtime shortcut.
- No UI for payloads.

### Red Tests

- A delegation to an agent without `task_payload: true` that includes `payload`
  fails with a clear validation error.
- A delegation to `editor` with `payload` preserves exact nested strings through
  the `Delegation` object and child-start message.
- In-process delegation and spawner delegation render identical child goal text
  for the same structured payload.
- Canonical rendering is stable for differently ordered object keys.
- Invalid payloads fail before child start: too large, too deep, non-finite
  number, unsupported value, and cycle.
- Parent `act_start` records only payload metadata and not payload keys or
  content.
- Markdown parser/serializer round-trips `task_payload: true`.
- `save_agent` accepts and validates `task_payload`.

### Definition Of Done

- `task_payload` is typed in `AgentSpec`, parsed, serialized, and accepted by
  `save_agent`.
- `delegate.payload` is available in the LLM tool schema.
- Both delegation execution paths share one formatter for goal, hints, and
  payload.
- `editor` opts in; no other agent opts in unless justified by a failing trace.
- Existing editor prompt text is shorter, not longer.
- Payload validation and observability behavior are covered by tests.
- Focused tests pass.
- A live Qwen editor trace that previously mutated exact edit strings succeeds
  without relying on provider-kind temperature heuristics.

### How To Know It Is Good

- The diff removes more editor prompt workaround text than it adds to the
  runtime path, or the added runtime path is narrowly smaller than the removed
  duplication.
- Payload handling is not provider-specific.
- Payloads remain optional and invisible to agents that do not declare support.
- The same behavior works through in-process and bus/spawner delegation.
- If the caller does not provide `payload`, current delegation behavior is
  unchanged.
- Parent-level logs become less sensitive than prose-only delegation logs, not
  more sensitive.

### Required Commit Split

Structured payloads are broad enough that they must not be one large patch.
Implement them as small reviewable commits:

1. Add parser/serializer/`save_agent` support for `task_payload`.
2. Add `Delegation.payload`, validation, canonical rendering, and unit tests.
3. Add `delegate.payload` classification and shared goal formatting across both
   execution paths.
4. Add parent-event metadata logging and observability tests.
5. Opt `editor` in, remove now-redundant prompt text, and run the live local
   editor trace.

## Spec 2: Per-Agent Output Budgets

### Problem

Different agents need different output budgets. Memory extraction and summary
jobs already exposed truncation failures. Agent planning calls currently use a
provider-kind default budget, which can be too small for some agents and too
large or expensive for others.

### Current State

- `buildPlanRequest()` accepts `maxTokens`.
- If unset, it uses `defaultPlanMaxTokens(providerKind)`.
- `openai-compatible` gets a larger default than other providers.
- Agent frontmatter does not have a first-class planning output budget.
- Some memory calls have ad hoc `maxTokens` parameters.

### Smallest Viable Design

Add one optional agent frontmatter field:

```yaml
output:
  max_tokens: 4096
```

Runtime behavior:

- `AgentSpec.output.max_tokens` maps directly to planning request
  `max_tokens`.
- If absent, the existing default remains for now.
- Validation accepts positive safe integers only.
- The field is for agent planning turns only. Memory hidden calls keep their
  existing purpose-specific budgets until a separate memory-budget spec replaces
  them.
- The global hard maximum is 131,072 output tokens. Values above that fail
  validation; do not clamp them.
- If the active provider/model catalog exposes a lower known output-token
  maximum, request construction should fail before the LLM call with a clear
  configuration error. If no model-specific maximum is known, use only the
  global hard maximum.

If an existing `maxTokens` route already covers every needed production path,
prefer threading the existing route rather than adding this field.

### Prefer Removing

- Remove provider-kind budget special cases if explicit agent budgets cover the
  actual agents that needed the special case.
- Remove duplicate local constants after one canonical default remains.

### Explicitly Out Of Scope

- No web UI for agent output budgets in v1.
- No adaptive token budgeting.
- No automatic retry on truncation.
- No per-provider budget table.
- No budget inference from model context window.

### Red Tests

- Agent markdown with `output.max_tokens` produces a planning request with that
  exact `max_tokens`.
- Invalid values fail markdown parsing: zero, negative, fractional, string, or
  unknown `output` keys.
- Values above 131,072 fail validation.
- If a test catalog declares a lower model output limit, request construction
  fails instead of clamping.
- `save_agent` validates and preserves `output.max_tokens`.
- An agent without `output.max_tokens` keeps the current default.
- If provider-kind default removal is part of the patch, tests prove affected
  exact agents now declare explicit budgets instead.

### Definition Of Done

- `AgentOutputConfig` is typed, parsed, serialized, and wired into
  `executePlanningTurn`.
- Exactly the agents that need non-default output budgets declare them.
- Provider adapters receive only the explicit request value; they do not choose
  budgets based on provider identity.
- Over-limit budgets fail loudly before the provider call whenever Sprout knows
  the relevant limit.
- Focused tests pass.

### How To Know It Is Good

- The change makes token budget decisions visible in the agent definition.
- At least one provider-kind heuristic or duplicate constant is removed, unless
  the implementation proves none exists for the targeted path.
- Budget changes are reviewable without reading provider adapter code.
- No agent starts receiving a larger budget unless its frontmatter says so.

## Spec 3: Tool-Use Requirements

### Problem

Some agents are only useful if they call tools. Prompt instructions alone are
not enough: an LLM can return a plausible text answer without performing the
operation it was delegated to perform.

### Current State

- `constraints.requires_tool_use` already exists.
- `Agent.runLoop()` checks `requires_tool_use` and prevents text-only
  completion.
- Many tool-specialist agents already set it.
- Several prompts still contain repeated tool-use warnings.

### Smallest Viable Design

Do not add a new feature unless tests prove the existing one is incomplete.

The implementation should audit and tighten the existing field:

- Keep `constraints.requires_tool_use` as the only v1 declaration.
- Ensure every tool-specialist root agent that cannot produce useful text-only
  work has it set.
- Ensure learned agents created through `save_agent` can set it only through
  `constraints`, not through another alias.
- Ensure failures are visible as stumbles and useful tool results.
- Remove prompt text that only restates the runtime-enforced rule.

### Prefer Removing

- Remove prompt-only "you must use a tool" paragraphs where the runtime rule is
  enough.
- Remove any alternate or legacy capability alias that duplicates
  `constraints.requires_tool_use`.

### Explicitly Out Of Scope

- No `required_tool_names` in v1.
- No minimum tool-call count.
- No per-turn tool requirement.
- No policy language beyond the existing boolean.

### Red Tests

- A `requires_tool_use` agent that returns text without a tool call cannot
  complete successfully.
- The failure is reported in a way the caller can act on.
- A non-`requires_tool_use` agent can still complete text-only.
- The root agent corpus has no obvious tool-specialist agent missing
  `requires_tool_use`.
- `save_agent` rejects misplaced top-level `requires_tool_use` if such an input
  currently slips through.

### Definition Of Done

- No new runtime field is added unless a failing test proves the boolean cannot
  express the needed behavior.
- Tool-specialist agents have the existing constraint set.
- The enforcement path is covered by focused tests.
- Prompt text is shorter or unchanged.

### How To Know It Is Good

- The implementation mostly deletes or moves instructions into the existing
  structured field.
- The runtime behavior is deterministic and model-independent.
- A caller gets a clear "the agent did not use its required tool" signal instead
  of a fabricated result.
- No general permission framework appears in the diff.

## Spec 4: Reasoning And Thinking Controls

### Problem

Some agents may need explicit reasoning controls, but that decision should be
agent intent, not a provider-kind side effect. Sprout already has an Anthropic
`thinking` field, so the danger is adding a second, overlapping abstraction.

### Current State

- `AgentSpec.thinking` exists as `boolean | { budget_tokens: number }`.
- `buildPlanRequest()` maps it to Anthropic provider options.
- The parser currently preserves it with minimal validation.
- Other providers have request-level fields such as `reasoning_effort`, but no
  agent-frontmatter route.

### Smallest Viable Design

First, tighten the existing `thinking` field instead of adding a new one.

Rules:

- Keep `thinking` provider-scoped to Anthropic extended thinking for now.
- Validate `thinking` in markdown and `save_agent`.
- Do not invent provider-neutral `reasoning` until there is a concrete agent and
  provider that needs it.
- If OpenAI-style `reasoning_effort` becomes necessary, add it later as a
  separate explicit field with one consumer:

  ```yaml
  reasoning:
    effort: low
  ```

  That future field must not silently replace `thinking`.

### Prefer Removing

- Remove any prompt text telling agents to "think harder" when a provider-level
  `thinking` budget is the real control.
- Remove provider adapter defaults that enable thinking without a request field.

### Explicitly Out Of Scope

- No provider-neutral reasoning abstraction in this pass.
- No automatic mapping from `thinking` to OpenAI or local models.
- No UI.
- No hidden reasoning defaults for architect, tech-lead, or root.

### Red Tests

- Invalid `thinking` values fail parsing: unknown keys, non-boolean enabled
  shape, non-integer budget, zero/negative budget.
- Valid `thinking: true` still maps to the default Anthropic budget.
- Valid `thinking: { budget_tokens: N }` maps to exactly `N`.
- Non-Anthropic providers do not receive fabricated reasoning options from
  `thinking`.

### Definition Of Done

- `thinking` has the same validation discipline as `sampling`.
- No new `reasoning` field exists unless a failing test proves it is necessary.
- Anthropic mapping remains explicit and covered.
- Provider adapters do not infer reasoning from provider or model identity.

### How To Know It Is Good

- The patch is mostly validation and tests.
- It prevents bad frontmatter from silently surviving.
- It does not expand the product surface.
- The name `thinking` remains honest: it means the provider feature Sprout
  actually supports today.

## Spec 5: Prompt Cache Policy

### Problem

Prompt caching can materially affect cost. It should be explicit for stable
agent prompts and stable prefixes, not an accidental behavior applied to every
request with a session id and agent name.

### Current State

- `AgentSpec.prompt_cache` exists.
- `buildPlanRequest()` currently enables provider cache options by default when
  `sessionId` and `agentName` are present unless `prompt_cache.enabled === false`.
- The cost-reduction plan separately covers accurate cache billing.

### Smallest Viable Design

Invert the default only after cache billing is correct.

Prerequisite: Phase 1 of
`docs/plans/2026-05-01-prompt-cache-cost-reduction-plan.md` must be complete.
That means provider usage normalization tests pass, ATIF exposes cache read and
write token totals, and cost output distinguishes regular input, cache reads,
cache writes, and partial totals. Do not start this cache-policy inversion
before those checks are green.

Target behavior:

- `prompt_cache.enabled: true` opts an agent into provider cache controls.
- Missing `prompt_cache` means no explicit provider cache options.
- `prompt_cache.enabled: false` is unnecessary once absence means disabled; if
  no root agent needs explicit false, remove support for false rather than
  preserving it.
- `prompt_cache.ttl` is valid only when `enabled: true`.

This should be implemented after the usage/cost accounting fixes from the
prompt-cache cost plan, so measurements before and after are trustworthy.

### Prefer Removing

- Remove the default "session id + agent name means caching" branch.
- Remove `enabled: false` support if no current agent needs a negative override.
- Remove cache option construction from generic request-building code if a small
  helper can make the policy clearer.

### Explicitly Out Of Scope

- No cache policy UI in v1.
- No provider-specific cache optimization DSL.
- No adaptive cache TTL.
- No Gemini explicit cached-content resources in this pass.
- No cost optimization until usage accounting is already trusted.

### Red Tests

- Missing `prompt_cache` produces no provider cache options.
- `prompt_cache.enabled: true` produces the current provider cache options.
- `prompt_cache.ttl` without `enabled: true` fails validation.
- If `enabled: false` is removed, markdown containing it fails validation.
- Existing agents that should be cached declare `prompt_cache.enabled: true`.

### Definition Of Done

- Cache enablement is opt-in from agent frontmatter.
- Accurate cache cost accounting is already merged or this change is explicitly
  blocked.
- Tests prove missing config does not enable cache options.
- Any agent that needs caching has an explicit frontmatter declaration.

### How To Know It Is Good

- Cache cost changes are explainable by reading agent specs.
- Fewer requests get explicit provider cache options by accident.
- The code no longer treats every session-scoped request as cache-worthy.
- Reported cost deltas can be trusted because accounting was fixed first.

## Implementation Order

1. Tool-use requirements audit, because it should mostly remove prompt
   duplication and validate existing behavior.
2. Thinking validation, because it is also mostly tightening an existing field.
3. Structured task payloads, because it fixes the current local-editor failure
   class without provider heuristics.
4. Per-agent output budgets, only for agents with observed truncation or
   obvious over-budget waste.
5. Prompt cache policy, only after cache accounting is correct.

Do not implement all five in one commit. Each spec should be a small commit with
its own red/green tests. If a phase turns into a broad refactor, stop and cut
scope until the patch is again explainable as a narrow deletion, validation
tightening, or one-field thread-through.

## Branch-Level Definition Of Done

- Every changed behavior has a failing test or saved live trace from before the
  fix.
- Every new frontmatter field has parser, serializer, `save_agent`, and runtime
  tests.
- The generated embedded root is updated when root agent specs change.
- `bun run check` passes.
- `bun run typecheck` passes.
- Relevant focused tests pass.
- If `bun run precommit` exposes unrelated flakes, rerun named failures
  directly and record the caveat.
- The final diff removes hidden inference or prompt workaround text wherever the
  new structured behavior makes that possible.

## Branch-Level Goodness Checks

- Reading an agent markdown file explains why that agent gets special request
  behavior.
- Reading provider adapters does not reveal hidden model/provider policy.
- Quartermaster can create agents using the same fields humans review.
- No field exists only because it "might be useful later."
- The smallest exactness-sensitive live test improves without degrading
  expressive observers such as The Balcony.
