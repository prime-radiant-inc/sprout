# Async Agent Messaging: Known Deviations from Design

Deviations between the [design spec](2026-02-25-async-agent-messaging-design.md) and the current implementation as of 2026-02-25.

---

## Root agent is not a standalone process

**Spec says:** "Every agent is a standalone process. Agents communicate exclusively through the message bus." The architecture diagram shows the session host spawning a root agent process.

**Implementation does:** Root agent runs in-process within the CLI/session host. Only sub-agents run as bus processes. The root agent uses the in-process `AgentEventEmitter` and `EventBus`, with a relay layer (`spawner.onEvent()`) bridging sub-agent bus events into the host EventBus for TUI display.

**Why:** Migrating the root agent to a bus process (original Task 18) was deferred because the TUI, session controller, and command routing all depend on the in-process EventBus. Completing this requires replacing the EventBus entirely.

**Impact:** The host has two event propagation paths: in-process for the root agent, bus-based for sub-agents. The relay in `defaultFactory` bridges them.

---

## `ready` and `commands` topics not in spec

**Spec lists 5 topic patterns:** inbox, events, result, genome/mutations, genome/events.

**Implementation adds:**
- `session/{id}/agent/{handle}/ready` -- agent publishes a ready signal after subscribing to its inbox, before the spawner sends the start message. Prevents a race where the start message arrives before the inbox subscription is active.
- `session/{id}/commands` -- session-level command topic (currently unused but wired in topics.ts).

---

## Subscribe acknowledgment protocol not in spec

**Spec** is silent on the wire protocol between bus client and server.

**Implementation** has a subscribe acknowledgment: the server sends `{action: "subscribed", topic}` after processing a subscribe request. The client's `subscribe()` method awaits this ack before resolving. This is used by the ready handshake to ensure subscription ordering is correct.
