# Agent Observers V3 Spec

**Status:** Revised implementation spec
**Date:** 2026-04-28
**Builds on:** `docs/plans/2026-04-27-agent-subscriptions-and-observers-spec.md`,
`docs/plans/2026-04-27-agent-observers-v2-spec.md`

## Goal

Harden the V2 observer facility and extend it just far enough for non-root
agents to observe their own delegates safely.

V3 has three deliverables:

1. Hardening and inspection: checked-in validation, deterministic tests,
   authoring docs, and UI/event metadata that make observer behavior auditable.
2. Non-root delegate observation: owner-scoped `observe_delegates`, authenticated
   caller identity, runtime message grants, deterministic delegate-final frames,
   and bounded delivery before the owner moves on.
3. Two opt-in pilot observers:
   - `evidence-contradiction-observer`, for delegate result contradictions.
   - `pm-observer`, for sparse root-facing coordination-risk comments.

V3 intentionally does not add human notifications, severity levels, a persistent
notification inbox, raw event ids, observer memory writes, model-owned
subscribe/unsubscribe tools, public specific-handle targets, delegate-subtree
observation, additional observer model purposes, or hard enforcement of observer
advice.

## Current State

V2 already provides:

- Observers as normal agents.
- Runtime-owned subscription edges.
- `message_agent` as the comment primitive.
- `<sprout:agent-messages>` as the advisory prompt surface.
- Static root/session and root delegate-final observer config through
  `observers` and `observe_delegates`.
- `observer.metacognitive` model-purpose configuration with env override and no
  fallback.
- Memory/collapse exclusion for current observer telemetry.

Live validation has proved root-centric delivery, multi-observer delivery,
adversarial observer rejection by root, and nonblocking delegate negative
controls.

## Review-Driven Corrections

This revision incorporates the second adversarial review pass:

- Runtime message grants require authenticated runtime caller handle identity.
- Non-root observer ownership uses explicit attach/detach APIs.
- Frame rendering receives resolved comment addresses; it does not infer root or
  caller handles from text.
- Delegate-final context is captured at delegation start and keyed by child id.
- Blocking delegate-final observers get a bounded pre-next-plan/pre-terminal
  flush so useful comments are not routinely delivered too late.
- UI and `agent_message` events have enough sender/recipient metadata to prove
  root versus non-root delivery.
- Memory exclusion is by registered observer handle/agent id, not lifecycle flags
  alone.
- `target` is not a V3 comment recipient. V3 public recipients are only `root`
  and `caller`.
- Pilot observers use exact marker protocols in live tests, not vague semantic
  assertions.

## Principles

- Preserve V2: observers are ordinary agents; subscriptions are the special
  runtime edge.
- Keep the default observation set empty for normal agents.
- Add power only where owner, recipient, frame contents, and lifecycle are
  explicit.
- Keep observer comments advisory. A bounded flush makes delivery timely; it
  does not make advice mandatory.
- Keep memory boundaries intact. Observers do not write memory, feed extraction
  evidence, or replace recall/archivist/collapse.
- Prefer prompt-level silence guidance before runtime rate-limit APIs.

## Scope

### In Scope

- Checked-in manual live validation harness.
- Deterministic tests for multi-observer and non-root observer behavior.
- Observer authoring documentation.
- UI/event data contracts for observer nodes, frames, and comments.
- Runtime-controlled caller handle identity.
- Subscription-scoped message grants.
- Owner-scoped non-root `observe_delegates`.
- Deterministic delegate-final snapshots.
- Bounded pre-next-plan/pre-terminal observer flush for blocking delegate-final
  observers.
- Pilot `evidence-contradiction-observer`.
- Pilot `pm-observer`.

### Out of Scope

- Human notification UI or toasts.
- Severity levels.
- Persistent notification inbox.
- Raw event ids in observer frames.
- Observer memory writes.
- Dynamic subscribe/unsubscribe tools.
- `notify_agent`, `publish_observation`, or `reply_to_notification`.
- Public `target` comment recipient.
- Public specific-handle target syntax.
- Delegate-subtree observation.
- Additional observer model purposes.
- Runtime duplicate-suppression or rate-limit config.
- A full specialized observer catalog.

## Phase 1: Validation And Documentation

### 1.1 Checked-In Manual Live Harness

Add an opt-in live harness:

```text
scripts/live-observer-validation.ts
```

The harness must:

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
  correct comment. Target behavior is diagnostic.
- `adversarial-comment`: wrong observer comment is delivered and appears in the
  target prompt. Target rejection is diagnostic.
- `multi-observer`: three distinct observers start, receive frames, emit
  role-tagged `agent_message` events, and render into root prompt context.
- `nonblocking-negative`: handle-only nonblocking delegate handoff does not
  trigger delegate-final observers.
- `non-root-delegate-observer`: a non-root owner receives a delegate observer
  comment through a runtime grant; root does not receive that comment.
- `evidence-contradiction-pilot`: fixed caller marker
  `CALLER_EXPECTED_ALPHA`, fixed child marker `CHILD_RETURNED_BETA`, one
  observer message quoting both markers.
- `pm-observer-pilot`: fixed session markers proving a visible coordination
  conflict, one PM observer message to root, and a normal-progress silence
  control.

Primary pass/fail assertions:

- Expected observer `act_start` events exist.
- Expected observer frames are delivered.
- Expected observer `agent_message` events exist with `from_role: "observer"`.
- Target replay/request context contains the observer message in
  `<sprout:agent-messages>`.
- Negative controls have no observer start/message events.
- Warning counts are reported and fail for unexpected delivery/runtime warnings.
- Pilot cases use exact marker protocols and machine-checkable event facts.

Behavioral assertions:

- Target obedience is diagnostic except for deterministic marker harnesses whose
  prompts explicitly require a marker.
- A target ignoring advisory guidance is not itself a delivery failure.

### 1.2 Deterministic Tests

Recommended files:

- `test/host/observer-registry.test.ts`
- `test/host/session-controller.test.ts`
- `test/agents/steering.test.ts`
- `test/bus/spawner.test.ts`
- `test/host/session-collapse.test.ts`
- `test/learn/extraction-evidence.test.ts`
- `web/src/hooks/useAgentTree.test.ts`

Required cases:

- Two root/session subscriptions can be active at once without handle
  collisions.
- A root observer and delegate observer for the same observer agent use distinct
  handles.
- Multiple distinct observer agents can inject messages in the same root turn.
- Agent messages preserve sender role, sender handle, and recipient handle.
- Target prompt receives queued observer messages once, then clears them.
- Nonblocking delegate `act_end` with a handle and no `turns` does not trigger
  delegate-final observers.
- Observer delivery failure for one subscription does not block unrelated
  subscriptions.
- Non-root observer configured with `can_message: [caller]` can message caller.
- The same observer cannot message `root`.
- An observer-like caller without the granted handle cannot spoof access to root
  or caller.
- Delegate-final frames include the correct caller snapshot and child final
  output for interleaved delegates.
- Observer telemetry is excluded from collapse and extraction for root and
  non-root observers.

### 1.3 Observer Authoring Documentation

Add:

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
- V3 comment recipients are only `root` and `caller`; `target` is future work
  and must be rejected in V3 public config.
- How comment policy becomes runtime messaging grants.
- Why observers call `message_agent` with the handle named in the frame, then
  finish with `MESSAGE_SENT`.
- When to return `NO_MESSAGE`.
- Why observers must quote visible evidence and avoid hidden prompt/policy
  claims.
- Why observers must not suggest memory writes.

Acceptance criteria:

- The guide includes one root/session observer example.
- The guide includes one delegate-final observer example.
- The guide includes one bad prompt example and explains the failure mode.

## Phase 2: Runtime Identity And Messaging Grants

V3 grants are not enforceable unless `messageAgent` receives authenticated
runtime caller identity.

### 2.1 Authenticated Caller Identity

Extend bus/runtime caller identity with runtime-controlled fields:

```ts
interface CallerIdentity {
	agent_name: string;
	depth: number;
	role?: "observer";
	handle_id: string;
	agent_id: string;
}
```

Rules:

- `handle_id` and `agent_id` are populated by runtime/process context, not by
  model-supplied tool arguments.
- Root uses `handle_id: "root"` and the root agent id.
- Observer processes use their stable observer handle id and agent id.
- Bus validation rejects malformed caller identities.
- Existing name/depth fields remain for display and compatibility, but
  authorization uses handle/id fields.

### 2.2 Message Grant Store

`AgentSpawner` owns and enforces observer message grants because
`AgentSpawner.messageAgent()` is the authorization boundary.

```ts
interface ObserverMessageGrant {
	subscriptionId: string;
	observerHandleId: string;
	observerAgentId: string;
	allowedRecipients: Array<{
		recipient: "root" | "caller";
		handleId: string;
		agentId: string;
		agentName: string;
	}>;
}
```

Grant lifecycle:

- `ObserverRegistry` asks `AgentSpawner` to register a grant when starting an
  observer handle.
- `AgentSpawner` removes grants when the subscription is detached, the observer
  handle closes, or the session resets.
- Grant checks run before the root special case in `messageAgent`.

Authorization rule:

`messageAgent(targetHandle, message, caller, ...)` may deliver an observer
message through a grant only if:

- `caller.role === "observer"`;
- `caller.handle_id` equals `grant.observerHandleId`;
- `caller.agent_id` equals `grant.observerAgentId`;
- `targetHandle` appears in `grant.allowedRecipients`; and
- the recipient is allowed by the subscription comment policy.

Otherwise normal ownership/shared-handle rules apply.

Required tests:

- Granted observer can message caller.
- Granted root-owned observer can message root when root is the caller.
- Non-root observer with only caller grant cannot message root.
- Caller identity with matching name/depth but wrong handle/id cannot use the
  grant.
- Grant check precedes `handleId === "root"` delivery.

## Phase 3: Owner-Scoped Delegate Observers

V3's main architecture extension is non-root ownership for `observe_delegates`.
Do not add public specific-handle or delegate-subtree targets.

### 3.1 Subscription Owner

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

- Root-owned subscriptions use `ownerHandleId: "root"`.
- Non-root subscriptions use the owning handle's actual runtime handle id and
  agent id.
- Subscription ids and observer handle ids include `ownerHandleId` or
  `ownerAgentId` to avoid collisions.
- The registry must not key ownership by spec name/depth alone.

### 3.2 Registry Attachment API

Define explicit registry APIs:

```ts
interface ObserverRegistry {
	attachOwner(
		owner: ObserverSubscriptionOwner,
		configs: AgentDelegateObserverConfig[],
	): void;

	detachOwner(ownerHandleId: string, reason: "completed" | "closed" | "reset"): void;
}
```

Call sites:

- Call `attachOwner()` immediately after a handle is allocated/started and the
  owner agent spec is known.
- Call `detachOwner()` from result/cleanup for terminal non-shared handles.
- Shared handles keep owner subscriptions until close/reset.
- Root static subscriptions may be represented as an attached root owner.

Non-goals:

- Do not create a SessionController side table keyed by agent name/depth.
- Do not persist owner subscriptions across process restart in V3 unless
  existing handle resume makes it trivial.

### 3.3 Agent-Owned Static Config

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

V3 valid comment recipients:

- `root`
- `caller`

`target` must be rejected by parser/validator in V3 public config.

Semantics:

- The subscription applies only to delegations made by that owner handle.
- The observer sees delegate-final frames for blocking delegate completions.
- Handle-only nonblocking handoffs are excluded.
- The observer may message only grant-approved recipients.
- Non-root observers do not gain access to root unless a grant explicitly
  includes root.

### 3.4 Comment Addresses In Frames

Frame rendering must receive resolved message addresses. It must not infer
handles from comment policy alone.

```ts
interface ObserverCommentAddress {
	recipient: "root" | "caller";
	handleId: string;
	agentId: string;
	agentName: string;
}

interface BuildObserverFrameInput {
	// existing fields...
	commentAddresses?: ObserverCommentAddress[];
}
```

Rendering rules:

- Root-owned caller policy renders `handle "root"` because root is the caller.
- Non-root caller policy renders the actual owner handle id.
- A non-root caller frame must not mention `handle "root"` unless root is also
  an explicitly granted recipient.
- Observer prompts should tell agents to use the rendered handle exactly.

Required tests:

- Non-root caller frame renders the owner handle.
- Non-root caller frame does not render root when root is not granted.
- Root-owned caller frame preserves current root behavior.

### 3.5 Deterministic Delegate-Final Snapshots

Delegate-final frames must be based on a snapshot captured at delegation start,
not on "latest" caller events recovered later from a ring buffer.

Capture on caller `act_start` for delegation:

```ts
interface DelegateObservationSnapshot {
	childId: string;
	childHandleId: string;
	ownerHandleId: string;
	ownerAgentId: string;
	delegationGoal: string;
	delegationHints?: string[];
	callerGoal?: string;
	callerPlanText?: string;
	capturedAt: number;
}
```

Correlation:

- Snapshot is keyed by `childId` and `childHandleId`.
- The frame for a child completion uses that child's snapshot only.
- Interleaved delegates must not borrow each other's caller plan text.

Structured frame sections:

1. Comment policy and resolved message addresses.
2. Caller/delegation snapshot:
   - owner handle/name
   - delegation goal
   - delegation hints if present
   - bounded caller goal/follow-up context if available
   - bounded caller visible plan text before delegation if available
3. Child terminal result:
   - child `act_end` output/result
   - success/timed-out fields if available
4. Child evidence:
   - final child `plan_end.text`
   - child warnings/errors
   - relevant failed `primitive_end` outputs

Truncation priority:

1. Always keep comment addresses.
2. Always keep delegation goal.
3. Always keep child terminal result summary.
4. Keep caller plan text before lower-priority child evidence.
5. Keep warnings/errors before successful primitive output.
6. Drop oldest/lower-priority child evidence first.

Required tests:

- Frame includes delegation goal, caller plan snapshot, child output, and child
  evidence.
- Two interleaved delegates each receive the correct caller snapshot.
- Frame truncates lower-priority evidence before core sections.
- Frame excludes observer telemetry unless explicitly configured.

### 3.6 Delivery Timing

Delegate-final observers are useful only if their comments usually arrive before
the owner finalizes. V3 therefore adds a bounded flush for blocking
delegate-final observers.

Required behavior:

- After a blocking delegate returns and before the owner builds the next planning
  request or finalizes, the owner path calls a bounded observer flush for that
  owner.
- The flush waits only for delegate-final deliveries already queued for that
  completed child.
- The flush has a small timeout constant. Suggested default: 1500 ms.
- If the flush times out, emit a warning and continue. Advice is still advisory;
  the runtime must not block indefinitely.
- Nonblocking handle-only delegates still do not trigger delegate-final
  observers.

Acceptance criteria:

- Deterministic tests prove observer comments can appear in the owner's next
  prompt before final answer.
- Timeout path emits a warning and does not hang the owner.
- Runtime/live tests report whether a pilot comment arrived before finalization.

### 3.7 Lifecycle

Rules:

- Create owner-scoped subscriptions when the owning handle starts.
- Queue delegate-final deliveries before terminal cleanup for non-shared owners.
- Terminal cleanup may remove a subscription only after queued delegate-final
  deliveries drain or are dropped with a warning.
- Shared handles keep owner subscriptions until close/reset.
- Reset removes subscriptions and message grants.

Required race test:

- A non-shared owner completes after a blocking delegate final event while
  observer delivery is in flight; the final frame is delivered or a warning
  explains why it was dropped.

## Phase 4: UI And Event Data Contracts

### 4.1 Observer Tree Data

```ts
interface AgentTreeNode {
	isObserver?: boolean;
	subscriptionDescription?: string;
	subscriptionId?: string;
	ownerHandleId?: string;
	ownerAgentId?: string;
	observedTarget?: "root" | "session" | "caller_delegates";
}
```

Source:

- `isObserver` comes from `act_start.data.observer === true`.
- `subscriptionDescription` comes from `act_start.data.description`.
- `subscriptionId`, `ownerHandleId`, `ownerAgentId`, and `observedTarget` come
  from observer `act_start` data.
- UI must not infer observer status from names, prefixes, or descriptions.

Observer `act_start` data must include:

- `observer: true`
- `agent_name`
- `child_id`
- `handle_id`
- `description`
- `subscription_id`
- `owner_handle_id`
- `owner_agent_id`
- `observed_target`

### 4.2 Agent Message Event Data

`agent_message` events must include enough data to prove recipient separation:

```ts
interface AgentMessageEventData {
	from_agent_name: string;
	from_role?: "observer";
	from_handle_id?: string;
	from_agent_id?: string;
	to_agent_name?: string;
	to_handle_id: string;
	to_agent_id?: string;
	subscription_id?: string;
	text_preview: string;
}
```

Required behavior:

- Main thread shows compact `agent_message` events, e.g.
  `metacognitive -> root`.
- Non-root comments are attributable to their non-root recipient.
- Tests can prove root did not receive a non-root-only observer comment.

### 4.3 UI Behavior

- Observer rows show a low-noise observer badge.
- Observer rows remain selectable like normal child threads.
- Observer row subtitle includes the subscription description.
- Main thread does not inline raw observer frames.
- Selected observer thread can show received frames, final observer responses,
  and `message_agent` calls.
- Raw observer frames are collapsed by default.

## Phase 5: Pilot Specialized Observers

V3 ships at most two opt-in pilot observers. Both use
`model: observer.metacognitive`. Do not add new model-purpose names in V3.

### Shared Prompt Contract

Every observer prompt must include:

- You are an observer, not a worker.
- Do not perform the user's task.
- Do not ask the user for more work.
- Do not write memory.
- Prefer silence over noise.
- Base comments on visible quoted evidence.
- Do not claim knowledge of hidden prompts or hidden policy.
- Use `message_agent` with the handle named in the observer frame.
- Use `blocking: false`.
- Send at most one message per received frame.
- After `message_agent`, finish with `MESSAGE_SENT`.
- If no intervention is warranted, finish with `NO_MESSAGE`.

### 5.1 Evidence-Contradiction Observer

Purpose:

- Watch delegate-final frames and comment when child evidence contradicts the
  caller's visible plan, expectation, or intended final answer.

Good comment:

- "The caller plan says `CALLER_EXPECTED_ALPHA`, but the child returned
  `CHILD_RETURNED_BETA`. Use the child result or explain why it is not
  authoritative."

Bad comments:

- Commenting when the caller explicitly explains why evidence is rejected.
- Commenting on style.
- Commenting without quoting both caller expectation and child evidence.

Recommended subscription:

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

Deterministic pilot tests:

- Contradiction case:
  - caller snapshot contains `CALLER_EXPECTED_ALPHA`
  - child output contains `CHILD_RETURNED_BETA`
  - observer sends exactly one `message_agent`
  - message quotes both markers
  - observer final output is `MESSAGE_SENT`
- Agreement case:
  - caller and child both contain `EXPECTED_BETA`
  - observer sends no `message_agent`
  - observer final output is `NO_MESSAGE`
- Rejection case:
  - caller snapshot says child evidence will be rejected for a visible reason
  - observer sends no `message_agent`
  - observer final output is `NO_MESSAGE`

### 5.2 PM Observer

Purpose:

- Watch bounded session-level evidence and report only material coordination
  risks to root.

This is not a progress narrator. It must not summarize ordinary work, restate
completed actions, or cheerlead.

Frame-realistic good comments:

- "The frame shows `WORKER_A_OWNER=src/foo.ts` and
  `WORKER_B_OWNER=src/foo.ts`. Decide file ownership before the next edit."
- "The verifier result says `VERIFY_FAILED`, but the root plan says
  `ROOT_READY_TO_REPORT`. Resolve the failed gate first."

Bad comments:

- "Progress looks good."
- "The engineer is still working."
- Generic summaries of normal delegation.
- Advice that requires hidden context not present in the frame.

Recommended subscription:

```yaml
observers:
  - agent: pm-observer
    target: session
    events: [plan_end, warning, error, act_end, primitive_end]
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

Deterministic pilot tests:

- Coordination conflict:
  - frame contains `WORKER_A_OWNER=src/foo.ts`
  - frame contains `WORKER_B_OWNER=src/foo.ts`
  - observer sends exactly one `message_agent` to root
  - message quotes both markers
  - observer final output is `MESSAGE_SENT`
- Failed gate:
  - frame contains `VERIFY_FAILED`
  - frame contains `ROOT_READY_TO_REPORT`
  - observer sends exactly one `message_agent` to root
  - observer final output is `MESSAGE_SENT`
- Normal progress:
  - frame contains only successful non-conflicting delegate completions
  - observer sends no `message_agent`
  - observer final output is `NO_MESSAGE`

### Deferred Observer Ideas

Not V3 deliverables:

- Failure-loop observer.
- Instruction-drift observer.
- Context-pressure observer.
- Human-facing PM notification observer.
- Dedicated observer model purposes.

If pilot results show clear value and low noise, write a separate observer
catalog spec.

## Phase 6: Memory And Event Exclusion

Exclusion must be based on registered observer identity, not only lifecycle event
flags.

Runtime requirements:

- Registry/spawner can provide the set of observer handle ids and observer agent
  ids for the session.
- Every observer process event uses the stable observer `agent_id`.
- Every observer `agent_message` includes `from_role: "observer"` and
  `from_handle_id`.
- Observer lifecycle `act_start` events include the metadata listed in Phase 4.

Required exclusions:

- Observer lifecycle events do not become memory evidence.
- Observer frames do not become memory evidence.
- Observer `plan_end`, `primitive_end`, `act_end`, and final responses do not
  become memory evidence.
- Observer `agent_message` events do not become memory evidence.
- Observer child logs are excluded from collapse transcripts.

Required tests:

- Root observer telemetry is excluded from collapse and extraction.
- Non-root observer telemetry is excluded from collapse and extraction.
- A non-root observer emits `plan_end`, `primitive_end`, `act_end`, and
  `agent_message`; none enter collapse/extraction.
- Normal non-observer delegate evidence is still preserved.

## Settings And Model Purposes

V3 uses only:

```ts
type AgentModelPurpose = "observer.metacognitive";
```

Rules:

- `pm-observer` and `evidence-contradiction-observer` use
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
- Parser rejects `target` as a V3 comment recipient.
- Caller identity validation requires runtime handle/id.
- Grant authorization checks handle/id before root special-case delivery.
- Observer frame comment policy renders resolved non-root caller handle.
- Observer registry filters delegate final events by owner.
- Observer registry uses collision-proof handles for multiple owner instances.
- Delegate-final snapshot correlation handles interleaved delegates.
- Delegate-final frame builder applies truncation priority.
- Observer telemetry exclusion covers non-root observers.

### Integration

- Non-root owner attaches delegate observer through `attachOwner()`.
- Observer comments to non-root caller through grant.
- Root does not receive non-root-only comment.
- Spoofed observer-like caller cannot use another observer's grant.
- Two instances of the same caller agent do not share observer state.
- Bounded flush puts deterministic observer comment into owner's next prompt.
- Flush timeout warns and does not hang owner.
- Owner terminal cleanup does not silently drop queued delegate-final frame.

### UI

- Observer badge renders from `AgentTreeNode.isObserver`.
- Observer subtitle renders from `subscriptionDescription`.
- Observer owner metadata is available on observer tree nodes.
- `agent_message` compact display uses explicit sender/recipient metadata.
- UI can distinguish root recipient from non-root recipient.
- Observer selected thread shows received frames.
- Main root thread shows compact comments, not raw frames.

### Live Manual

- Run checked-in live harness with multiple root/session observers.
- Run non-root delegate observer live scenario.
- Run evidence-contradiction pilot contradiction/agreement/rejection cases.
- Run PM observer conflict/failed-gate/normal-progress cases.
- Report warning counts and whether pilot comments arrived before finalization.

## Rollout

1. Check in validation harness and authoring docs.
2. Add deterministic multi-observer tests for current V2 behavior.
3. Extend runtime caller identity with handle/id.
4. Add `AgentSpawner` observer message grants.
5. Add UI/event metadata contracts.
6. Add owner-scoped `attachOwner()`/`detachOwner()`.
7. Add deterministic delegate-final snapshots.
8. Add bounded delegate-final observer flush.
9. Add non-root memory/collapse exclusion tests.
10. Add `evidence-contradiction-observer` as opt-in.
11. Add `pm-observer` as opt-in.
12. Run live noise tests before enabling either pilot observer by default.

## Success Criteria

- Observer behavior is documented enough that a new observer can be authored
  without reading runtime code.
- Multi-observer behavior has deterministic tests and a live validation script.
- Runtime grants are enforceable by unspoofable caller handle/id.
- A non-root agent can observe and comment on its own delegate through an
  explicit grant.
- Non-root observer comments cannot reach root unless explicitly granted.
- Delegate-final observers receive deterministic bounded caller context and
  child output.
- Bounded flush can deliver delegate-final comments before owner finalization.
- UI makes observer activity inspectable without name-based inference.
- PM observer and evidence-contradiction observer each pass deterministic useful
  cases and silence controls.
- Memory extraction and collapse remain unaffected by observer telemetry.
