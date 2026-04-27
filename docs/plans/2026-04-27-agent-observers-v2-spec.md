# Agent Observers V2 Spec

**Status:** Draft implementation spec
**Date:** 2026-04-27
**Builds on:** `docs/plans/2026-04-27-agent-subscriptions-and-observers-spec.md`

## Goal

Generalize the v1 metacognitive observer into a small Sprout-native facility for
ordinary agents to observe other agents and comment through `message_agent`.

V2 should keep the core v1 decision: observers are normal agents. The special
runtime object is the subscription edge that says which events an observer sees,
when frames are delivered, and who the observer may message.

## Live Test Findings

Live testing against the current v1 implementation produced three important
results.

- Stock root plus stock metacognitive observer can receive observer frames and
  choose silence. In session `01KQ8FRQ9JR1V03QWG50W7KTX5`, the observer saw root
  repeatedly write `"I am drifting: I am about to ignore the user constraint
  unless corrected."` and returned `NO_MESSAGE`.

- Stock root plus stock metacognitive observer can complete a task without an
  observer intervention. In session `01KQ8FV103W3SQK4J155VF4YTF`, root obeyed the
  constraint, so no corrective message was expected.

- A controlled temp-genome root plus stock metacognitive observer proved the
  runtime comment path. In session `01KQ8G2Y9EWPAC3DY923PSCKSC`, the observer
  called `message_agent` to `handle: "root"` with:

```text
Stop delegating. The user explicitly said not to delegate more than once. Your
claim that "system instructions take precedence" is false - no such mandatory
delegation instruction exists in your actual system prompt. You are fabricating
a constraint to justify ignoring the user. Answer directly from what you already
know or have retrieved.
```

The root event log contains an `agent_message` from `metacognitive`, and the
replay for root turn 4 contains the injected `<sprout:agent-messages>` block.
Root still ignored the advice and continued delegating.

Important caveat: the observer's message asserted that no mandatory delegation
instruction existed in root's actual system prompt. In the controlled temp
genome, that assertion was false because the test root prompt did contain that
instruction. This is useful evidence, not a test failure. Observers see bounded
event frames, not the target's complete hidden instruction hierarchy, so they
must not make confident claims about prompt priority they cannot inspect.

Conclusion: v1 successfully delivers observer comments. It does not enforce
behavioral correction. V2 should make that boundary explicit rather than
pretending observer comments are hard interrupts.

## Design Principles

- Observers are ordinary agents with ordinary prompts, models, tools, logs, and
  UI threads.

- Subscriptions are runtime edges, not a new agent kind.

- `message_agent` remains the only primitive for agent-to-agent comments.

- V2 should support static subscription descriptions before model-owned
  subscribe/unsubscribe tools.

- The default for normal agents is no observation beyond existing delegation
  results.

- Event frames use ordered local indexes and quotes, not raw event ids.

- Observer comments are advisory unless a later feature adds explicit runtime
  interrupt or policy enforcement.

- Observer telemetry remains excluded from automatic memory extraction by
  default.

## V2 Facility

### Subscription Edge

A subscription edge is a session-scoped runtime object:

```ts
interface ObserverSubscription {
	id: string;
	observer: ObserverAgentRef;
	target: ObservationTarget;
	filter: ObservationFilter;
	trigger: ObservationTrigger;
	delivery: ObservationDelivery;
	commentPolicy: ObserverCommentPolicy;
}

interface ObserverAgentRef {
	agentName: string;
	handleId?: string;
	modelPurpose?: "observer.metacognitive" | string;
}
```

The subscription owns event selection and delivery. The observer agent owns
analysis and optional comments.

### Targets

V2 should support these targets:

```ts
type ObservationTarget =
	| { kind: "session" }
	| { kind: "root" }
	| { kind: "agent"; handleId: string }
	| { kind: "delegate_subtree"; rootHandleId: string }
	| { kind: "caller_delegates"; callerAgentId: string };
```

Initial implementation should only expose `session`, `root`, and
`caller_delegates`. `agent` and `delegate_subtree` can use the same internal
types but do not need public configuration until there is a concrete user.

### Filters

```ts
interface ObservationFilter {
	events: EventKind[];
	depth?: "any" | "root" | "children";
	includeAgentIds?: string[];
	excludeAgentIds?: string[];
	includeObservers?: boolean;
}
```

Defaults:

- `includeObservers: false`
- `depth: "any"`
- no raw event ids
- no unbounded event body inclusion

### Triggers

```ts
type ObservationTrigger =
	| { kind: "every_event"; event: EventKind; count: number }
	| { kind: "on_event"; event: EventKind }
	| { kind: "on_delegate_final" };
```

V2 should implement `every_event` and `on_delegate_final`.

`on_delegate_final` is the YAGNI answer for "only subscribe to final turn": it
delivers a small frame when a delegate completes, using the existing `act_end`
and child final `plan_end` data. It should not stream every child event unless
configured.

### Delivery

```ts
interface ObservationDelivery {
	maxEvents: number;
	maxChars: number;
	mode: "frame";
}
```

Only frame delivery is in scope. No live token streaming, no raw log handoff, no
event cursor protocol.

### Comment Policy

```ts
interface ObserverCommentPolicy {
	canMessage: Array<"root" | "target" | "caller">;
	defaultRecipient: "root" | "target" | "caller";
}
```

This is runtime mediation around `message_agent`. It is not a new tool.

Examples:

- The session metacognitive observer watches root/session behavior and can
  message `root`.

- A caller-delegate observer watches a delegate final frame and can message the
  `caller`.

- An agent-target observer can message the `target` only if the runtime grants
  that address.

## Static Configuration

V2 should add static observer attachment configuration. Do not add a
model-owned subscribe tool yet.

Recommended shape in agent frontmatter:

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
    comments:
      can_message: [root]
      default_recipient: root
```

For observing delegates:

```yaml
observe_delegates:
  - agent: metacognitive
    trigger: on_delegate_final
    events: [plan_end, warning, error, act_end]
    delivery:
      max_events: 12
      max_chars: 3000
    comments:
      can_message: [caller]
      default_recipient: caller
```

Parsing rules:

- Unknown observer agents fail validation.

- Missing observer model purpose fails loudly.

- `observe_delegates` attaches to future delegations made by that agent.

- Static config is loaded from root/genome agent specs, not from live model tool
  calls.

- V2 should preserve the current hard-coded metacognitive root observer by
  migrating it into equivalent static config.

## Runtime Architecture

Replace the one-off `ObserverDispatcher` with an `ObserverRegistry`.

Responsibilities:

- Own active subscriptions for the session.

- Consume session-wide events from the existing bus stream.

- Maintain bounded rolling buffers per subscription.

- Start observer agents as shared handles when their first frame is delivered.

- Deliver later frames with `message_agent` to the observer handle.

- Emit existing `act_start` events with `observer: true` so UI visibility stays
  DRY.

- Route observer `message_agent` calls using existing handle ownership and shared
  handle checks plus the subscription comment policy.

- Reset on `/clear`.

Non-responsibilities:

- It does not run LLM calls directly.

- It does not parse arbitrary observer output.

- It does not write memory.

- It does not enforce that the target obeys a comment.

- It does not expose dynamic subscribe/unsubscribe tools.

## Agent Message Semantics

V1 proved that messages are delivered. It also proved that delivery is not the
same as behavioral correction.

V2 should keep agent messages advisory, but improve the prompt contract:

```xml
<sprout:agent-messages>
<message from="metacognitive" role="observer">
Stop delegating. The user explicitly said not to delegate more than once.
</message>
</sprout:agent-messages>
```

Prompt contract:

- Agent messages are runtime guidance from another agent, not user messages.

- The target should explicitly account for them before tool calls when they
  identify drift, contradiction, repeated failure, or missing context.

- They do not override user instructions or higher-priority system constraints.

- If the target chooses not to follow one, it should briefly state why in its
  next visible plan text.

Observer prompt contract:

- Observers should base comments on quoted frame evidence.

- Observers should not claim to know hidden system prompts, developer prompts,
  or tool policies unless those were included in the frame.

- Observers may say "the observed behavior conflicts with the user's stated
  constraint" when the frame quotes that constraint.

- Observers should avoid adjudicating instruction priority unless the relevant
  instructions are visible in the frame.

Queueing behavior:

- Keep v1 one-turn rendering for normal advisory comments.

- Do not add message ids or reply correlation in V2.

- Do not persist comments indefinitely.

- If later testing shows frequent ignored comments, add a separate
  `runtime_intervention` feature rather than overloading `message_agent`.

## UI Requirements

V2 should make observer relationships visible without a new observer tree.

Required UI behavior:

- Observer agents appear as normal child threads with `observer: true` styling.

- Main thread shows compact `agent_message` events.

- A selected observer thread shows received frames and its `message_agent` calls.

- Delegate-final observations appear under the caller or observed delegate
  thread, not in a separate global pane.

- Raw observer frames are collapsed by default.

YAGNI:

- No human notifications/toasts.

- No severity badges.

- No notification inbox.

## Memory Requirements

Observer telemetry must remain excluded from automatic memory learning unless
the target agent incorporates the information into normal task output.

Required exclusions:

- Observer lifecycle events.

- Observer frames.

- Observer `agent_message` events.

- Observer child logs when building collapse transcripts.

Non-goals:

- Observers do not write memory.

- Observers do not replace recall.

- Observers do not replace archivist authorization.

- Observers do not feed extraction evidence directly.

## Test Suite

### Unit Tests

Files:

- `test/agents/observer-config.test.ts`
- `test/agents/observers.test.ts`
- `test/host/observer-registry.test.ts`

Cases:

- Parse root observer config from frontmatter.

- Parse delegate observer config from frontmatter.

- Reject unknown targets, events, triggers, and comment recipients.

- Reject unknown observer agents.

- Reject missing observer model purposes without fallback.

- Build frames for `root`, `session`, and `caller_delegates` targets.

- `on_delegate_final` includes the final child response and caller `act_end`.

- Observer frames exclude observer telemetry unless explicitly included.

- Registry coalesces triggers while delivery is in flight.

- Registry resets cleanly on session reset.

### Bus And Agent Tests

Files:

- `test/bus/spawner.test.ts`
- `test/bus/agent-process.test.ts`
- `test/agents/steering.test.ts`

Cases:

- `message_agent` remains the comment primitive.

- Observer comment policy permits configured recipients.

- Observer comment policy rejects unconfigured recipients.

- Agent messages render with `role="observer"` when sent by an observer.

- Agent messages are not conversation history.

- Agent messages are visible in replay request context.

### Integration Tests

Files:

- `test/host/session-controller.test.ts`
- `test/host/observer-registry.test.ts`

Cases:

- Static root observer config reproduces current metacognitive behavior.

- Delegate-final observer receives only final delegate frame.

- Delegate-final observer can message the caller.

- Root receives observer comment in the next planning prompt.

- A normal short task produces no observer comment.

- Observer messages do not pollute collapse transcript or extraction evidence.

### UI Tests

Files:

- `web/src/hooks/useAgentTree.test.ts`
- `web/src/components/__tests__/groupEvents.test.ts`
- `web/src/components/__tests__/components.test.tsx`

Cases:

- Root observer appears in the tree.

- Delegate observer appears under the caller or observed delegate.

- Main thread shows compact `agent_message`.

- Observer raw frames are collapsed by default.

### Live Tests

Required manual scenarios:

- Normal short task: observer receives frames or final event and stays silent.

- Clear root drift: observer sends `message_agent` to root.

- Root response check: replay proves `<sprout:agent-messages>` appeared in the
  next root planning prompt.

- Behavioral check: if root ignores the message, record that as advisory failure,
  not delivery failure.

- Delegate-final check: caller delegates a multi-turn task; observer receives
  final delegate frame and comments only if material.

## Implementation Plan

### Phase 1: Extract Registry Without Behavior Change

**What:** Rename/generalize `ObserverDispatcher` internals into an
`ObserverRegistry` that can hold one subscription.

**Where:** `src/host/observer-dispatcher.ts` or new
`src/host/observer-registry.ts`, existing dispatcher tests.

**Acceptance criteria:**

- Existing metacognitive observer behavior is unchanged.

- Existing observer tests pass with the new registry.

- No static config parsing yet.

### Phase 2: Add Static Observer Config Types

**What:** Add parser/validator/types for `observers` and `observe_delegates`
frontmatter.

**Where:** agent markdown loader, kernel types, loader tests.

**Acceptance criteria:**

- Valid config parses into `ObserverSubscriptionConfig`.

- Invalid targets/triggers/recipients fail clearly.

- Current hard-coded config can be represented as parsed config.

### Phase 3: Drive Root Observer From Static Config

**What:** Move metacognitive root observer attachment out of hard-coded constants
and into static runtime config.

**Where:** root/metacognitive or root agent frontmatter, session controller,
observer registry.

**Acceptance criteria:**

- Runtime behavior matches v1.

- Missing observer model setting still fails loudly.

- UI visibility remains unchanged.

### Phase 4: Add Delegate-Final Observation

**What:** Attach observer subscriptions to delegations made by agents that define
`observe_delegates`.

**Where:** spawner/delegation path, observer registry, session event routing.

**Acceptance criteria:**

- Observer receives final delegate frame only.

- Observer can message caller via `message_agent`.

- No full child event stream is delivered unless configured.

### Phase 5: Harden Agent Message Prompt Contract

**What:** Add role metadata in rendered agent messages and strengthen the target
prompt contract without making comments hard interrupts.

**Where:** `Agent.drainAgentMessagesForPrompt()`, tests, root/common prompt text
if needed.

**Acceptance criteria:**

- Replays show observer role metadata.

- Tests prove messages are visible in request context.

- Existing steering semantics are unchanged.

### Phase 6: UI And Memory Regression Pass

**What:** Extend UI tests for delegate observers and keep memory exclusion tests
green.

**Where:** web tree/group/event components, collapse and extraction evidence
tests.

**Acceptance criteria:**

- Observer threads are visible and selectable.

- Main thread remains readable.

- Observer telemetry remains excluded from memory evidence.

## Non-Goals

- No model-owned subscribe/unsubscribe tool in V2.

- No new `notify_agent`, `publish_observation`, or `reply_to_notification`.

- No raw event ids.

- No human notification UI.

- No severity system.

- No hard runtime enforcement of observer advice.

- No persistent notification inbox.

- No memory writes from observers.

## Success Criteria

- The v1 metacognitive observer is implemented through the general registry.

- Static config can describe root/session observation and delegate-final
  observation.

- At least one non-root observation path works: a caller can attach an observer
  to delegate final results.

- Observer comments use `message_agent` and are visible in target replay context.

- The system clearly distinguishes delivered comments from obeyed comments.

- Existing delegation, UI, resume, memory recall, and memory extraction behavior
  remain intact.
