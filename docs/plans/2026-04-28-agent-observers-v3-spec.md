# Agent Observers V3 Spec

**Status:** Revised follow-on spec
**Date:** 2026-04-28
**Builds on:** `docs/plans/2026-04-27-agent-subscriptions-and-observers-spec.md`,
`docs/plans/2026-04-27-agent-observers-v2-spec.md`

## Goal

Harden the V2 observer facility and extend it just far enough for non-root
agents to observe their own delegates safely.

V3 should ship with a small pilot observer set, but it should not become a broad
observer platform yet. The core runtime work is:

1. Checked-in validation, deterministic tests, authoring docs, and UI
   inspection improvements.
2. Non-root `observe_delegates` with precise owner identity, runtime messaging
   grants, and bounded caller context in delegate-final frames.
3. Two pilot specialized observers:
   - `pm-observer`: a root-facing coordination-risk observer.
   - `evidence-contradiction-observer`: a delegate-final observer for mismatches
     between caller expectations and observed evidence.

V3 intentionally does not add human notifications, severity levels, a persistent
notification inbox, raw event ids, observer memory writes, model-owned
subscribe/unsubscribe tools, or hard enforcement of observer advice.

## Current State

V2 is implemented around these decisions:

- Observers are normal agents.
- Subscriptions are runtime-owned edges.
- Observer comments use `message_agent`.
- Agent-originated comments render in `<sprout:agent-messages>`.
- Observer comments are advisory process guidance, not user messages and not
  hard interrupts.
- Static config supports root/session observation and root delegate-final
  observation through `observers` and `observe_delegates`.
- Observer model selection uses Sprout settings through
  `observer.metacognitive`, with env override support and no fallback.
- Observer telemetry is excluded from collapse and memory extraction evidence.

Live validation has proved:

- Root observers can see root/session events, inject messages, and be consumed
  by root.
- Delegate-final observers can see blocking delegate completion, inject
  messages, and be consumed by root.
- Root can reject deliberately wrong observer advice against stronger evidence.
- Three distinct observer agents can run together.
- Handle-only nonblocking delegate handoffs do not trigger delegate-final
  observers.

## Review-Driven Corrections

This revision incorporates the adversarial review findings:

- V3 scope is reduced. Scoped handle targets, delegate-subtree observation,
  runtime-created subscriptions, a broad observer catalog, rate-limit APIs, and
  extra model-purpose names are future work.
- Non-root ownership is explicit. Subscriptions have a concrete owner record,
  not a SessionController side table keyed by name/depth.
- Observer messaging is authorized by runtime grants. Prompt-only comment policy
  is not enough.
- Live harness pass/fail criteria focus on delivery, frame inclusion,
  `agent_message` emission, and prompt rendering. Target obedience is diagnostic
  evidence, not the primary gate.
- Delegate-final frames must include bounded caller context as well as child
  output so contradiction observers are not blind.
- UI requirements include a data-model contract, not name-based inference.
- Memory exclusion requirements specify observer event metadata for non-root
  observers too.

## Design Principles

- Preserve V2: observers are ordinary agents; subscriptions are the special
  runtime edge.
- Keep the default observation set empty for normal agents.
- Add power only where the owner, recipient, and frame contents are explicit.
- Prefer static configuration over model-owned subscribe/unsubscribe tools.
- Keep observer comments advisory. If hard intervention is ever needed, add a
  separate runtime-intervention feature.
- Keep memory boundaries intact. Observers do not write memory, feed extraction
  evidence, or replace recall/archivist/collapse.
- Prefer prompt-level silence guidance before runtime rate-limit APIs.

## Scope

### In Scope

- Checked-in manual live validation harness.
- Deterministic multi-observer and non-root observer tests.
- Observer authoring documentation.
- UI inspection improvements for observer nodes, frames, and comments.
- Root/session observer UI data contract.
- Non-root caller-owned `observe_delegates`.
- Subscription owner identity.
- Subscription-scoped messaging grants.
- Delegate-final frames with bounded caller context.
- Pilot `pm-observer`.
- Pilot `evidence-contradiction-observer`.

### Out of Scope

- Human notification UI or toasts.
- Severity levels.
- Persistent notification inbox.
- Raw event ids in observer frames.
- Observer memory writes.
- Dynamic subscribe/unsubscribe tools.
- `notify_agent`, `publish_observation`, or `reply_to_notification`.
- Hard runtime enforcement of observer advice.
- Public specific-handle target syntax.
- Delegate-subtree observation.
- Additional observer model purposes.
- Runtime duplicate-suppression or rate-limit config.
- A full specialized observer catalog.

## Phase 1: Validation And Documentation

### 1.1 Checked-In Manual Live Harness

Add a checked-in manual harness for live provider validation.

Recommended path:

```text
scripts/live-observer-validation.ts
```

The harness should:

- Use Bun/TypeScript only.
- Build temporary root and genome directories.
- Define deterministic probe-worker tools with `sprout-internal`.
- Run through the real bus, spawner, subprocess agent, session controller, and
  model resolver.
- Load `.env` and Sprout settings like normal runtime.
- Require explicit opt-in, such as `--live` or
  `SPROUT_RUN_LIVE_OBSERVER_TESTS=1`.
- Write JSON summaries to each temp case directory.
- Print compact pass/fail output with artifact paths.

Required live scenarios:

- `metacognitive-correction`: observer delivery and prompt rendering with a
  correct comment. Root behavior is recorded as diagnostic evidence.
- `adversarial-comment`: wrong observer comment is delivered and appears in the
  target prompt. Whether root rejects it is diagnostic, not the primary
  pass/fail gate.
- `multi-observer`: three distinct observers start, receive frames, emit
  role-tagged `agent_message` events, and render into root prompt context.
- `nonblocking-negative`: handle-only nonblocking delegate handoff does not
  trigger delegate-final observers.
- `non-root-delegate-observer`: a non-root caller owns a delegate observer,
  receives a comment through a runtime grant, and root does not receive that
  comment.

Primary pass/fail assertions:

- Expected observer `act_start` events exist.
- Expected observer frames are delivered.
- Expected observer `agent_message` events exist with `from_role: "observer"`.
- Target replay/request context contains the observer message in
  `<sprout:agent-messages>`.
- Negative controls have no observer start/message events.
- Warning counts are reported and fail only for unexpected delivery/runtime
  warnings.

Behavioral assertions:

- Root/caller response to observer advice may be checked with exact markers in
  controlled cases, but those checks are labeled diagnostic. A target ignoring
  advisory guidance is not a delivery failure.

### 1.2 Deterministic Tests

Live tests prove integration but cannot be the only guard.

Recommended files:

- `test/host/observer-registry.test.ts`
- `test/host/session-controller.test.ts`
- `test/agents/steering.test.ts`
- `test/bus/spawner.test.ts`
- `web/src/hooks/useAgentTree.test.ts`

Required cases:

- Two root/session subscriptions can be active at once without handle
  collisions.
- A root observer and delegate observer for the same observer agent use distinct
  handles.
- Multiple distinct observer agents can inject messages in the same root turn.
- Agent messages preserve `role="observer"` and `from_agent_name`.
- Target prompt receives all queued observer messages once, then clears them.
- Nonblocking delegate `act_end` with a handle and no `turns` does not trigger
  delegate-final observers.
- Observer delivery failure for one subscription does not block unrelated
  subscriptions.
- Non-root observer configured with `can_message: [caller]` cannot message
  `root`.
- Non-root observer configured with `can_message: [caller]` can message the
  owning caller through a runtime grant.
- Delegate-final frames include bounded caller context and child final output.

### 1.3 Observer Authoring Documentation

Add a short guide:

```text
docs/agents/observer-authoring.md
```

The guide should cover:

- Observers are normal agents.
- Required frontmatter:
  - `tools: [message_agent]`
  - `tags: [observer]`
  - `model: observer.metacognitive`
  - `can_spawn: false`
  - `can_learn: false`
- How `observers` and `observe_delegates` attach observers.
- How comment policy maps to runtime messaging grants.
- Why observers should call `message_agent` with the handle named in the frame,
  then finish with `MESSAGE_SENT`.
- When to return `NO_MESSAGE`.
- Why observers must quote visible evidence and avoid claims about hidden
  prompts or hidden policy.
- Why observers must not suggest memory writes.

Acceptance criteria:

- The guide includes one root/session observer example.
- The guide includes one delegate-final observer example.
- The guide includes one bad prompt example and explains the failure mode.

## Phase 2: UI Inspection Improvements

V2 made observers visible as normal child threads. V3 should make that
inspection robust and low-noise.

### 2.1 Data Contract

Tree construction should expose explicit observer metadata.

Required fields:

```ts
interface AgentTreeNode {
	isObserver?: boolean;
	subscriptionDescription?: string;
}
```

Source:

- `isObserver` comes from `act_start.data.observer === true`.
- `subscriptionDescription` comes from `act_start.data.description`.
- UI must not infer observer status from agent name, handle prefix, or
  description text.

### 2.2 UI Behavior

Required behavior:

- Observer rows show a low-noise observer badge.
- Observer rows remain selectable like normal child threads.
- Observer row subtitle includes the subscription description.
- Main thread shows compact `agent_message` events, such as
  `metacognitive -> root`.
- Main thread does not inline raw observer frames.
- Selected observer thread can show received frames, final observer responses,
  and `message_agent` calls.
- Raw observer frames are collapsed by default.

Acceptance criteria:

- Existing readable main-thread grouping remains intact.
- Tests assert `isObserver` and `subscriptionDescription`.
- Tests prove observer raw frame text is available on selection but not expanded
  by default.

## Phase 3: Non-Root Delegate Observers

V3's main architecture extension is non-root ownership for `observe_delegates`.
Do not add public specific-handle or delegate-subtree targets in this phase.

### 3.1 Subscription Owner

Every observer subscription has an owner.

```ts
interface ObserverSubscriptionOwner {
	ownerHandleId: string;
	ownerAgentId: string;
	ownerSpecName: string;
	ownerDepth: number;
	shared: boolean;
}
```

Rules:

- Root-owned subscriptions use `ownerHandleId: "root"` and the root agent id.
- Non-root caller-owned subscriptions use the caller's actual runtime handle id
  and agent id.
- Subscription keys and observer handle ids must include either
  `ownerHandleId` or `ownerAgentId` to avoid collisions between multiple
  instances of the same spec.
- The registry attaches owner-scoped subscriptions from the spawn/delegation
  path. Do not build a separate SessionController side table keyed only by
  agent name/depth.

### 3.2 Agent-Owned Static Config

Any agent spec may define:

```yaml
observe_delegates:
  - agent: evidence-contradiction-observer
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

- The subscription applies only to delegations made by that specific agent
  instance.
- The observer sees delegate-final frames for blocking delegate completions.
- Handle-only nonblocking handoffs are excluded.
- The observer may message only recipients allowed by its runtime messaging
  grant.
- The observer does not gain access to `root` unless a grant explicitly includes
  root.

### 3.3 Runtime Messaging Grants

Prompt-level comment policy is not sufficient authorization.

When the registry starts an observer handle, it also registers a scoped grant:

```ts
interface ObserverMessageGrant {
	observerHandleId: string;
	allowedRecipients: Array<{
		recipient: "root" | "caller";
		handleId: string;
		agentId: string;
	}>;
	subscriptionId: string;
}
```

`messageAgent` must allow observer-originated messages to a recipient handle if:

- the caller handle is the observer handle;
- the target handle appears in an active grant for that observer handle; and
- the target is permitted by the subscription comment policy.

Otherwise normal ownership/shared-handle rules apply.

Required tests:

- Non-root observer with `can_message: [caller]` can message caller.
- The same observer cannot message `root`.
- Root-owned delegate observer with `can_message: [caller]` can still message
  `root` because root is the caller.
- Grant is removed or invalidated when the subscription is removed.

### 3.4 Caller Address Rendering

Observer frames should name the address the observer is allowed to message.

Root-owned caller policy:

```text
For caller comments in this subscription, call message_agent with handle "root"
and blocking false.
```

Non-root caller policy:

```text
For caller comments in this subscription, call message_agent with handle
"<ownerHandleId>" and blocking false.
```

The observer must not infer handles from raw events.

### 3.5 Delegate-Final Frame Contents

Delegate-final observers need enough context to compare caller intent with
delegate evidence.

A delegate-final frame should include:

- The child final response or final tool-result content.
- The caller `act_end` event.
- Bounded latest caller goal or follow-up context when available.
- Bounded latest caller `plan_end.text` before the delegation when available.
- Warnings/errors emitted by the child during the delegated run.

Bounds:

- Caller context must be short and subject to `max_events`/`max_chars`.
- Do not include full hidden prompts.
- Do not include raw event ids.
- Redaction applies to all quotes.

Required tests:

- Frame includes child output and caller plan text.
- Frame truncates caller context under bounds.
- Frame does not include observer telemetry unless explicitly configured.

### 3.6 Delivery Timing

Observer delivery after a delegate final event is asynchronous.

V3 should not promise that a non-root caller receives an observer comment in the
immediate next planning prompt unless the implementation adds an explicit
synchronization point.

Default semantics:

- Delivery is best-effort eventual within the same running handle.
- If the comment arrives before the next planning request is built, it appears
  in that request.
- If the caller has already started its next planning request, the comment
  appears in the following turn or follow-up, if the handle is still alive.

Optional future synchronization:

- A later phase may add a bounded pre-plan observer flush for delegate-final
  subscriptions, but V3 does not require it.

Acceptance criteria:

- Tests that require exact prompt-turn placement must use deterministic
  synchronization.
- Runtime tests may assert eventual prompt inclusion rather than immediate
  next-turn inclusion.

### 3.7 Lifecycle

Rules:

- Create owner-scoped subscriptions when the owning agent starts.
- Queue delegate-final deliveries before removing subscriptions for terminal
  non-shared owners.
- Terminal cleanup may remove the subscription only after queued delegate-final
  deliveries drain or are explicitly dropped with a warning.
- Keep subscriptions alive for shared handles until the handle is closed or the
  session resets.
- Reset all subscriptions and grants on `/clear`.

Required race test:

- A non-shared caller completes after a blocking delegate final event while
  observer delivery is in flight; the final frame is either delivered or a
  warning explains why it was dropped. It must not disappear silently.

## Phase 4: Pilot Specialized Observers

V3 should ship at most two specialized observers. Both reuse
`observer.metacognitive` initially. Do not add new model-purpose names until a
live result proves the shared observer model is inadequate.

Pilot observers are opt-in until live noise testing proves they are quiet enough
for default root config.

### Shared Prompt Contract

Every observer prompt must include:

- You are an observer, not a worker.
- Do not perform the user's task.
- Do not ask the user for more work.
- Do not write memory.
- Prefer silence over noise.
- Base comments on visible quoted evidence.
- Do not claim knowledge of hidden prompts or hidden policy.
- Use `message_agent` with the handle named in the observer comment policy.
- Use `blocking: false`.
- After `message_agent`, finish with `MESSAGE_SENT`.
- If no intervention is warranted, finish with `NO_MESSAGE`.

### 4.1 PM Observer

Purpose:

- Watch session-level coordination and report only material coordination risks
  to root.

This is not a progress narrator. It should not summarize ordinary work, restate
completed actions, or cheerlead. It is useful only when it sees evidence that
root needs to change coordination behavior.

Good comments:

- "Two delegates are working on overlapping files. Decide ownership before the
  next edit."
- "The verifier found a failing gate, but root is preparing to report
  completion. Resolve the gate first."
- "A worker is blocked on missing context that root already has. Send the exact
  constraint instead of starting a new parallel branch."

Bad comments:

- "Progress looks good."
- "The engineer is still working."
- Generic summaries of normal delegation.
- Advice that requires hidden context not present in the frame.

Recommended initial subscription:

```yaml
observers:
  - agent: pm-observer
    target: session
    events: [plan_end, warning, error, act_end]
    trigger:
      every: 2
      event: act_end
    delivery:
      max_events: 24
      max_chars: 6000
    comments:
      can_message: [root]
      default_recipient: root
```

Acceptance criteria:

- Live scenario with two conflicting delegate results causes one concise PM
  comment to root.
- Normal short task produces `NO_MESSAGE`.
- Normal successful delegate completion produces `NO_MESSAGE`.
- PM observer never messages non-root agents in V3.

### 4.2 Evidence-Contradiction Observer

Purpose:

- Watch delegate-final frames and comment when child evidence contradicts the
  caller's visible plan, expectation, or intended final answer.

Good comments:

- "The worker returned `BETA`, but the caller plan still says `ALPHA`. Use the
  worker result or explain why it is not authoritative."
- "The command output says the test failed, but the current summary says all
  tests passed."

Bad comments:

- Commenting when the caller explicitly explains why evidence is rejected.
- Commenting on style.
- Commenting without quoting both the caller expectation and child evidence.

Recommended initial subscription:

```yaml
observe_delegates:
  - agent: evidence-contradiction-observer
    trigger: on_delegate_final
    events: [plan_end, primitive_end, act_end, warning, error]
    delivery:
      max_events: 12
      max_chars: 5000
    comments:
      can_message: [caller]
      default_recipient: caller
```

Acceptance criteria:

- It comments when child output contradicts visible caller plan text.
- It stays silent when child output agrees with caller plan text.
- It stays silent when caller visibly rejects the child output with a reason.
- It quotes both sides of the contradiction.

### Deferred Observer Ideas

These are not V3 deliverables:

- Failure-loop observer.
- Instruction-drift observer.
- Context-pressure observer.
- Human-facing PM notification observer.
- Observer agents with dedicated model purposes.

If pilot results show clear value and low noise, write a separate observer
catalog spec for additional observers.

## Phase 5: Memory And Event Metadata Requirements

All observer lifecycle events, including non-root observers, must preserve the
metadata used by memory and UI exclusion logic.

Required event data:

- `observer: true`
- stable `child_id`
- stable `handle_id`
- `agent_name`
- `description`

Required exclusions:

- Observer lifecycle events do not become memory evidence.
- Observer frames do not become memory evidence.
- Observer `agent_message` events do not become memory evidence.
- Observer child logs are excluded from collapse transcripts.

Required tests:

- Non-root observer telemetry is excluded from collapse transcript.
- Non-root observer telemetry is excluded from extraction evidence.
- Normal non-observer delegate evidence is still preserved.

## Settings And Model Purposes

V3 uses only:

```ts
type AgentModelPurpose = "observer.metacognitive";
```

Rules:

- `pm-observer` and `evidence-contradiction-observer` initially use
  `model: observer.metacognitive`.
- Missing `observer.metacognitive` configuration fails loudly.
- `SPROUT_OBSERVER_METACOGNITIVE_MODEL` remains the only observer env override.
- Do not add additional observer model purposes in V3.

Future decision rule:

- Add a new observer model purpose only after a committed observer demonstrably
  needs a stronger/different model than the shared observer purpose.

## Noise Control

V3 does not add runtime duplicate suppression or rate-limit config.

Use prompt-level noise budgets first:

```text
At most one comment per observed task unless the new frame contains materially
different evidence.
```

If pilot observers are noisy in live use, collect examples and write a targeted
follow-up spec for the smallest runtime control needed.

## Test Plan

### Unit

- Parser accepts agent-owned `observe_delegates` outside root.
- Parser rejects unsupported targets and comment recipients.
- Observer frame comment policy renders actual caller handle for non-root
  caller subscriptions.
- Observer registry filters delegate final events by owner.
- Observer registry uses collision-proof handles for multiple owner instances.
- Observer message grants permit caller and reject ungranted root messaging.
- Delegate-final frame builder includes caller context and child output.
- Observer telemetry exclusion tests cover non-root observers.

### Integration

- Non-root agent delegates to a worker and owns a delegate-final observer.
- Observer comments to the non-root caller through a runtime grant.
- Root does not receive that comment.
- Two instances of the same caller agent do not share observer state.
- One observer delivery failure does not block another subscription.
- Owner terminal cleanup does not silently drop a queued delegate-final frame.

### UI

- Observer badge renders from `AgentTreeNode.isObserver`.
- Observer subtitle renders from `subscriptionDescription`.
- Observer selected thread shows received frames.
- Main root thread shows compact comments, not raw frames.
- Delegate observer appears under the correct caller or observed delegate.

### Live Manual

- Run checked-in live harness with multiple root/session observers.
- Run non-root delegate observer live scenario.
- Run PM observer conflict scenario and normal-task silence control.
- Run evidence-contradiction observer contradiction scenario and agreement
  silence control.

## Rollout

1. Check in validation harness and authoring docs.
2. Add deterministic multi-observer tests for current V2 behavior.
3. Add UI data contract and inspection improvements.
4. Add runtime observer message grants.
5. Add owner-scoped non-root `observe_delegates`.
6. Add delegate-final caller context.
7. Add `evidence-contradiction-observer` as opt-in.
8. Add `pm-observer` as opt-in.
9. Run live noise tests before enabling either pilot observer by default.

## Success Criteria

- Observer behavior is documented enough that a new observer can be authored
  without reading runtime code.
- Multi-observer behavior has deterministic tests and a live validation script.
- UI makes observer activity inspectable without polluting the main task thread.
- A non-root agent can observe and comment on its own delegate through an
  explicit runtime grant.
- Non-root observer comments cannot reach root unless explicitly granted.
- Delegate-final observers receive enough bounded caller context to detect
  evidence contradictions.
- PM observer and evidence-contradiction observer each pass one useful live
  scenario and one silence control.
- Memory extraction and collapse remain unaffected by observer telemetry.
