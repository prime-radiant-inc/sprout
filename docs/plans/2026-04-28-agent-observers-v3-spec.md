# Agent Observers V3 Spec

**Status:** Revised implementation spec
**Date:** 2026-04-28
**Builds on:** `docs/plans/2026-04-27-agent-subscriptions-and-observers-spec.md`,
`docs/plans/2026-04-27-agent-observers-v2-spec.md`

## Goal

Harden Sprout's observer facility into a small, faithful substrate for
long-lived sidecar agents.

V3 keeps the core design from V1/V2:

- Observers are ordinary Sprout agents with prompts, models, tools, logs, and UI
  threads.
- Observation is the special runtime relationship. The observer itself is not a
  new actor kind.
- The runtime feeds bounded observer frames over time.
- Observers use the existing `message_agent` primitive to send advisory
  guidance.
- Observer guidance is delivered through `<sprout:agent-messages>`, not as user
  steering.

The main V3 simplification is addressability:

```text
Observers do not get scoped grants.
Observers do not choose arbitrary recipients.
Observers message their runtime caller through handle "caller".
```

For a root/session observer, `caller` resolves to root. For a non-root delegate
observer, `caller` resolves to the exact runtime handle that owns the
subscription. This preserves independent, stateful observer agents without
building an observer-specific permission system.

## Why This Exists

MIRA's equivalent is not a one-shot classifier. It is a stateful process-guidance
surface: the peanut gallery writes metacognitive guidance into the HUD, and
sidebar/overwatch work surfaces activity over time. Sprout's translation is:

- a long-lived observer agent process;
- runtime-delivered event frames;
- visible observer lifecycle and message events;
- advisory prompt-surface injection; and
- strict memory boundaries so observer telemetry does not become durable memory
  evidence by accident.

The facility should make it easy to add a metacognitive observer, a PM/session
observer, or a delegate-result contradiction observer later without creating a
new notification system or a parallel observer runtime.

## Current State

V2 already provides:

- Observers as normal agents.
- Runtime-owned subscription edges.
- Static root/session and root delegate-final observer config through
  `observers` and `observe_delegates`.
- `message_agent` as the agent-to-agent comment primitive.
- `<sprout:agent-messages>` as the advisory prompt surface.
- `agent_message` events for UI visibility.
- `observer.metacognitive` model-purpose configuration with env override and no
  fallback.
- Memory/collapse exclusion for current observer telemetry.

Live validation has proved root-centric observer delivery, multi-observer
delivery, adversarial observer rejection by root, and nonblocking delegate
negative controls.

Known weakness:

- Sprout already has runtime `handleId` and `agentId`, but `CallerIdentity`
  currently carries only `agent_name`, `depth`, and optional `role`.
- Current non-shared handle checks compare by `agent_name`, not exact runtime
  handle/id.
- `handle: "root"` is a global special case. V3 should migrate observer prompts
  to `handle: "caller"` and stop relying on a root side channel.
- Current observer handles are kept alive with `shared: true`, but `shared`
  also makes handles globally addressable. V3 must split persistence from
  addressability.
- Current observer frame delivery reuses `message_agent` to the observer handle.
  That conflates runtime frame input with advisory agent messages.

## Core Decisions

### Long-Lived, Not One-Shot

Observer handles are persistent for the lifetime of their subscription. Later
frames are delivered to the same observer handle so the observer can accumulate
context in its own transcript.

V3 must not replace observers with "run an analyzer and parse its final text".
That would lose the external, independent, over-time property we want.

### Persistent, Not Shared

Observer handles need persistence, not public addressability.

Do not rely on `shared: true` to keep observer agents alive if `shared` means
"any agent that learns the handle can message or wait on it." Add or reuse a
runtime concept that keeps a handle alive/idle while leaving it private to its
owner/runtime subscription.

Rules:

- Observer handles are private by default.
- Only the runtime observer facility may send observer frames to observer
  handles.
- Observer agents may send advisory comments only through `handle: "caller"`.
- Observers must not wait/message arbitrary raw handles, even shared handles.
- If implementation needs temporary compatibility with existing shared observer
  handles, the compatibility path must be narrow, tested, and removed from new
  V3 behavior.

### Message Agent Stays

Observers remain ordinary tool-using agents. They send guidance with
`message_agent`, and the UI can show both received frames and outgoing tool
calls in the observer's thread.

V3 must not add `notify_agent`, `publish_observation`, or
`reply_to_notification`.

### Caller Alias Replaces Grants

V3 adds a runtime-resolved message target:

```json
{
  "handle": "caller",
  "message": "The delegate result contradicts the plan you just stated.",
  "blocking": false
}
```

Rules:

- `caller` is an alias, not a real handle.
- The model cannot choose what `caller` means.
- Runtime resolves `caller` from the current agent's trusted start context.
- For root-owned observers, `caller` resolves to root.
- For non-root delegate observers, `caller` resolves to that exact owner handle.
- `caller` messages are advisory and must use `blocking: false` in V3.
- If there is no live runtime caller address, `message_agent` fails loudly.

This is topology, not permissions. The owner/caller relationship already exists
when the runtime starts an agent. V3 exposes that relationship as the one safe
observer output channel.

### No Observer Grant Store

Do not implement `ObserverMessageGrant`, `allowedRecipients`, grant attach/detach
lifecycles, or recipient authorization tables in V3.

Those structures are only necessary if observers can name arbitrary recipients.
V3 deliberately avoids that.

### No Public Target Recipient

V3 supports only:

```text
message_agent(handle: "caller", blocking: false)
```

for observer comments. `target`, specific public handle targets, and
delegate-subtree messaging are future work.

### Handle Ownership Is Generic Hardening

Runtime identity hardening is still required, but it is not observer-specific
permissions. It fixes normal handle ownership semantics.

Sprout already creates unique runtime IDs:

- `handleId`: addressable runtime handle.
- `agentId`: stable event identity for that handle.

V3 threads these IDs into caller identity and ownership checks.

## Scope

### In Scope

- Runtime-owned caller identity with existing `handleId` and `agentId`.
- Exact handle ownership checks for normal `wait_agent` and `message_agent`.
- Runtime-resolved `handle: "caller"` alias.
- Long-lived root/session observers.
- Long-lived owner-scoped delegate observers.
- Delegate-final frames for blocking delegate completions.
- Bounded delivery before the owner continues after a blocking delegate.
- UI/event metadata sufficient to inspect observer activity.
- Memory/collapse/extraction exclusion for observer telemetry.
- Checked-in deterministic tests and one opt-in live validation harness.
- Observer authoring documentation for the `caller` alias.

### Out of Scope

- Subscription-scoped message grants.
- `can_message`, `default_recipient`, or other observer recipient policy in new
  V3 config.
- Human notification UI or toasts.
- Severity levels.
- Persistent notification inbox.
- Raw event ids in observer frames.
- Observer memory writes.
- Dynamic subscribe/unsubscribe tools.
- Public `target` comment recipient.
- Public specific-handle target syntax.
- Delegate-subtree observation.
- Additional observer model purposes.
- Runtime duplicate-suppression or rate-limit config.
- Hard enforcement of observer advice.

## Runtime Identity

### Self Identity And Caller Address

Separate two concepts that current code partially conflates:

- **Self identity**: the runtime identity of the agent making a tool call or
  emitting an event.
- **Caller address**: the immutable parent/caller address used to resolve
  `handle: "caller"`.

The bus field currently named `caller` is sender identity for outbound
`agent_message` payloads. Do not reuse it as the parent address.

Self identity:

```ts
interface CallerIdentity {
	agent_name: string;
	depth: number;
	handle_id: string;
	agent_id: string;
	role?: "observer";
}
```

Rules:

- `handle_id` and `agent_id` come from runtime/process context, not model tool
  arguments.
- Root uses `handle_id: "root"` and `agent_id: "root"` unless a stronger root
  id already exists.
- Subprocess agents use `SPROUT_HANDLE_ID` and `StartMessage.agent_id`.
- In-process root agents receive equivalent identity through `AgentOptions`.
- Existing `agent_name` and `depth` remain display/debug fields, not ownership
  authority.
- Bus validation rejects malformed caller identities.

Caller address:

```ts
interface CallerAddress {
	handleId: string;
	agentId: string;
	agentName: string;
	depth: number;
}
```

Rules:

- `callerAddress` is captured from trusted runtime state when an agent starts.
- Models cannot set or override `callerAddress`.
- For root-owned observers, `callerAddress.handleId === "root"`.
- For non-root delegate observers, `callerAddress` is the exact owner handle
  that owns the observer subscription.
- Tests must assert both sender and recipient handle/id on `agent_message`
  events.

### Agent Options

`Agent` needs both its own runtime identity and its caller address:

```ts
interface AgentOptions {
	// existing fields...
	handleId: string;
	agentId?: string;
	callerAddress?: CallerAddress;
}
```

For root:

- `handleId` is `root`.
- `agentId` is `root` unless the session controller already has a better stable
  root event id.
- `callerAddress` may be omitted or set to root itself.

For subprocesses:

- `handleId` comes from `StartMessage.handle_id`.
- `agentId` comes from `StartMessage.agent_id`.
- `callerAddress` is derived from `StartMessage.caller` after validating that it
  includes exact handle/id.

### Handle Ownership

`AgentHandle` should retain exact owner identity:

```ts
interface AgentHandle {
	handleId: string;
	agentId: string;
	ownerHandleId: string;
	ownerAgentId: string;
	ownerAgentName: string;
	// existing fields...
}
```

Rules:

- Non-shared `wait_agent` and raw-handle `message_agent` are allowed only when
  both `caller.handle_id === handle.ownerHandleId` and
  `caller.agent_id === handle.ownerAgentId`.
- Shared handles remain addressable by ordinary non-observer agents as they are
  today.
- Observer agents are narrower: they may not use raw handles at all in V3,
  including shared handles. Their only public comment target is `caller`.
- Name/depth-only ownership checks are removed.
- Completed handle resume preserves owner handle/id when that data is available.
- Older resumed handles that lack owner handle/id may use a clearly marked
  migration compatibility path, but new handles must use exact ownership.

Required tests:

- Two live instances of the same agent spec cannot wait/message each other's
  non-shared handles by name alone.
- The owning runtime handle can wait/message its own non-shared child.
- Shared handles remain accessible.
- Observer attempts to message arbitrary raw shared handles fail clearly.
- Resume preserves exact owner identity for completed child handles.

## Caller Alias

### Semantics

`message_agent(handle: "caller")` sends an agent-originated message to the
current agent's runtime caller.

This is a built-in address alias, not an observer grant.

The caller address is derived from trusted runtime state:

- Root's observer caller address is root.
- A delegate's caller address is the parent handle that spawned it.
- An observer's caller address is the owner handle that the runtime used when
  starting the observer.

### Delivery

For `handle: "caller"`:

- `blocking: false` is required in V3.
- The runtime publishes an `AgentMessageMessage` to the caller handle's inbox.
- It does not require the caller handle to be present in the sender's local
  `AgentSpawner.handles` map.
- It does not resume completed caller handles in V3.
- If the caller cannot receive messages, emit a warning and return a tool error.

This direct external-caller delivery is intentionally narrower than general
cross-handle messaging.

### Root Addressing

Observer prompts should use `handle: "caller"`, not `handle: "root"`.

Raw `handle: "root"` is not a valid model-originated `message_agent` target in
V3 for non-root agents. Root delivery must happen either through:

- `handle: "caller"` when the runtime caller address is root; or
- an internal runtime/session-controller path that is not available as a model
  tool argument.

Migration order matters: add the `caller` alias and update root observer prompts
before rejecting raw root tool calls. If a short-lived compatibility path is
needed, it must be restricted to runtime-verified root-owned observer handles and
must not apply to arbitrary non-root agents.

Required tests:

- A root-owned observer can message `caller`, and root receives the message.
- A non-root delegate observer can message `caller`, and the owning non-root
  agent receives the message.
- A non-root agent using raw `handle: "root"` does not reach root through a
  bypass.
- A non-root observer using any raw handle other than `caller` fails clearly.
- `caller` with `blocking: true` fails clearly.
- `caller` alias cannot be spoofed through model-supplied arguments.

## Observer Configuration

### Root/Session Observers

Root/session observers continue to use static config on the owning agent:

```yaml
observers:
  - agent: metacognitive
    target: root
    events: [plan_end, warning, error, primitive_end, act_end, compaction, interrupted]
    trigger:
      every: 3
      event: plan_end
    delivery:
      max_events: 24
      max_chars: 6000
```

Rules:

- `target: root` observes root-depth events.
- `target: session` observes the session-wide event stream.
- The observer's output channel is implicitly `caller`.
- Do not add `comments` to new V3 examples.
- Existing `comments.can_message` and `comments.default_recipient` are legacy
  parser-only migration fields in V3.
- Runtime frame rendering must not use legacy `comments` to produce recipient
  instructions.
- New configs should omit `comments`; configs with any non-caller recipient are
  rejected.

### Delegate Observers

Any agent spec may define delegate-final observers:

```yaml
observe_delegates:
  - agent: evidence-contradiction-observer
    trigger: on_delegate_final
    events: [plan_end, warning, error, act_end, primitive_end]
    delivery:
      max_events: 12
      max_chars: 4000
```

Rules:

- The observer watches only blocking delegates spawned by that owner handle.
- Handle-only nonblocking handoffs are excluded.
- The observer is long-lived for that owner handle and reused across delegate
  completions.
- The observer receives frames over time and may message only `caller`.
- The owner receives advisory comments before its next planning/final response
  when delivery completes within the bounded timeout.

### Observer Agent Frontmatter

Observers are normal agents. Recommended frontmatter:

```yaml
name: metacognitive
model: observer.metacognitive
tools:
  - message_agent
agents: []
constraints:
  max_turns: 2
  can_spawn: false
  can_learn: false
  timeout_ms: 60000
tags:
  - observer
  - diagnostics
```

Prompt requirements:

- State that the agent is an observer, not a worker.
- Instruct it to use `message_agent` with `handle: "caller"` and
  `blocking: false` for comments.
- Instruct it to return `MESSAGE_SENT` after messaging.
- Instruct it to return `NO_MESSAGE` when no intervention is warranted.
- Require quoted visible evidence for non-obvious claims.
- Prohibit hidden prompt/policy claims unless the relevant text appears in the
  frame.
- Prohibit memory writes and memory-write suggestions.

## Runtime Architecture

### Observer Frame Delivery

Observer frames are runtime input, not advisory agent messages.

Do not deliver observer frames through public `message_agent` semantics. Public
`message_agent` sends `AgentMessageMessage` to running agents and can render in
`<sprout:agent-messages>`, which is the wrong surface for observer frames.

Add a runtime-only delivery path, e.g.:

```ts
interface ObserverFrameDeliveryOptions {
	handleId: string;
	frame: string;
	timeoutMs?: number;
	waitForTurn: boolean;
}
```

Required semantics:

- The frame enters the observer as the next task/follow-up input, not as
  `<sprout:agent-messages>`.
- The delivery path may start, resume, or continue the persistent observer
  handle.
- For root/session observers, delivery may be fire-and-forget after enqueueing
  the frame.
- For delegate-final observers, delivery must wait until the observer's turn
  completes or the timeout expires.
- "Delivery complete" means the observer processed the frame and returned a turn
  result. If the observer called `message_agent(handle: "caller")`, that message
  has been published to the caller inbox before completion returns.
- Timeout emits a warning and leaves observer advice advisory.

Required tests:

- Frames delivered to a running observer do not appear in that observer's
  `<sprout:agent-messages>`.
- Delegate-final delivery waits for observer turn completion before the owner
  continues.
- Timeout does not hang the owner.

### Root/Session Observer Registry

Keep `ObserverRegistry` for root/session observers.

Responsibilities:

- Own active root/session subscriptions.
- Consume the session-wide event stream.
- Maintain bounded rolling buffers per subscription.
- Start each observer as a private persistent long-lived handle on first
  delivery.
- Deliver later frames through runtime-only observer frame delivery.
- Emit normal `act_start` events with `observer: true`.
- Reset on `/clear`.
- Exclude observer telemetry unless explicitly configured otherwise.

Non-responsibilities:

- It does not own non-root delegate observer lifecycles.
- It does not run LLM calls directly outside normal agent processes.
- It does not parse arbitrary observer output.
- It does not write memory.
- It does not enforce that the target obeys a comment.
- It does not expose model-owned subscribe/unsubscribe tools.

### Owner-Local Delegate Observer Runtime

Delegate observers are cleaner when attached at the owner process, because the
owner already has the decisive context at delegation time:

- owner handle/id/name/depth;
- delegation goal, hints, description;
- child handle/id;
- blocking vs nonblocking mode;
- child result;
- current turn timing before the owner builds its next prompt.

Add a small owner-local delegate observer runtime inside the bus-backed
delegation path.

Responsibilities:

- Load `observe_delegates` from the owner's resolved agent spec.
- Start one private persistent observer handle per owner/config pair when the
  first blocking delegate completion needs observation.
- Reuse that observer handle for later delegate-final frames from the same
  owner.
- Feed only bounded delegate-final frames.
- Await delivery with a small timeout before the owner continues.
- Emit warnings on timeout or delivery failure and continue.
- Use the same frame builder/redaction helpers as root/session observers.
- Capture bounded child events for the blocking delegate before invoking the
  observer.

Non-responsibilities:

- It does not attach global subscriptions.
- It does not inspect unrelated session events.
- It does not observe delegate subtrees.
- It does not deliver every child event live.
- It does not create a grant store.

Child event capture:

- Start capture when the owner emits the delegate `act_start`.
- Capture child-process events where `event.agent_id === childId`.
- Capture owner-side delegation events whose `data.child_id === childId`.
- Stop capture after the blocking delegate result and owner `act_end` are known.
- Bound captured events by `max_events` and `max_chars`.
- Do not depend on a global non-root registry to reconstruct child evidence.

Suggested handle shape:

```text
observer-delegate-{ownerAgentId}-{configIndex}-{observerAgentName}
```

The handle must include enough owner identity to avoid collisions between two
instances of the same agent spec.

### Delegate-Final Frames

Delegate-final frames must include enough context for the observer to notice
contradictions without seeing the owner's hidden prompt.

Required frame sections:

1. Observer instructions:
   - use `message_agent(handle: "caller", blocking: false)` for comments;
   - return `MESSAGE_SENT` after messaging;
   - return `NO_MESSAGE` if no comment is warranted.
2. Caller/delegation context:
   - owner agent name and handle id;
   - delegation goal;
   - delegation hints/description if present;
   - bounded visible caller plan text if available.
3. Child terminal result:
   - child agent name;
   - child handle/id;
   - success/stumbles/turns/timed_out;
   - bounded child output.
4. Child evidence:
   - final child `plan_end.text` if available;
   - warnings/errors;
   - failed primitive outputs;
   - relevant `act_end` summaries.

Truncation priority:

1. Always keep observer instructions.
2. Always keep delegation goal.
3. Always keep child terminal result.
4. Keep caller visible plan text before lower-priority child evidence.
5. Keep warnings/errors before successful primitive output.
6. Drop oldest/lower-priority child evidence first.

Required tests:

- Frame includes delegation goal, child output, and child evidence.
- Per-child event capture includes child-process events and owner-side
  delegation events for the correct child id.
- Interleaved delegates do not borrow each other's child evidence.
- Frame truncates lower-priority evidence before core sections.
- Frame excludes observer telemetry by default.

### Delivery Timing

Delegate-final observations are useful only if advice usually arrives before the
owner moves on.

Required behavior:

- After a blocking delegate returns, before the owner builds the next planning
  request or finalizes, the owner waits for delegate observer delivery.
- The wait is bounded. Suggested default: 1500 ms.
- If the observer times out or fails, emit a warning and continue.
- Advice remains advisory; the runtime must not block indefinitely.
- Nonblocking handle-only delegates do not trigger delegate-final observers.

Required tests:

- Observer comment can appear in the owner's next prompt after a blocking
  delegate.
- Timeout emits a warning and does not hang the owner.
- Nonblocking delegate handoff does not trigger a delegate-final observer.

## Agent Message Semantics

Agent messages remain advisory runtime guidance.

Prompt rendering:

```xml
<sprout:agent-messages>
<message from="metacognitive" role="observer">
The delegate result contradicts your stated plan. You expected ALPHA but the
child returned BETA.
</message>
</sprout:agent-messages>
```

Rules:

- Agent messages are runtime guidance, not user messages.
- They do not override user instructions or higher-priority system constraints.
- The receiving agent should take them seriously when they identify drift,
  contradiction, repeated failure, or missing context.
- If the receiving agent rejects observer advice, it should briefly account for
  why in visible plan text when that is useful to the task.
- Messages render once and are then cleared.
- Messages are not appended to normal conversation history.

Event data should include enough metadata for tests and UI:

```ts
interface AgentMessageEventData {
	from_agent_name: string;
	from_depth: number;
	from_role?: "observer";
	from_handle_id?: string;
	from_agent_id?: string;
	to_agent_name: string;
	to_handle_id?: string;
	to_agent_id?: string;
	text_preview: string;
}
```

Required tests:

- Observer messages render with role metadata.
- Message prompt context clears after one render.
- Agent messages are not conversation history.
- Root and non-root observer deliveries are distinguishable by event metadata.

## UI Requirements

V3 should make observers visible without adding a parallel observer tree.

Required UI behavior:

- Observer agents appear as normal child threads with `observer: true` styling.
- Main thread shows compact `agent_message` events.
- A selected observer thread shows received frames and `message_agent` calls.
- Delegate observers appear under the owning agent/delegation context, not in a
  separate global pane.
- Raw observer frames are collapsed by default.
- UI must not infer observer status from names or prefixes.

Tree data:

```ts
interface AgentTreeNode {
	// existing fields...
	isObserver?: boolean;
	ownerHandleId?: string;
	ownerAgentId?: string;
	observedTarget?: "root" | "session" | "caller_delegates";
}
```

`buildAgentTree` must preserve these fields from observer `act_start` data.

Useful event metadata on observer `act_start`:

```ts
{
	observer: true,
	agent_name: "metacognitive",
	child_id: "observer-delegate-...",
	handle_id: "observer-delegate-...",
	description: "observes caller delegate completions",
	owner_handle_id: "01...",
	owner_agent_id: "01...",
	observed_target: "caller_delegates"
}
```

YAGNI:

- No human notifications/toasts.
- No severity badges.
- No notification inbox.

## Memory Boundaries

Observer telemetry is process guidance, not durable memory evidence.

Exclude by default:

- observer lifecycle events;
- observer frames;
- observer `agent_message` events;
- observer child logs when building collapse transcripts;
- observer events when collecting extraction evidence.

Implementation rule:

- Exclusion should use registered/observed observer handle ids and agent ids,
  not only `event.data.observer === true`.
- Normal non-observer delegate evidence must remain available for collapse and
  extraction.

Required tests:

- Root observer telemetry is excluded from collapse and extraction.
- Non-root delegate observer telemetry is excluded from collapse and extraction.
- Observer telemetry is excluded even when the `observer: true` lifecycle marker
  is absent from, or outside, the collapse/extraction event window.
- Normal delegate output remains learn/collapse evidence.

## Model Configuration

V3 keeps the existing observer model purpose:

```ts
type AgentModelPurpose = "observer.metacognitive";
```

Rules:

- Missing `observer.metacognitive` configuration fails loudly.
- `SPROUT_OBSERVER_METACOGNITIVE_MODEL` remains the only observer env override.
- Do not add new observer model purposes in V3.
- Add a new purpose only after a committed observer demonstrates a real model
  requirement that the shared observer purpose cannot satisfy.

## Validation

### Deterministic Tests

Recommended files:

- `test/host/observer-registry.test.ts`
- `test/host/session-controller.test.ts`
- `test/agents/steering.test.ts`
- `test/bus/spawner.test.ts`
- `test/bus/agent-process.test.ts`
- `test/core/session-collapse.test.ts`
- `test/learn/extraction-evidence.test.ts`
- `web/src/hooks/useAgentTree.test.ts`

Required cases:

- Runtime caller identity includes exact handle/id.
- Non-shared handle checks require exact owner handle id and owner agent id.
- `message_agent(handle: "caller", blocking: false)` reaches root for a
  root-owned observer.
- `message_agent(handle: "caller", blocking: false)` reaches a non-root owner
  for a delegate observer.
- `caller` with `blocking: true` fails clearly.
- A non-root agent cannot reach root through raw `handle: "root"`.
- An observer cannot message arbitrary raw handles, including shared handles.
- Observer frame delivery does not use `<sprout:agent-messages>` in the observer.
- Delegate-final observer delivery waits for observer turn completion or timeout.
- Per-child event capture feeds the correct child evidence to delegate-final
  frames.
- Two root/session subscriptions can be active without handle collisions.
- Multiple observers can inject messages in the same root turn.
- Target prompt receives queued observer messages once, then clears them.
- Nonblocking delegate handoff does not trigger delegate-final observers.
- Observer delivery failure for one subscription does not block unrelated
  subscriptions.
- Delegate-final frames include the correct child final output for interleaved
  delegates.
- Observer telemetry is excluded from collapse and extraction.

### Live Harness

Add an opt-in harness:

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

- `caller-alias-root`: root-owned observer messages `caller`; root receives it.
- `caller-alias-non-root`: non-root delegate observer messages `caller`; the
  non-root owner receives it and root does not.
- `multi-observer-smoke`: distinct observers start, receive frames, emit
  role-tagged `agent_message` events, and render into prompt context.
- `nonblocking-negative`: handle-only nonblocking delegate handoff does not
  trigger delegate-final observers.

Behavioral assertions:

- Target obedience is diagnostic unless the test prompt uses exact markers.
- A target ignoring advisory guidance is not itself a delivery failure.
- Adversarial-obedience and pilot-specific live scenarios are deferred until
  those pilots are enabled.

## Optional Pilot Observers

V3 core is complete without new specialized observers.

If pilot observers are still desired in the same implementation run, they must
be prompt/config-only consumers of the V3 substrate. They must not add runtime
features, model purposes, recipient policies, or grant machinery.

Allowed pilots:

- `evidence-contradiction-observer`: watches delegate-final frames for concrete
  contradiction between caller-visible expectation and child output.
- `pm-observer`: root-owned session observer that comments only on concrete
  coordination risks visible in the frame.

Pilot rules:

- Both use `model: observer.metacognitive`.
- Both use `message_agent(handle: "caller", blocking: false)`.
- Both return `MESSAGE_SENT` after messaging and `NO_MESSAGE` otherwise.
- Both quote visible evidence.
- Both are opt-in through static config.
- Both must pass exact-marker deterministic/live tests before being enabled
  anywhere by default.

Defer all broader catalog ideas:

- failure-loop observer;
- instruction-drift observer;
- context-pressure observer;
- human-facing PM notification observer;
- dedicated observer model purposes.

## Implementation Sequence

1. Add runtime `handle_id` and `agent_id` to `CallerIdentity`.
2. Add `callerAddress` separately from self/sender identity.
3. Store exact owner handle/id and owner agent id on `AgentHandle`.
4. Split private persistent observer handles from shared public handles.
5. Harden `wait_agent` and raw-handle `message_agent` ownership checks.
6. Add `message_agent(handle: "caller", blocking: false)` alias resolution.
7. Migrate metacognitive prompt/docs to `handle: "caller"`.
8. Reject raw `handle: "root"` for model-originated non-root messages.
9. Add runtime-only observer frame delivery with wait-for-turn semantics.
10. Keep root/session observers in `ObserverRegistry`; remove grant-store and
    recipient-policy assumptions.
11. Add owner-local long-lived delegate observer runtime and per-child event
    capture.
12. Add bounded delegate-final observer delivery before owner continuation.
13. Add event/UI metadata for observer owner and agent-message routing.
14. Harden memory/collapse/extraction observer exclusion by handle/id.
15. Add deterministic tests.
16. Add opt-in live harness with the narrowed caller-alias smoke scenarios.
17. Add optional pilot observers only if the core substrate is passing.

## Completion Criteria

V3 is complete when:

- Observer agents remain ordinary, long-lived, visible Sprout agents.
- Root/session observers receive bounded frames over time.
- Non-root delegate observers receive bounded delegate-final frames over time.
- Observers use `message_agent(handle: "caller", blocking: false)` for comments.
- No observer-specific grant store exists.
- Observer handles are private persistent handles, not public shared handles.
- Observer frames are delivered through a runtime-only frame path, not public
  `message_agent`.
- Normal handle ownership uses exact runtime handle/id, not agent name.
- Raw `handle: "root"` is not a model-originated non-root side channel.
- Root-owned observer comments reach root.
- Non-root delegate observer comments reach the owning non-root handle and not
  root.
- Observer advice appears in `<sprout:agent-messages>` exactly once per
  delivered comment.
- UI can show observer threads and compact observer message events.
- Observer telemetry remains excluded from memory extraction and collapse.
- Deterministic tests and opt-in live validation pass.
