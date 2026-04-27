# Agent Subscriptions and Observer Agents Spec

**Status:** Implementation-ready design/spec
**Date:** 2026-04-27
**Related:** `docs/reference/mira-memory-architecture.md`,
`docs/plans/2026-04-25-mira-memory-port-design.md`

## Goal

Add a Sprout-native facility for agents to observe other agents' runtime events
and send agent-to-agent messages without treating those messages as user
steering. Use that facility to implement MIRA-style metacognitive observation
in a way that is fully visible to the human in the UI.

The design should make watchers ordinary Sprout agents with subscriptions, not
a new actor class. The special thing is the subscription relationship, not the
agent.

## Current Architecture

Relevant existing behavior:

- `delegate` creates subagent handles through `AgentSpawner`.
- `message_agent` sends follow-up messages to handles.
- Running-agent `message_agent` currently becomes a `SteerMessage`.
- `Agent.runLoop()` drains steering messages and injects them into history as
  user messages.
- Subprocess agents publish `EventMessage` to both per-handle and session-wide
  topics.
- `SessionController` relays session-wide child events into the in-process
  UI/event bus.
- The web UI builds its tree from `act_start` and `act_end` events and hides
  child-agent raw events from the main thread by default.

Useful anchors:

- `src/kernel/types.ts`: `Delegation`, `AgentCommand`, `SessionEvent`.
- `src/bus/types.ts`: `StartMessage`, `ContinueMessage`, `SteerMessage`,
  `EventMessage`.
- `src/bus/spawner.ts`: handle ownership, `shared`, `waitAgent`,
  `messageAgent`.
- `src/bus/agent-process.ts`: inbox handling and session-wide event publication.
- `src/agents/agent.ts`: `executeSpawnerDelegation()`,
  `executeAgentCommand()`, `steer()`, `runLoop()`.
- `src/host/session-controller.ts`: child event relay, history shadow,
  metadata updates, clear/resume handling.
- `web/src/hooks/useAgentTree.ts`: UI agent tree construction from delegation
  events.

## Design Principles

1. Watchers are normal agents.
2. Watching is an input source, not an actor kind.
3. Subscription lifecycle is runtime-owned, not model-owned.
4. `message_agent` remains the tool for agent-to-agent messages.
5. Agent-originated messages must not be injected as user steering.
6. Every watcher and notification must be visible in the UI.
7. Frames must be bounded, ordered, redacted, and referenceable.
8. Durable memory systems remain durable memory systems. Observers do not
   replace recall, extraction, indexing, or archivist authorization.
9. Model choice is configuration, not code. Observer and memory model purposes
   are stored in Sprout settings and may only be overridden by env vars.

## Core Concepts

### Agent Instance

An active runtime handle with:

- `handleId`
- `agentId`
- `agentName`
- `ownerId`
- `shared`
- status/result fields
- spawn metadata needed for resume

No global `kind` is required for v1.

### Delegation Edge

A relationship between a caller and callee:

```ts
interface DelegationEdge {
	handleId: string;
	callerAgentId: string;
	calleeAgentId: string;
	calleeAgentName: string;
	goal: string;
	description?: string;
}
```

The edge is already implicit in `act_start`/`act_end`, handle metadata, and the
UI tree. The subscription facility should make this relationship explicit in
runtime bookkeeping, but it does not need to be persisted as a new durable
record in v1.

### Subscription

A runtime rule that turns selected events into bounded message frames for an
agent.

```ts
type SubscriptionSource =
	| { scope: "session" }
	| { scope: "agent"; agentId: string }
	| { scope: "delegation"; handleId: string; side: "caller" | "callee" };

interface AgentSubscription {
	source: SubscriptionSource;
	events: SessionEventKindSelector[];
	delivery: "frame";
	trigger: "immediate" | { every: number; event: EventKind };
	maxEvents?: number;
	maxChars?: number;
	include?: "final" | "summary" | "full";
}
```

V1 should support only:

- `source.scope = "session"` for the root metacognitive watcher.
- `source.scope = "agent"` for a specific target agent id if easy.
- `delivery = "frame"`.
- `include = "summary" | "final"`.

Do not implement model-owned subscribe/unsubscribe tools in v1.

### Subscription Frame

A bounded, redacted, model-readable summary of events.

```ts
interface SubscriptionFrame {
	frameId: string;
	sessionId: string;
	subscriptionName: string;
	source: SubscriptionSource;
	createdAt: string;
	events: SubscriptionFrameEvent[];
	truncated: boolean;
}

interface SubscriptionFrameEvent {
	eventId: string;
	kind: EventKind;
	timestamp: number;
	agentId: string;
	depth: number;
	summary: string;
	references?: Reference[];
}
```

Frames are delivered as normal inbound messages to the subscribed agent, but
rendered in a structured prompt block. They are not user messages.

### Reference

Use `references`, not `evidence`.

```ts
type Reference =
	| { type: "event"; id: string }
	| { type: "agent"; id: string }
	| { type: "handle"; id: string }
	| { type: "memory"; id: string }
	| { type: "segment"; id: string };
```

V1 only needs `{ type: "event", id }`.

### Agent Message

A typed message from one agent to another, sent by the existing `message_agent`
tool and surfaced as agent-originated context.

```ts
interface AgentMessage {
	messageId: string;
	from: {
		agentId: string;
		agentName: string;
		handleId?: string;
	};
	to: {
		agentId: string;
		handleId?: string;
	};
	text: string;
	references: Reference[];
	createdAt: string;
	expiresAfterTurns?: number;
}
```

This is not a new public tool. It is the internal payload shape behind
`message_agent` when the caller is another agent.

## Facility Architecture

The facility has four small runtime pieces:

1. **Subscription registry.**
   Builds active subscription records from loaded agent specs and runtime
   session configuration. It owns no model logic and makes no LLM calls.

2. **Subscription dispatcher.**
   Consumes the session-wide event stream, maintains per-subscription buffers,
   applies trigger rules, and delivers frames. It is session-scoped and resets
   on `/clear`.

3. **Subscription frame builder.**
   A pure formatter for bounded event frames. This should be reusable by memory
   collapse and learn evidence code, but behavior-preserving refactors should
   happen after the observer path works.

4. **Agent-message inbox.**
   A typed inbound queue on each running agent. Agent-originated guidance is
   rendered in a prompt surface, not appended to user history.

Data flow:

```text
SessionEvent -> SubscriptionDispatcher -> SubscriptionFrameBuilder
  -> observer handle inbox -> observer LLM/tool call
  -> message_agent -> target AgentMessage queue -> target prompt surface
```

There is intentionally no separate `notify_agent`, `publish_observation`, or
`reply_to_notification`. The runtime mediation is in the message payload and
prompt surface, not in a second tool family.

## Protocol Changes

### 1. Add Stable Event IDs

Extend `SessionEvent`:

```ts
interface SessionEvent {
	event_id: string;
	kind: EventKind;
	timestamp: number;
	agent_id: string;
	depth: number;
	data: Record<string, unknown>;
}
```

Both `AgentEventEmitter` and `EventBus` should assign event ids at emission.
Replayed old logs without `event_id` can synthesize deterministic ephemeral ids
while loading, but new logs must persist real ids.

Also add an `agent_message` event kind for UI visibility when a typed agent
message is delivered.

Rationale: subscriptions, references, UI deep links, and observer messages need
stable anchors.

### 2. Extend `message_agent`

Keep the tool name and core shape. Add optional references.

```ts
message_agent({
	handle: string,
	message: string,
	blocking?: boolean,
	references?: Reference[]
})
```

Runtime behavior:

- If the target is completed or idle and `blocking !== false`, existing
  continue-and-wait behavior can remain.
- If the target is running and the caller is an agent, do not convert this into
  user steering. Queue it as an agent message.
- If the target is running and the caller is the human/frontend, existing
  steering semantics remain.
- If `blocking: false`, return an ack after queueing the message.

The important boundary is source identity. A human steer is not the same thing
as an agent message.

Tool availability change:

- `delegate` and `wait_agent` remain tied to `constraints.can_spawn` and a
  non-empty delegatable agent list.
- `message_agent` should be available when an agent explicitly lists
  `message_agent` in `tools` and a spawner/message registry exists, even when
  `constraints.can_spawn: false`.
- This does not grant delegation rights. It only permits messages to handles the
  runtime already allows the caller to address.
- The zero-tool safety check must treat explicit `message_agent` access as a
  real tool so observer agents do not need fake primitives.

Addressability rules:

- Existing shared-handle restrictions remain.
- The root session must be addressable through the same handle registry, either
  as a synthetic root handle or an equivalent canonical alias.
- Observer handles are normal handles. Other agents can message them only if the
  handle is shared or if an explicit runtime policy grants that address.
- Replies are just `message_agent` calls back to an addressable handle. Do not
  add a special reply primitive or notification thread type.

### 3. Add Agent Message Prompt Surface

`Agent` should maintain an inbound agent-message queue separate from
`steeringQueue`.

Before each planning turn, render queued messages into the system prompt:

```xml
<sprout:agent-messages>
<message from="metacognitive" references="evt_...">
You may be drifting away from the architectural question. Answer the design
question before proposing implementation steps.
</message>
</sprout:agent-messages>
```

Then clear or age the queue according to `expiresAfterTurns`.

Do not add these messages to conversation history. They are system-owned
briefing notes, similar to MIRA's HUD guidance.

When a message is queued, emit:

```ts
emit("agent_message", targetAgentId, targetDepth, {
	from_agent_id: "...",
	from_agent_name: "metacognitive",
	to_agent_id: "...",
	to_handle_id: "...",
	text_preview: "...",
	references: [{ type: "event", id: "evt_..." }]
});
```

The UI can render this as an observable runtime event without displaying raw
observer frames in the main user thread.

### 4. Add Subscription Descriptors to Agent Specs

Extend `AgentSpec`:

```ts
interface AgentSpec {
	// existing fields...
	subscriptions?: AgentSubscription[];
}
```

Markdown frontmatter example:

```yaml
subscriptions:
  - name: root-turns
    source:
      scope: session
    events:
      - plan_end
      - warning
      - error
      - primitive_end
      - act_end
    trigger:
      every: 3
      event: plan_end
    include: summary
    max_events: 24
    max_chars: 6000
```

Default: no subscriptions.

### 5. Add Internal Model Purposes

The metacognitive observer needs its own configurable model purpose. This is
not the same as the memory models, but it should use the same settings pattern.

Extend settings with internal agent model purposes:

```ts
type InternalAgentModelPurpose = "observer.metacognitive";

interface SproutSettings {
	// existing fields...
	internalAgentModels: Partial<Record<InternalAgentModelPurpose, ModelRef>>;
}
```

Add env override support:

```text
SPROUT_OBSERVER_METACOGNITIVE_MODEL=provider:model
```

Resolution rules:

- Agent frontmatter may use `model: observer.metacognitive` only after
  `parseAgentModelInput()` and `resolveModel()` understand internal purposes.
- The setting must contain an exact provider-qualified model.
- If the setting is missing, fail loudly when starting the observer. Do not
  silently fall back to `fast`, `balanced`, or global defaults.
- The web settings UI should expose this beside memory model purposes, with the
  same provider/model selector and env-override annotation pattern.
- If implementation wants a bootstrap-safe default for development, write it
  into generated/default settings explicitly rather than hard-coding resolver
  fallback behavior.

### 6. Add Runtime Subscription Dispatcher

Create `src/agents/subscriptions.ts` or `src/host/subscriptions.ts`.

Responsibilities:

- consume `SessionEvent`s from the existing bus stream
- assign events to active subscriptions
- coalesce triggers
- construct bounded frames
- send frames to subscriber handles through the existing inbox/message path
- reset on `/clear`
- stop on session shutdown

It should not:

- run LLM calls directly
- write memory
- own model selection
- parse arbitrary model outputs
- subscribe/unsubscribe based on model tool calls

### 7. Make Runtime-Started Watchers Visible

Runtime-started watcher agents should emit normal lifecycle events so the UI can
show them.

Options:

1. Emit `act_start` from the caller/root when a watcher is attached.
2. Add explicit `watch_start`/`watch_end` events.

YAGNI preference: emit `act_start`/`act_end` with an `observer: true` data flag
and a clear description. The UI can then show them using the existing agent tree
and delegation block machinery, with styling refined later.

Example:

```ts
emit("act_start", "root", 0, {
	agent_name: "metacognitive",
	child_id: observerAgentId,
	handle_id: observerHandleId,
	description: "observes root turns",
	observer: true
});
```

This avoids a parallel observer tree.

## Metacognitive Observer

### Agent Spec

File: `root/agents/metacognitive.md` or `root/agents/utility/agents/metacognitive.md`.

Recommendation: top-level `root/agents/metacognitive.md` if it is a first-class
runtime companion to root. Do not add it to root's normal `agents` list unless
the runtime needs it discoverable through the existing agent tree.

Draft frontmatter:

```yaml
name: metacognitive
description: "Observe Sprout's live session behavior and send concise guidance when it is drifting, stuck, or missing an important instruction"
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
version: 1
subscriptions:
  - name: root-metacognition
    source:
      scope: session
    events:
      - plan_end
      - warning
      - error
      - primitive_end
      - act_end
      - compaction
      - interrupted
    trigger:
      every: 3
      event: plan_end
    include: summary
    max_events: 24
    max_chars: 6000
```

### Prompt

The prompt should say:

- You are an observer, not a worker.
- Do not perform the user's task.
- Do not ask for more work.
- Do not write memory.
- Only message the root when guidance is likely to change the next turn.
- Prefer silence over noise.
- Be concrete and refer to event references when useful.
- Good reasons to message:
  - the root is answering a different question than the user asked
  - repeated tool failures indicate a wrong approach
  - the root is about to implement without resolving design constraints
  - the root is ignoring explicit user constraints
  - context pressure suggests compaction or summarization
  - a delegation result contradicts the root's plan
- Bad reasons to message:
  - style preferences
  - restating obvious progress
  - summarizing every turn
  - suggesting memory writes

The metacognitive observer should receive no surfaced memory block by default.
It is evaluating live process, not answering domain questions.

### Output Behavior

The observer uses `message_agent`:

```json
{
  "handle": "<root-handle>",
  "message": "You are drifting into implementation before answering the user's architectural question. First explain the clean relationship between subscriptions, watchers, and message_agent.",
  "blocking": false,
  "references": [{ "type": "event", "id": "evt_..." }]
}
```

No severity. No human target. No separate `notify_agent`.

## Relationship to MIRA Memory

The memory system should treat subscriptions as shared event plumbing, not as a
replacement for memory semantics.

### What This Can Replace or Simplify

1. **Duplicated event-window plumbing.**
   Collapse transcripts, learn evidence windows, and bus learn buffers all build
   slices of the same session event stream. A shared `SubscriptionFrameBuilder`
   can become the common formatter.

2. **Live diagnostics.**
   `qm-session-analyst`, `qm-session-doctor`, and `qm-sprout-architect` stay as
   on-demand diagnostic agents, but the metacognitive observer becomes the live
   version for immediate process guidance.

3. **Memory mention tracking location.**
   Memory mention tracking can move from `Agent.trackMemoryMentions()` to a
   subscriber over `plan_end` events. This is cleaner because mention tracking
   is event-derived bookkeeping, not agent reasoning.

4. **MIRA HUD/trinket substrate.**
   Agent-message prompt surfaces plus subscription-fed state are Sprout's
   equivalent of MIRA's notification center. The implementation should not copy
   MIRA's trinket classes, but it should preserve the same separation:
   event-aware state feeds prompt briefing sections.

### Memory Integration Design

The correct integration is a common event-frame substrate under the existing
memory pipeline:

```text
SessionEvent stream
  -> SubscriptionFrameBuilder
     -> observer frames for live sidecar agents
     -> collapse transcript formatting
     -> learn extraction evidence windows
     -> memory mention bookkeeping
```

This is a formatter and selection refactor, not a semantic rewrite. The
following behavior must remain identical unless a later memory-specific spec
changes it:

- JSONL memory logs remain the durable source of truth.
- SQLite/FTS/vector state remains derived and rebuildable.
- Local embeddings remain the default embedding provider.
- Missing embedding/model configuration fails loudly. No fallback embeddings,
  empty vectors, or silent provider substitution.
- Deterministic recall remains the hot path.
- Subcortical recall remains an optional root-query expansion step.
- Session collapse remains the only automatic memory creation path for ordinary
  conversation.
- Archivist remains the explicit targeted investigation and authorized mutation
  path.
- Relationship classification, consolidation, entity GC, project clocks, and
  compaction remain durable maintenance jobs.

Observer frames and observer messages are process guidance. They should be
excluded from automatic memory extraction by default. If an observer catches a
durable fact, the root agent must incorporate that fact into its normal answer
or action before collapse can learn it.

Implementation order:

1. Build the observer facility without changing memory behavior.
2. Add tests proving observer events do not pollute collapse or extraction.
3. Refactor collapse/evidence/mention tracking onto shared frame formatting in
   small behavior-preserving commits.
4. Compare old and new transcript/evidence output on representative sessions
   before deleting the duplicated code paths.

### What This Must Not Replace

1. **Durable memory storage and indexing.**
   JSONL remains the source of truth. SQLite/FTS/vector cache remains derived
   and rebuildable.

2. **Recall and subcortical recall.**
   Watchers observe runtime behavior. They do not decide the long-term memory
   working set. Deterministic recall remains the hot path, optionally preceded
   by subcortical query expansion.

3. **Session collapse and extraction.**
   Subscriptions can provide shared frame formatting, but summary, extraction,
   deduplication, project tagging, embeddings, and persistence remain memory
   system responsibilities.

4. **Archivist.**
   Archivist remains the targeted memory investigation and authorized mutation
   specialist. Observers should not mutate memory.

5. **Relationship classification, consolidation, entity GC, project clocks, and
   memory-log compaction.**
   These are durable memory maintenance systems. Subscription frames can feed
   evidence into them, but they do not replace the maintenance logic.

6. **Surfaced memory fan-out.**
   The cached root memory surface should continue to fan out to delegates.
   Observers do not replace passive recall context.

## Test Suite Design

### Unit Tests: Event IDs

Files:

- `test/agents/events.test.ts`
- `test/host/event-bus.test.ts`
- `test/kernel/event-replay.test.ts`

Cases:

- emitted events include stable `event_id`
- `event_id`s are unique across rapid emissions
- persisted JSONL contains `event_id`
- replayed old events without `event_id` get deterministic synthetic ids or are
  safely normalized

### Unit Tests: Subscription Frame Builder

File: `test/agents/subscriptions.test.ts`

Cases:

- filters by event kind
- filters by agent id
- preserves timestamp order
- applies `max_events`
- applies `max_chars`
- redacts sensitive content using existing redaction helpers
- includes event references
- marks `truncated: true` when limits apply
- summarizes `primitive_end`, `act_end`, `plan_end`, `warning`, `error`

### Unit Tests: Agent Spec Parsing

Files:

- `test/agents/loader.test.ts`
- `test/agents/markdown-loader.test.ts`
- `test/agents/model-resolver.test.ts`

Cases:

- subscriptions parse from frontmatter
- unknown subscription keys fail loudly
- invalid event kind fails loudly
- missing source defaults are rejected unless an explicit default is chosen
- serialization round-trips subscriptions
- `model: observer.metacognitive` parses only as an internal model purpose
- observer model purpose resolution fails loudly when settings are missing
- observer model purpose resolution uses `internalAgentModels`, not global tiers

### Unit Tests: Agent Messages

Files:

- `test/agents/agent.test.ts`
- `test/bus/spawner.test.ts`
- `test/bus/agent-process.test.ts`

Cases:

- `message_agent` to a running agent queues an agent message, not steering
- human frontend steer still queues steering as user-like input
- agent messages render into `<sprout:agent-messages>`
- agent messages do not enter `history`
- agent messages expire after their TTL
- agent messages include `from` and `references`
- `message_agent` can be granted to `can_spawn: false` agents by listing it in
  `tools`
- `message_agent` access does not grant `delegate` or `wait_agent`
- `blocking: false` returns an ack after delivery
- `blocking: true` for running target has defined behavior, likely reject or
  wait for the next result only when the target actually continues
- queued agent messages emit an `agent_message` event for UI visibility

YAGNI decision: for v1, make observer messages `blocking: false`. If a normal
agent sends `blocking: true` to a running target, keep existing wait semantics
only if it is already safe; otherwise reject with a clear error.

### Unit Tests: Settings and Web Model Config

Files:

- `test/host/settings/types.test.ts`
- `test/host/settings/store.test.ts`
- `test/host/settings/model-overrides.test.ts`
- `test/host/settings/control-plane.test.ts`
- `web/src/components/__tests__/provider-settings.test.tsx`

Cases:

- `internalAgentModels.observer.metacognitive` validates provider/model shape
- env override `SPROUT_OBSERVER_METACOGNITIVE_MODEL` wins over stored settings
- deleting a provider removes dependent internal agent model settings
- settings snapshots include stored and overridden internal agent model purposes
- web settings UI can set, clear, and display env override state for the
  metacognitive observer model

### Integration Tests: Runtime Subscription Dispatcher

Files:

- `test/host/session-controller.test.ts`
- `test/bus/agent-process.test.ts`

Cases:

- dispatcher starts watcher handle at session start when configured
- watcher receives a bounded frame after trigger
- watcher can send `message_agent` guidance to root
- root receives guidance in the next planning prompt
- dispatcher coalesces repeated events while watcher is busy
- dispatcher stops/reset on `/clear`
- dispatcher does not deliver stale events from a suppressed old run
- subprocess child events are visible to subscriptions through session-wide
  event relay

### UI Tests

Files:

- `web/src/hooks/useAgentTree.test.ts`
- `web/src/components/groupEvents.test.ts`
- `web/src/components/__tests__/components.test.tsx`

Cases:

- runtime-started watcher appears in the agent tree
- watcher thread can be selected like other agent threads
- main thread shows a compact `agent_message` event
- observer raw frames are collapsed or hidden by default
- agent-message prompt-surface events do not render as user steering

### Memory Integration Tests

Files:

- `test/core/session-collapse.test.ts`
- `test/learn/extraction-evidence.test.ts`
- `test/bus/genome-service.test.ts`
- `test/genome/memory-mentions.test.ts` if split out

Cases:

- shared frame builder can reproduce current collapse transcript behavior
- shared frame builder can reproduce learn evidence windows
- observer messages are excluded from collapse transcripts by default
- `agent_message` events are excluded from memory extraction by default
- observer frames do not produce memory extraction by themselves
- memory mention tracking still increments from assistant `plan_end`
- archived/superseded compaction remains unchanged

### Live/Manual Tests

Scenarios:

1. Ask an architectural question, then have root start implementing too early.
   The metacognitive observer should message root to answer the design question
   first.
2. Force a repeated tool failure. The observer should identify the repeated
   failure pattern and suggest changing approach.
3. Run a normal short task. The observer should stay silent.
4. Delegate to engineer with watcher enabled. The watcher should observe
   delegated events and message the caller only if something material happens.

## Implementation Phases

### Phase 1: Event IDs and Frame Builder

- Add `event_id` to `SessionEvent`.
- Update emitters and replay normalization.
- Implement `SubscriptionFrameBuilder`.
- Add unit tests for event ids and frames.

### Phase 2: Agent Message Surface

- Extend `message_agent` parser with `references`.
- Make explicit `message_agent` tool access independent of `can_spawn` while
  leaving `delegate` and `wait_agent` gated by delegation rights.
- Add typed agent-message queue to `Agent`.
- Render `<sprout:agent-messages>` before planning turns.
- Keep human steering unchanged.
- Emit `agent_message` events for observability.
- Add tests proving agent messages are not user history.

### Phase 3: Model Purpose and Subscription Spec Parsing

- Add `internalAgentModels` settings support for `observer.metacognitive`.
- Add env override support with no fallback behavior.
- Expose the observer model purpose in the web settings UI.
- Extend model parsing/resolution for internal agent purposes.
- Extend `AgentSpec` with `subscriptions`.
- Parse and validate subscription frontmatter.
- Add serialization round-trip coverage.

### Phase 4: Subscription Dispatcher

- Add dispatcher owned by `SessionController` or adjacent runtime bootstrap.
- Register watcher subscriptions for active agents.
- Deliver frames through the existing bus/handle path.
- Reset on clear/shutdown.
- Add integration tests.

### Phase 5: Metacognitive Observer

- Add `metacognitive` agent spec and prompt.
- Configure it as runtime-started shared watcher.
- Ensure it has access to `message_agent` without making it a delegating
  orchestrator.
- Add UI visibility tests.

### Phase 6: Memory Integration Cleanup

- Refactor collapse transcript and learn evidence construction to use shared
  frame/event formatting where it reduces duplication without behavior changes.
- Optionally move memory mention tracking to an event subscriber.
- Do not change recall ranking, extraction prompts, archivist behavior, or
  maintenance algorithms in this phase.

## Open Decisions

1. **Root handle identity.**
   `message_agent` currently addresses spawned handles. The root session needs
   an addressable handle if observers are going to message it through the same
   tool. Options:
   - register root as a synthetic handle in `AgentSpawner`
   - add a runtime alias such as `handle: "root"`
   - create a root inbox in `SessionController`

   Recommendation: register a synthetic root handle so all messaging goes
   through the same handle registry.

2. **Watcher discovery location.**
   Should watcher agents live in `root/agents/` or a new `root/watchers/`?

   Recommendation: keep them in `root/agents/` initially so they use existing
   markdown loading, tools, model resolution, and UI names. They are not exposed
   as normal delegates unless listed in an agent's `agents` allowlist.

3. **Default subscriptions.**
   Should watchers default to final-turn-only or no subscription?

   Recommendation: no implicit default for normal agents. Runtime-started
   watcher configs must declare subscriptions. This avoids surprising costs.

4. **Prompt surface location.**
   Agent messages can be appended to the system prompt alongside environment and
   memory, or injected as a post-history assistant-style message.

   Recommendation: system prompt block in v1. It is closest to MIRA's HUD rule:
   briefing notes, not something the assistant said.

5. **Blocking messages to running agents.**
   Existing `message_agent` supports `blocking`. Agent-to-agent observer
   guidance should use `blocking: false`. Broader blocking semantics need a
   separate decision.

   Recommendation: leave blocking behavior unchanged for current delegate
   workflows, but require observer prompts to use `blocking: false`.

## Non-Goals

- No model-owned subscribe/unsubscribe tools.
- No human notifications/toasts/badges in v1.
- No separate `notify_agent` or `reply_to_notification` tools.
- No broad handle capability system.
- No model fallback behavior for observer or memory model purposes.
- No replacement of durable memory recall, extraction, indexing, archivist, or
  maintenance.
- No unbounded raw event logs in observer context.
- No observer memory writes.

## Success Criteria

- A metacognitive watcher is visible in the UI during a live session.
- It receives bounded event frames from the runtime.
- It can message root using `message_agent`.
- Root sees that message as agent-originated guidance in its next planning
  prompt, not as user steering.
- Observer messages do not contaminate session collapse or memory extraction by
  default.
- Existing delegation, resume, and child-thread UI behavior remains intact.
- Memory recall and maintenance behavior is unchanged except for optional shared
  frame-building refactors.
