# Async Agent Messaging Design

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

**Goal:** Replace the current one-shot synchronous delegation model with a bus-based, per-process agent architecture that supports async delegation, conversational sub-agents, durable resume, and a path to remote agents.

**Context:** The current implementation collapses the spec's `spawn_agent` / `send_input` / `wait` / `close_agent` into a single synchronous `executeDelegation()` call. The parent creates a child Agent instance in-process, awaits `child.run(goal)`, and discards the child. This can't support async delegation, multi-turn conversations with sub-agents, or remote execution.

---

## Architecture Overview

```
+-------------------------------------------------------+
|  Session Host (CLI, TUI, API)                          |
|  - Starts the message bus                              |
|  - Spawns root agent process                           |
|  - Subscribes to all session events for UI             |
|  - Waits for root's result                             |
+-------------------------------------------------------+
        |                              ^
        | spawn root process           | events (all agents)
        v                              |
+-------------------------------------------------------+
|  Message Bus                                           |
|  - Topic-based pub/sub                                 |
|  - Topics: session/{id}/agent/{handle}/{channel}       |
|  - Channels: inbox, events, result                     |
|  - Technology: implementation detail (Unix socket,     |
|    WebSocket, NATS, in-process EventEmitter)           |
+-------------------------------------------------------+
    |         |         |              |
    v         v         v              v
+--------+ +--------+ +--------+ +-----------+
| Root   | | Editor | | Runner | | Genome    |
| Agent  | | Agent  | | Agent  | | Service   |
| Process| | Process| | Process| | (on bus)  |
+--------+ +--------+ +--------+ +-----------+
```

Every agent is a standalone process. Agents communicate exclusively through the message bus. The bus is the only inter-agent communication channel.

---

## Message Protocol

All messages are JSON-serializable. The bus routes messages by topic.

### Topics

```
session/{session_id}/agent/{handle_id}/inbox    -- messages TO the agent
session/{session_id}/agent/{handle_id}/events   -- events FROM the agent (broadcast)
session/{session_id}/agent/{handle_id}/result   -- completion result FROM the agent
session/{session_id}/genome/mutations           -- mutation requests TO genome service
session/{session_id}/genome/events              -- mutation confirmations FROM genome service
```

### Message Types

**Start message** (sent to new agent's inbox):
```typescript
{
  kind: "start";
  handle_id: string;          // ULID assigned by parent
  agent_name: string;         // Spec name to load from genome
  genome_path: string;        // Path to genome directory
  session_id: string;
  caller: {
    agent_name: string;
    depth: number;
  };
  goal: string;
  hints?: string[];
  shared: boolean;            // Whether other agents may message this handle
}
```

**Continue message** (sent to completed/idle agent's inbox):
```typescript
{
  kind: "continue";
  message: string;            // New input to append to conversation
  caller: {
    agent_name: string;
    depth: number;
  };
}
```

**Steer message** (sent to running agent's inbox):
```typescript
{
  kind: "steer";
  message: string;            // Injected between turns
}
```

**Result message** (agent publishes on completion):
```typescript
{
  kind: "result";
  handle_id: string;
  output: string;
  success: boolean;
  stumbles: number;
  turns: number;
  timed_out: boolean;
}
```

**Event message** (agent publishes throughout execution):
```typescript
{
  kind: "event";
  handle_id: string;
  event: SessionEvent;        // Existing SessionEvent type
}
```

---

## Tools

Three tools available to orchestrator agents (agents with `can_spawn: true`).

### delegate

```
delegate(agent_name, goal, hints?, blocking=true, shared=false)
```

- Spawns a new agent process, assigns it a handle ID (ULID), sends a `start` message to its inbox.
- `blocking=true` (default): subscribes to the agent's result topic and waits. Returns the result string directly as the tool output.
- `blocking=false`: returns the handle ID immediately. The agent runs concurrently.
- `shared=true`: marks the handle as messageable by agents other than the parent. The parent can pass the handle ID to other agents via goals or hints.
- `shared=false` (default): only the spawning agent can `wait_agent` or `message_agent` this handle.

### wait_agent

```
wait_agent(handle)
```

- Subscribes to the agent's result topic and waits for completion.
- If the agent already completed, returns the cached result immediately.
- If the original `delegate` was `blocking=true`, the result is already available (no-op).

### message_agent

```
message_agent(handle, message, blocking=true)
```

- If the agent is currently running (mid-planning-cycle): publishes a `steer` message to its inbox. The message is injected between turns.
- If the agent is idle (completed a previous run): publishes a `continue` message to its inbox. The agent appends the message as a new user turn to its existing conversation history and starts another planning cycle.
- `blocking=true` (default): waits for the next result from the agent.
- `blocking=false`: publishes the message and returns immediately (fire-and-forget).

---

## Agent Process Lifecycle

### Startup

1. Process starts, receives bus connection info and handle ID.
2. Connects to the bus.
3. Subscribes to its inbox topic: `session/{id}/agent/{handle}/inbox`.
4. Waits for a `start` message.
5. On `start`: loads agent spec from genome (disk read), resolves model, builds system prompt with `<caller>` identity block, begins planning loop.

### Running

1. Emits events to its events topic throughout execution.
2. Checks inbox between turns for `steer` messages; drains and injects as steering turns.
3. On natural completion (LLM responds with no tool calls): publishes `result` message, transitions to idle.
4. On turn limit or timeout: publishes `result` with `success=false`, transitions to idle.

### Idle (after completion)

1. Process stays alive, subscribed to inbox.
2. On `continue` message: appends message as new user turn to existing history, starts another planning cycle.
3. On `steer` message while idle: queues it for the next cycle.

### Shutdown

Agent process terminates when:
- The session host sends a shutdown signal (session ending).
- The parent explicitly closes the handle.
- An unrecoverable error occurs.

### Delegation from within an agent

When a running agent process needs to delegate:
1. Assigns a ULID handle ID to the child.
2. Requests the session host (or spawns directly) to start a new agent process.
3. Publishes a `start` message to the child's inbox.
4. If `blocking=true`: subscribes to child's result topic, waits.
5. If `blocking=false`: stores the handle, continues its own planning loop.

---

## Caller Identity

When a sub-agent's system prompt is built, a `<caller>` block is injected:

```
<caller>
Agent: root
Depth: 0
</caller>
```

This tells the sub-agent who it is working for. For `continue` messages from a different caller (shared agents), the caller identity is included in the message and prepended to the user turn.

---

## Durable State and Resume

### Event Logs as Durable State

Every agent process writes events to a durable JSONL log identified by its handle ID:

```
{genome_path}/logs/{session_id}/{handle_id}.jsonl
```

The event log captures everything needed to reconstruct agent state: goals received, LLM responses, tool calls, tool results, delegations made, results received.

### Resume After Death or Shutdown

To resume an agent that died or was shut down:

1. Find the agent's log by handle ID.
2. Replay the log to reconstruct conversation history (same as existing `replayEventLog()`).
3. Spawn a new process with the same handle ID.
4. Send a `start` message with the reconstructed history as initial context.
5. The agent continues from the last complete turn. If it died mid-LLM-call, that call is retried.

### Parent Resume

When a parent agent resumes, it reconstructs its child handle map from its own event log (`act_start` events contain handle IDs). For each child:

- If the child's log ends with a `result` event: the child completed. The result is available.
- If the child's log ends mid-run: the child needs to be re-spawned and resumed.

### Session Resume

The session host persists the handle-to-log-path mapping in session metadata. On `--resume`:

1. Load session metadata (existing flow).
2. Reconstruct the root agent's state from its log.
3. Identify any sub-agent handles from the root's log.
4. Resume sub-agents as needed (completed ones provide cached results; in-flight ones get re-spawned).

---

## Genome Service

A process on the message bus that owns genome mutations.

**Why:** Multiple concurrent agent processes may want to mutate the genome (learn signals, new memories, routing rule updates). File-level writes need serialization.

**How it works:**

- Agents read the genome directly from disk (fast, no coordination needed for reads).
- Mutation requests are published to `session/{id}/genome/mutations`.
- The genome service processes mutations one at a time: applies the change, commits to git, publishes a confirmation event.
- This is the current `LearnProcess` promoted to a bus-connected service.

---

## Utility Agents (Task Manager Pattern)

No special architecture. A utility agent like a task manager is a regular agent with filesystem-backed structured state in its workspace (e.g., `tasks.json` in its workspace directory).

Each caller delegates to it independently (separate agent instances, same backing files). The persistence is the file, not the agent's conversation history. `message_agent` is available for multi-turn interaction if needed, but the common case is a single delegation per caller.

For named, long-lived utility agents that persist across sessions: future extension. The current structured-state pattern handles the immediate need.

---

## What Changes vs. What Stays

### Stays

- Agent specs (YAML format, genome structure)
- Genome file structure (git-backed agents/, memories/, routing/)
- LLM adapter layer (Client, Anthropic/OpenAI/Gemini providers)
- All primitives (read_file, write_file, edit_file, exec, grep, glob, fetch)
- `buildSystemPrompt`, `buildPlanRequest`, `parsePlanResponse`
- Event types (`SessionEvent`, `EventKind`)
- Truncation logic
- Model resolution

### Changes

- `Agent.run()` becomes a message-handling loop inside a standalone process
- `executeDelegation()` becomes "publish start message to bus, subscribe to result"
- Direct object sharing (genome, learnProcess, events emitter) becomes bus messages
- `createAgent()` factory becomes a process spawner
- Event emission goes through the bus instead of direct callback
- Sub-agent logs become the durable state for resume (promoted from diagnostic)
- LearnProcess becomes a genome service on the bus

---

## Migration Path

1. **Bus layer**: Build the message bus abstraction with a pluggable transport. Start with an in-process or local transport. Same protocol works over network later.
2. **Agent process**: Refactor `Agent` to run as a standalone message-handling loop. Keep all planning logic intact.
3. **Tools**: Replace the current single `delegate` tool with `delegate` (blocking/shared params), `wait_agent`, `message_agent`.
4. **Genome service**: Extract LearnProcess into a bus-connected genome mutation service.
5. **Session host**: Update the CLI/TUI to start the bus, spawn root, and observe events via bus subscription.
6. **Resume**: Extend session resume to reconstruct sub-agent handles and resume in-flight agents.
7. **Remote**: Swap the bus transport from local to network. Agent processes can now run anywhere.
