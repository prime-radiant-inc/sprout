# Interactive Terminal Experience — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Sprout a full interactive terminal experience — resume sessions, steer while running, interrupt without killing, context awareness with compaction.

**Architecture:** Event bus with two channels (agent events up, commands down). Session Controller manages agent lifecycle, persistence, and resume. Ink (React for CLIs) renders the TUI. One-shot mode preserved via `--prompt` flag.

## Event Bus

Two pub/sub channels, no routing or filtering — consumers filter by event kind.

**Agent events (up):** The existing 31 `SessionEvent` kinds from `events.ts`, plus new kinds:
- `session_resume` — emitted when a session is restored
- `context_update` — pressure, tokens, distance to compaction
- `compaction` — before/after token counts, summary

**Commands (down):** Published by any frontend, consumed by Session Controller.

| Command | Payload |
|---------|---------|
| `submit_goal` | `{ goal: string }` |
| `steer` | `{ text: string }` |
| `interrupt` | `{}` |
| `compact` | `{}` |
| `clear` | `{}` |
| `switch_model` | `{ model: string }` |
| `quit` | `{}` |

```typescript
interface EventBus {
  onEvent(listener: (event: SessionEvent) => void): () => void;
  emitEvent(event: SessionEvent): void;
  onCommand(listener: (command: Command) => void): () => void;
  emitCommand(command: Command): void;
}
```

The existing `AgentEventEmitter` gets replaced by (or wrapped into) the bus's `emitEvent`. Multiple frontends can subscribe simultaneously — Ink TUI, console renderer, web bridge, test harness.

## Session Controller

Stateful core managing agent lifecycle. Responds to commands from the bus.

**Responsibilities:**
- Create/destroy agents
- Route commands to agent (steer → steering queue, interrupt → abort signal)
- Persist session metadata after each turn
- Resume sessions from event log replay + metadata snapshot
- Track context pressure and trigger compaction

**Session state:**

```typescript
interface SessionState {
  sessionId: string;        // ULID
  agentSpec: string;        // root agent name
  model: string;
  status: "idle" | "running" | "interrupted";
  turns: number;
  contextTokens: number;
  contextWindowSize: number;
  createdAt: string;
  updatedAt: string;
}
```

**Persistence — two artifacts per session:**

```
~/.local/share/sprout-genome/sessions/{ulid}.meta.json   <- lightweight metadata
~/.local/share/sprout-genome/logs/{ulid}.jsonl            <- full event log (already exists)
```

Sessions are permanent — they are the genome's memories. No cleanup, no TTL, no pruning.

## Steering & Interrupt

**Steering** — type while the agent is running. Input auto-routes as a steer command.

```typescript
// On the Agent class
private steeringQueue: string[] = [];

steer(text: string): void {
  this.steeringQueue.push(text);
}

// In agent loop, before each plan phase:
// drain queue, inject as user messages into history
```

Bus wiring: TUI publishes `steer` command → Session Controller calls `agent.steer(text)` → agent drains queue at next loop iteration.

**Interrupt** — ctrl+c cancels current work without killing session.

`Agent.run()` takes an `AbortSignal`. Threads through to LLM client call and tool execution. When fired, current await rejects, agent loop catches it, emits `interrupted` event, stops.

- First ctrl+c: interrupts agent work, session stays alive, ready for new input
- Second ctrl+c (or `/quit`): exits process
- Interrupted state persisted — resume picks up from last completed turn
- Interrupt during subagent delegation: that delegation is lost, root resumes from before it

## Context Awareness & Compaction

Adapted from OpenAI Codex's compaction design.

**Token tracking:**
- After each LLM response, record `input_tokens` from API response
- Byte-based estimation fallback: 4 bytes ≈ 1 token (no tokenizer dependency)
- Conservative window: use 80% of context window as threshold

**Compaction flow (when `input_tokens >= contextWindow * 0.80`):**

1. Keep last 6 turns intact
2. Send older turns to LLM with handoff summary prompt:
   ```
   You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff
   summary for another LLM that will resume the task.

   Include:
   - Current progress and key decisions made
   - Important context, constraints, or user preferences
   - What remains to be done (clear next steps)
   - Any critical data, examples, or references needed to continue
   ```
3. Replace older history with summary prefix + compacted summary:
   ```
   Another language model started this task and produced a summary of its work.
   Full conversation log available at: {logPath}.jsonl (grep for details if needed).
   Use this summary to continue the work without duplicating effort:
   ```
4. Re-inject fresh system prompt (agent spec, recall context)
5. Emit `compaction` event (before/after token counts, summary)

**On resume:** When replay hits a `compaction` event, replace all prior history with the summary.

## Resume

**Resume flow:**

1. `sprout --resume {ulid}` or `--resume-last` or `--list` (picker)
2. Load metadata from `sessions/{ulid}.meta.json`
3. Replay `logs/{ulid}.jsonl` to reconstruct conversation history:
   - `plan_end` events → assistant messages (with tool calls)
   - `primitive_end` events → tool results
   - `act_end` events → delegation tool results
   - `compaction` events → replace all prior history with summary
   - `steering` events → injected user messages
4. Recreate agent with reconstructed history
5. Emit `session_resume` event (TUI shows restored conversation)
6. Ready for new input

**Listing sessions:**
- Scan `sessions/*.meta.json`, sort by ULID (chronological)
- Show: ULID prefix, agent spec, turns, last updated, status
- Interactive picker in TUI

**Subagent logs:** Each agent logs only its own events to its own file. Recursive nesting:
```
logs/{sessionId}.jsonl                                      <- root's own events
logs/{sessionId}/subagents/{ulid}.jsonl                     <- depth 1
logs/{sessionId}/subagents/{ulid}/subagents/{ulid2}.jsonl   <- depth 2
```

All events from all depths flow through the shared event bus for TUI display, but each agent's log file contains only its own events.

## TUI Components (Ink)

```
<App>
  <ConversationView />     <- scrollable history of events
  <StatusBar />            <- context pressure, tokens, turn count, model
  <InputArea />            <- text input with history navigation
</App>
```

**ConversationView:**
- Events from bus rendered as formatted lines
- Depth-based indentation for subagent events
- Tool calls collapsible (tab to expand/collapse)
- ANSI colors via Ink's `<Text>` with color props
- Auto-scrolls to bottom unless user scrolls up (PgUp → scroll mode)

**StatusBar:**
- Left: `ctx: 12k/200k (6%) | turn 3 | ↑1.2k ↓500`
- Right: `model: claude-sonnet-4-6 | session: 01JN...`
- Updates live from `plan_end` events (carry token usage)

**InputArea:**
- Multi-line: Enter submits, Alt+Enter for newline
- Up/Down navigates persistent input history (`~/.local/share/sprout-genome/input_history.txt`)
- When agent is running: submission auto-routes as steer command

**Slash commands:**

| Command | Action |
|---------|--------|
| `/help` | Show available commands |
| `/status` | Session info, loaded agents, model, context |
| `/compact` | Trigger manual compaction |
| `/model [name]` | Switch model (picker if no arg) |
| `/clear` | New session, clear display |
| `/quit` | Exit |

## CLI Changes

```
sprout                          -> interactive mode (default)
sprout --prompt "goal"          -> one-shot mode (no TUI, current rendering)
sprout --resume {ulid}          -> resume session in interactive mode
sprout --resume-last            -> resume most recent session
sprout --list                   -> interactive session picker
sprout --genome list|log|rollback  -> unchanged
```

Both interactive and one-shot modes use the same Session Controller and event bus. The only difference is the subscriber — Ink TUI vs console renderer.

## File Structure

**New files:**

```
src/
  host/
    event-bus.ts        <- two-channel pub/sub
    compaction.ts       <- threshold check + summarize
    resume.ts           <- log replay + history reconstruction
  tui/
    app.tsx             <- Ink root component
    conversation.tsx    <- scrollable event display
    status-bar.tsx      <- context/token/model display
    input-area.tsx      <- multi-line input with history
    slash-commands.ts   <- command parser + handlers
    history.ts          <- persistent input history
    render-event.ts     <- extracted from current cli.ts rendering
```

**Modified files:**
- `src/agents/agent.ts` — add `steer()` method, `AbortSignal` support
- `src/host/cli.ts` — revised arg parsing for new modes
- `src/host/session.ts` — evolves into Session Controller

**Unchanged:**
- Agent loop (perceive/recall/plan/act/verify)
- Genome, Learn, primitives, delegation
- Bootstrap agents, factory
- All existing tests

**New dependencies:**
- `ink` + `react`
- `ulid` (or hand-rolled ~20 lines)

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| TUI library | Ink (React for CLIs) | Component model maps to event-driven architecture |
| Architecture | Event bus (two channels) | Enables multiple frontends, clean decoupling |
| Agent ↔ TUI bridge | Direct in-process | Bun's async/await interleaves naturally, no HTTP overhead |
| Session persistence | Metadata snapshot + event log replay | Lightweight metadata, existing logs as source of truth |
| Session lifetime | Permanent | Sessions are genome memories |
| Compaction | Single threshold at 80% + handoff summary | Adapted from Codex, simple and effective |
| Session IDs | ULIDs | Time-sortable, human-scannable, lexicographic order |
| Default mode | Interactive | `--prompt` for one-shot |
| Compaction summary | Includes log file path | Agent can grep full log if summary lost detail |
