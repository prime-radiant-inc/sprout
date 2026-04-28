# Agent Observers V3 Spec

**Status:** Draft follow-on spec
**Date:** 2026-04-28
**Builds on:** `docs/plans/2026-04-27-agent-subscriptions-and-observers-spec.md`,
`docs/plans/2026-04-27-agent-observers-v2-spec.md`

## Goal

Turn the V2 observer facility from a proven root-centric mechanism into a
small, documented, testable Sprout primitive for process observers.

This spec covers everything through "observer agent work":

1. Near-term hardening: checked-in validation, docs, UI affordances, and
   deterministic tests for multiple observer agents.
2. Architectural extensions: non-root ownership, deeper delegate trees, and
   scoped subscriptions.
3. Observer agent work: a small set of specialized observers with clear prompts,
   model configuration, and noise controls.

This spec does not add human notifications, severity levels, a persistent
notification inbox, raw event ids, observer memory writes, or hard enforcement
of observer advice.

## Current State

V2 is implemented around these core decisions:

- Observers are normal agents.
- Subscriptions are runtime-owned edges.
- Observer comments use `message_agent`.
- Agent-originated comments render in `<sprout:agent-messages>`.
- Observer messages are serious process guidance, not user instructions and not
  hard interrupts.
- Static config supports root/session observation and root delegate-final
  observation through `observers` and `observe_delegates`.
- Observer model selection uses Sprout settings through
  `observer.metacognitive`, with env override support and no fallback.
- Observer telemetry is excluded from collapse and memory extraction evidence.

Live validation has additionally proved:

- A root observer can see root events, inject a message, and root can use it.
- A delegate-final observer can see blocking delegate completion, inject a
  message, and root can use it.
- A deliberately wrong observer comment can be rejected by root against stronger
  evidence.
- Three distinct observer agents can run together:
  `root-sentinel`, `session-auditor`, and `delegate-auditor`.
- Handle-only nonblocking delegate handoffs do not trigger delegate-final
  observers.

## Design Principles

- Preserve the V2 architecture. The observer agent stays ordinary; the
  subscription edge stays special.
- Add generality only where there is a concrete observer use case.
- Make visibility better before making behavior more powerful.
- Keep comments advisory. If hard runtime intervention is ever needed, it should
  be a separate feature, not an overloaded observer comment.
- Keep memory boundaries intact. Observers can help root notice durable facts,
  but memory extraction only sees those facts after normal task behavior
  incorporates them.
- Prefer static configuration and explicit prompt contracts over model-owned
  subscription tools.
- Add rate and duplicate controls only after the specialized observers make the
  noise problem measurable.

## Scope

### In Scope

- Checked-in multi-observer validation harness.
- Deterministic mocked tests for multiple observer agents.
- Documentation for writing observer agents and static subscriptions.
- UI affordances that make observer threads and comments easier to inspect.
- Non-root observer ownership for ordinary agent specs.
- Deeper delegate observation where a non-root caller can observe its own
  delegates.
- Scoped subscription targets for concrete needs:
  - session
  - root
  - caller delegates
  - a specific agent handle
  - a delegate subtree
- A small family of production observer agents:
  - metacognitive observer
  - failure-loop observer
  - instruction-drift observer
  - evidence-contradiction observer
  - context-pressure observer
- Noise controls for observer comments if specialized observers prove noisy.

### Out of Scope

- Human notification UI or toasts.
- Severity levels.
- Persistent notification inbox.
- Raw event ids in observer frames.
- Observer memory writes.
- Model-owned subscribe/unsubscribe tools.
- `notify_agent`, `publish_observation`, or `reply_to_notification`.
- Hard runtime enforcement of observer advice.
- Replacing recall, archivist, session collapse, or memory maintenance jobs.

## Phase 1: Validation And Documentation

### 1.1 Checked-In Manual Live Harness

The temporary live harness proved the right behavior but is not durable. Add a
checked-in manual harness under `scripts/` or `test/live/` that can run the same
scenarios with explicit opt-in.

Recommended path:

```text
scripts/live-observer-validation.ts
```

The harness should:

- Use Bun/TypeScript only.
- Build a temporary root directory.
- Define deterministic probe-worker tools with `sprout-internal`.
- Run through the real bus, spawner, subprocess agent, session controller, and
  model resolver.
- Load `.env` and Sprout settings like normal runtime.
- Require a flag such as `--live` or an env var such as
  `SPROUT_RUN_LIVE_OBSERVER_TESTS=1`.
- Write JSON summaries to the temp case directory.
- Print a compact pass/fail summary with artifact paths.

Required live scenarios:

- `metacognitive-correction`: a correct observer comment steers root from a bad
  assumption to the worker result.
- `adversarial-comment`: a wrong observer comment is rendered and explicitly
  rejected against stronger evidence.
- `multi-observer`: three distinct observer agents all start, see their
  configured evidence, send role-tagged `agent_message` events, and root
  includes their requested markers.
- `nonblocking-negative`: handle-only nonblocking delegate handoff does not
  trigger delegate-final observers.

Acceptance criteria:

- The script fails nonzero if any expected observer start, message, root marker,
  or negative-control silence is missing.
- The script reports warning counts per case.
- The script does not write repo files.
- The script is documented as manual/live, not part of default CI.

### 1.2 Deterministic Multi-Observer Tests

Live tests prove the integrated behavior but should not be the only guard.
Add deterministic tests with mocked LLM/spawner behavior.

Recommended files:

- `test/host/observer-registry.test.ts`
- `test/host/session-controller.test.ts`
- `test/agents/steering.test.ts`

Cases:

- Two root/session subscriptions can be active at once without handle
  collisions.
- A root observer and delegate observer for the same observer agent use distinct
  handles.
- Multiple distinct observer agents can inject messages in the same root turn.
- Agent messages preserve `role="observer"` and `from_agent_name`.
- Root prompt receives all queued observer messages once, then clears them.
- Nonblocking delegate `act_end` with a handle and no `turns` does not trigger
  delegate-final observers.
- Observer delivery failure for one subscription does not block unrelated
  subscriptions.

Acceptance criteria:

- Tests do not call real providers.
- Tests assert message content and role metadata, not only event counts.
- Tests cover both positive delivery and negative non-delivery paths.

### 1.3 Authoring Documentation

Add a short guide for writing observer agents.

Recommended path:

```text
docs/agents/observer-authoring.md
```

The guide should cover:

- Observers are normal agents.
- Required frontmatter:
  - `tools: [message_agent]`
  - `tags: [observer]`
  - `model: observer.metacognitive` until additional observer purposes exist.
  - `can_spawn: false`
  - `can_learn: false`
- How to add `observers` and `observe_delegates` to another agent.
- How comment policies map to `message_agent`.
- When to return `NO_MESSAGE`.
- When to call `message_agent` and then terminate with `MESSAGE_SENT`.
- Why observers should quote visible evidence and avoid claims about hidden
  prompts.
- Why observers should not suggest memory writes.

Acceptance criteria:

- The guide includes one root/session observer example.
- The guide includes one delegate-final observer example.
- The guide includes one bad observer prompt and explains the failure mode.

## Phase 2: UI Inspection Improvements

V2 made observers visible as normal child threads. V3 should make them easier to
inspect without adding a separate observer product surface.

### 2.1 Observer Thread Affordances

UI should distinguish observer threads from delegates while preserving the same
tree structure.

Required behavior:

- Observer tree rows show an observer badge or equivalent low-noise label.
- Observer rows remain selectable like ordinary child threads.
- Observer row subtitle includes the subscription description, such as
  `observes root turns` or `observes root delegate completions`.
- Observer `act_start`/`act_end` does not make the main thread noisy.

Recommended tests:

- `web/src/hooks/useAgentTree.test.ts`
- `web/src/components/__tests__/components.test.tsx`

### 2.2 Frame And Comment Rendering

When an observer thread is selected, the human should be able to see:

- The observer frame it received.
- The observer's final response (`NO_MESSAGE`, `MESSAGE_SENT`, or diagnostic
  text).
- Any `message_agent` calls it made.

Main thread behavior:

- Show compact `agent_message` events, e.g. `metacognitive -> root`.
- Do not inline raw observer frames in the main root thread.
- Keep raw frames collapsed by default even inside observer threads.

Acceptance criteria:

- Existing readable main-thread grouping remains intact.
- Observer raw frame text is available on selection but not expanded by default.
- Tests prove observer events are grouped under the observer thread and not
  interleaved as root task progress.

## Phase 3: Non-Root Observer Ownership

V2 configuration is effectively root-owned. V3 should allow ordinary agents to
own observer subscriptions for their own work, while keeping the default
observation set empty.

### 3.1 Agent-Owned Static Config

Any agent spec may define:

```yaml
observe_delegates:
  - agent: failure-loop-observer
    trigger: on_delegate_final
    events: [plan_end, warning, error, act_end, primitive_end]
    delivery:
      max_events: 12
      max_chars: 4000
    comments:
      can_message: [caller]
      default_recipient: caller
```

Semantics:

- The subscription applies only to delegations made by that agent instance.
- The observer may message the caller handle if the comment policy allows
  `caller`.
- The observer must not automatically gain access to root unless the policy
  explicitly allows `root`.
- The observer handle namespace must include enough caller identity to avoid
  collisions between multiple instances of the same agent.

Runtime requirements:

- `SessionController` or the spawner path must pass caller identity into observer
  subscription setup for non-root callers.
- `ObserverRegistry` must filter delegate final events by caller agent id and
  depth.
- Multiple instances of the same caller agent must not share a delegate observer
  handle unless explicitly configured as shared.

Acceptance criteria:

- A non-root agent can attach an observer to its own blocking delegate.
- That observer sees the delegate final frame.
- That observer can message the non-root caller.
- The non-root caller receives the observer message in its next planning prompt.
- Root does not receive that message unless explicitly configured.

### 3.2 Addressing Caller Handles

Current rendered comment policy says caller comments call
`message_agent(handle: "root")` for root-owned subscriptions. V3 needs a real
caller handle path.

Required behavior:

- For root-owned delegate observers, `caller` may still render as
  `handle: "root"`.
- For non-root caller-owned delegate observers, `caller` must render as the
  caller's actual handle id or a stable runtime alias.
- The observer should not have to infer handle ids from raw events.

Possible implementation:

```text
For caller comments in this subscription, call message_agent with handle
"<runtime-caller-handle>" and blocking false.
```

YAGNI choice:

- Prefer rendering the actual caller handle in the frame's comment policy.
- Do not add a new `message_caller` tool.
- Do not add reply correlation.

Acceptance criteria:

- The observer frame for a non-root caller subscription contains a usable caller
  address.
- `message_agent` to that address succeeds.
- Existing root observer frames remain unchanged.

### 3.3 Subscription Lifecycle

Non-root subscriptions should follow their owning agent instance.

Rules:

- Create subscriptions when the owning agent starts.
- Disable or remove subscriptions when the owning handle reaches terminal state
  and is not shared.
- Keep subscriptions alive for shared handles until the handle is closed or the
  session resets.
- Reset all subscriptions on `/clear`.

Non-goals:

- Do not persist subscriptions across process restart yet unless existing handle
  resume makes that straightforward.
- Do not let models create subscriptions dynamically.

## Phase 4: Scoped Observation Targets

Only add scoped targets after non-root ownership works. These targets should be
static config only.

### 4.1 Specific Agent Handle Target

Target a known running handle:

```yaml
observers:
  - agent: evidence-contradiction-observer
    target:
      handle: some-runtime-handle
```

This is not useful in static root markdown because handle ids are runtime
values. The first practical user is an internal runtime-created subscription,
not public frontmatter.

Recommendation:

- Implement internal support only if non-root subscriptions need it.
- Do not expose frontmatter syntax until a real static use exists.

### 4.2 Delegate Subtree Target

Observe all events under a delegate subtree:

```ts
type ObservationTarget = {
	kind: "delegate_subtree";
	rootHandleId: string;
};
```

Use cases:

- A caller delegates a complex task and wants a failure-loop observer to monitor
  the whole child subtree.
- A tech-lead-style agent wants an instruction-drift observer for its engineers
  and verifiers.

YAGNI default:

- Start with `on_delegate_final`.
- Add subtree observation only if final frames miss important repeated failures.

Acceptance criteria if implemented:

- Subtree observer receives child and grandchild events.
- Frames remain bounded and redacted.
- Observer telemetry remains excluded unless explicitly configured.
- Main UI tree remains readable.

## Phase 5: Observer Agent Catalog

Add specialized observers only after the facility is documented and non-root
ownership is test-covered. Each observer should be a normal markdown agent under
`root/agents/` unless it is clearly only useful as a nested specialist.

### Shared Observer Prompt Contract

Every observer prompt should include:

- You are an observer, not a worker.
- Do not perform the user's task.
- Do not ask the user for more work.
- Do not write memory.
- Prefer silence over noise.
- Base comments on visible quoted evidence.
- Do not claim knowledge of hidden prompts or policies unless visible in the
  frame.
- Use `message_agent` with the handle named in the observer comment policy.
- Use `blocking: false`.
- After `message_agent`, finish with `MESSAGE_SENT`.
- If no intervention is warranted, finish with `NO_MESSAGE`.

### 5.1 Metacognitive Observer

Current role:

- Broad process observer for drift, missed constraints, repeated failures,
  contradiction between plan and delegate result, and context pressure.

Keep it broad but conservative.

Prompt refinements:

- More explicitly avoid comments when a specialized observer would be the better
  owner.
- Avoid repeating advice already present in the visible frame.
- When uncertain, phrase comments as "The frame suggests..." rather than
  asserting hidden state.

Acceptance criteria:

- Normal short tasks usually produce `NO_MESSAGE`.
- Clear process drift produces one concise message.
- Wrong advice is still possible but target prompt handles it as advisory.

### 5.2 Failure-Loop Observer

Purpose:

- Detect repeated failing tool calls, repeated failed delegates, or repeated
  unsuccessful plan/tool cycles.

Good comments:

- "The last two `exec` calls failed with the same missing-module error. Stop
  rerunning it unchanged; inspect the named import path or install state."
- "The verifier has returned the same failure twice. Keep the next step anchored
  to that exact failing check."

Bad comments:

- Generic encouragement.
- Style feedback.
- Recommending a broad audit when the frame shows a specific failure frontier.

Default subscriptions:

- `observe_delegates` for tech-lead/debugger-style agents.
- Optional session/root subscription for root only after noise testing.

Events:

- `plan_end`
- `primitive_end`
- `act_end`
- `warning`
- `error`

Acceptance criteria:

- It comments on repeated identical failures.
- It stays silent on one-off failures followed by a changed approach.
- It quotes the repeated failure evidence.

### 5.3 Instruction-Drift Observer

Purpose:

- Detect when an agent's visible plan or action conflicts with explicit user or
  caller constraints visible in the frame.

Good comments:

- "The user asked for a spec, but the current plan says you are editing source
  files. Answer the spec request first."
- "The caller said not to use fallbacks; the current plan proposes a fallback.
  Rework the approach."

Boundary:

- It must not adjudicate hidden system/developer priority.
- It should only cite constraints present in frame quotes or caller goals.

Default subscriptions:

- Root `plan_end`.
- Delegate final frames for orchestrator agents.

Acceptance criteria:

- It catches a visible contradiction between a user constraint and plan text.
- It does not comment when the apparent conflict depends on hidden context it
  cannot inspect.

### 5.4 Evidence-Contradiction Observer

Purpose:

- Detect when a delegate result, tool output, or observed evidence contradicts
  the caller's plan or final answer.

Good comments:

- "The worker returned `BETA`, but the plan still says `ALPHA`. Use the worker
  result or explain why it is not authoritative."
- "The command output says the test failed, but the current summary says all
  tests passed."

Default subscriptions:

- `observe_delegates` on agents that synthesize results from workers.
- Optional root/session subscription for act_end events.

Acceptance criteria:

- It comments when delegate final output contradicts caller plan text.
- It stays silent when the caller explicitly explains why evidence is rejected.
- It supports the adversarial case where root rejects bad observer advice.

### 5.5 Context-Pressure Observer

Purpose:

- Detect high context pressure, repeated large frames, or visible compaction
  needs and recommend summarization or compaction strategy.

Good comments:

- "The frame shows context pressure after several large tool outputs. Summarize
  current state before continuing."
- "Before the next broad search, checkpoint decisions and current blockers."

Boundary:

- It does not perform compaction.
- It does not write memory.
- It only recommends process actions.

Default subscriptions:

- Session/root events including `compaction`, high context token signals, and
  repeated large `primitive_end` summaries.

Acceptance criteria:

- It comments when context pressure signals are visible.
- It stays silent on small sessions.

## Phase 6: Noise Controls

Do not add these before specialized observers exist. Once they exist, measure
noise in live sessions and add the smallest control that solves the observed
problem.

Possible controls:

### Duplicate Message Suppression

Suppress or warn when the same observer sends the same normalized message to the
same recipient repeatedly within a short window.

Acceptance criteria:

- Repeated identical comments are suppressed.
- Different evidence-backed comments still deliver.

### Per-Observer Minimum Interval

Subscription config may add:

```yaml
delivery:
  min_interval_turns: 2
```

Only add this if duplicate suppression is insufficient.

### Prompt-Level Noise Budget

Observer prompts can include explicit noise budgets:

```text
At most one comment per observed task unless the new frame contains materially
different evidence.
```

Prefer prompt-level budgets before runtime-level rate limits.

## Settings And Model Purposes

Initial V3 should reuse `observer.metacognitive` for all observer agents.

Add more purposes only when there is demonstrated need:

```ts
type AgentModelPurpose =
	| "observer.metacognitive"
	| "observer.failure_loop"
	| "observer.instruction_drift"
	| "observer.evidence_contradiction"
	| "observer.context_pressure";
```

Decision rule:

- If all observers can run well on the same cheap model, keep one purpose.
- If one observer needs a stronger model or materially different provider, add a
  purpose.
- Do not add configurable model purposes before there is a committed observer
  agent using them.

Env override rule:

- Each new purpose must have a matching explicit env override.
- Missing configured purposes fail loudly.
- No fallback to global tiers.

## Test Plan

### Unit

- Parser accepts agent-owned `observe_delegates` outside root.
- Parser rejects unsupported targets and comment recipients.
- Observer frame comment policy renders actual caller handle for non-root
  caller subscriptions.
- Observer registry filters delegate final events by owning caller.
- Observer registry uses collision-proof handles for multiple instances.
- Observer telemetry exclusion tests remain green.

### Integration

- Non-root agent delegates to a worker and owns a delegate-final observer.
- Observer comments to non-root caller.
- Non-root caller receives the comment in its next planning prompt.
- Root does not receive the comment.
- Two instances of the same caller agent do not share observer state.
- One observer delivery failure does not block another subscription.

### UI

- Observer badge renders on observer tree nodes.
- Observer selected thread shows received frames.
- Main root thread shows compact comments, not raw frames.
- Delegate observer appears under the correct caller or observed delegate.

### Live Manual

- Run checked-in live harness with multiple observer agents.
- Run one live non-root observer scenario after Phase 3.
- Run one live specialized-observer scenario for each production observer before
  enabling it by default.

## Rollout

1. Check in validation/docs without changing runtime behavior.
2. Add UI inspection improvements.
3. Add non-root caller-owned delegate observers behind tests.
4. Add one specialized observer at a time, starting with failure-loop or
   evidence-contradiction because their triggers are easiest to prove.
5. Measure noise before enabling any specialized observer by default.
6. Add model purposes only if live results prove the shared observer model is
   inadequate.

## Success Criteria

- Observer behavior is documented enough that a new observer can be authored
  without reading runtime code.
- Multi-observer behavior has deterministic tests and a live validation script.
- UI makes observer activity inspectable without polluting the main task thread.
- A non-root agent can observe and comment on its own delegate.
- At least one specialized observer provides useful guidance in a live test and
  stays silent in a normal short-task control.
- Memory extraction and collapse remain unaffected by observer telemetry.
