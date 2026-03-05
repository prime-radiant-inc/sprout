# Web Interface — Design

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

**Goal:** Give Sprout a browser-based interface that connects to the same event bus as the terminal TUI, renders a richer experience (markdown, code highlighting, agent tree), and lets the user steer sessions from the browser.

**Non-goal:** Replacing the terminal TUI. The web UI is an alternative frontend, not a replacement. Both can run simultaneously against the same session.

## Architecture Overview

```
Browser (React SPA)
    |
    WebSocket (native browser WS)
    |
Bun HTTP/WS Server  ← new: src/web/server.ts
    |
    EventBus (in-process)
    |
SessionController ← existing, unchanged
    |
Agent / BusServer / AgentSpawner ← existing, unchanged
```

The web server is a thin Bun HTTP+WebSocket server that:
1. Serves the static SPA files
2. Bridges browser WebSocket connections to the in-process `EventBus`
3. Translates browser messages into `Command` objects (down channel)
4. Forwards `SessionEvent` objects to the browser (up channel)

This is intentionally **not** a connection to the agent bus (BusServer). The agent bus is for inter-agent communication over topics. The web UI connects to the same in-process `EventBus` that the Ink TUI uses. This keeps the architecture simple and means the web UI has exactly the same capabilities as the terminal UI.

## Why Not Connect to the Agent Bus Directly?

The agent bus (BusServer/BusClient) uses topic-based pub/sub designed for agent-to-agent messaging. The web UI needs the SessionBus interface (events up, commands down) — the same abstraction the TUI uses. Adding a WebSocket adapter that implements `SessionBus` over the agent bus would work, but it adds complexity for no benefit in v1. The in-process EventBus is simpler and already proven.

If we later want the web UI to observe sessions started by other processes (e.g., a headless CLI), we can add a bus bridge then.

## Web Server

A Bun `Bun.serve()` instance that handles both HTTP (static files) and WebSocket (event bridge).

```typescript
// src/web/server.ts
interface WebServerOptions {
  bus: SessionBus;
  port: number;
  staticDir: string;   // path to built SPA
  sessionId: string;
}
```

**HTTP routes:**
- `GET /` — serves `index.html`
- `GET /assets/*` — serves static files (JS, CSS, images)
- `GET /api/session` — returns current session metadata (JSON)

**WebSocket protocol (browser <-> server):**

Messages are JSON. Two types flow in each direction:

**Server -> Browser (events):**
```json
{ "type": "event", "event": { /* SessionEvent */ } }
{ "type": "snapshot", "events": [ /* SessionEvent[] */ ], "session": { /* metadata */ } }
```

The `snapshot` message is sent on initial connection, delivering all buffered events so the browser can render the full conversation history.

**Browser -> Server (commands):**
```json
{ "type": "command", "command": { "kind": "submit_goal", "data": { "goal": "..." } } }
{ "type": "command", "command": { "kind": "steer", "data": { "text": "..." } } }
{ "type": "command", "command": { "kind": "interrupt", "data": {} } }
// etc — any valid Command
```

The server validates the command kind and forwards it to `bus.emitCommand()`.

**Event buffering:** The web server subscribes to `bus.onEvent()` on startup and buffers events (same cap as EventBus: 10,000). When a browser connects, it receives the full buffer as a snapshot, then streams new events in real-time. This means the browser can connect/disconnect/reconnect without losing state.

## Frontend (React SPA)

React is the natural choice — Sprout already uses React (via Ink), and the component model maps cleanly. The web frontend is a separate React app, not shared code with Ink. Ink components use Ink-specific primitives (`<Box>`, `<Text>`, `useInput`) that don't exist in the browser. Attempting to share components would create an abstraction layer that helps nobody.

### Tech Stack

- **React 19** — already a dependency
- **Vite** — fast dev server, trivial Bun integration, zero-config TypeScript
- **No component library** — plain HTML + CSS. The UI is simple enough that a component library adds more weight than value.
- **CSS Modules** — scoped styles, no runtime, works with Vite out of the box
- **marked + shiki** — markdown and code highlighting (Sprout already uses marked; shiki is the engine behind ink-shiki-code)

### Layout

```
+----------------------------------------------------------+
|  [sprout]                            [model] [session-id] |  <- Header
+------------------+---------------------------------------+
|                  |                                         |
|  Agent Tree      |  Conversation                           |
|                  |                                         |
|  root            |  > Fix the login bug                    |
|    code-editor   |                                         |
|    * code-reader |  I'll analyze the login module...       |
|                  |                                         |
|                  |  > read_file src/auth.ts  ✓  0.3s       |
|                  |                                         |
|                  |  The issue is in the token validation... |
|                  |                                         |
|                  |  ╭─ code-editor: Fix validation logic    |
|                  |  │  > edit_file src/auth.ts  ✓           |
|                  |  ╰─ ✓ (3 turns)                          |
|                  |                                         |
+------------------+---------------------------------------+
|  ctx: 12k/200k (6%)  |  3 turns  |  ↑1.2k ↓500          |  <- Status Bar
+----------------------------------------------------------+
|  > _                                                       |  <- Input Area
+----------------------------------------------------------+
```

**Three-panel layout:**
1. **Agent Tree** (left sidebar, collapsible) — shows the agent hierarchy
2. **Conversation** (main area) — event stream, rich rendering
3. **Input + Status** (bottom) — text input and session stats

### Agent Tree Panel

The tree is built from events. The logic:
- `act_start` with a new `agent_id` at `depth > 0` → add a child node
- `act_end` → mark the agent as completed (success/fail indicator)
- `session_start` at `depth > 0` → agent is active (pulsing indicator)
- Active agent highlighted with a different color/style

Clicking an agent in the tree filters the conversation view to show only events from that agent (and its children). This is the "zoom into sub-agent" feature. A breadcrumb trail at the top of the conversation shows the current filter: `root > code-editor > ...` with each segment clickable.

The tree data structure:

```typescript
interface AgentTreeNode {
  agentId: string;         // from event.agent_id
  agentName: string;       // from act_start data.agent_name
  depth: number;
  status: "running" | "completed" | "failed";
  goal: string;            // from act_start data.goal
  children: AgentTreeNode[];
  turns?: number;
  durationMs?: number;
}
```

### Conversation View

Events are rendered into React components, similar to the Ink TUI's `event-components.tsx` but with browser-native rendering.

**Rich rendering upgrades over terminal:**
- **Markdown** — full GitHub-flavored markdown via `marked`
- **Code highlighting** — syntax-highlighted code blocks via `shiki`
- **Collapsible tool calls** — click to expand/collapse tool output
- **Collapsible delegations** — click to expand/collapse sub-agent work
- **Depth visualization** — colored left border (not ascii box-drawing)
- **Timestamps** — hover to see absolute time, display shows relative ("3s ago")
- **Copy buttons** — on code blocks and tool output

**Event rendering mapping** (reuses the same logic as `renderEventComponent` but with HTML/CSS):

| Event | Rendering |
|-------|-----------|
| `perceive` | User message bubble (blue accent) |
| `plan_end` (text) | Assistant message with rendered markdown |
| `plan_end` (reasoning) | Collapsible "thinking" section (italic, dim) |
| `primitive_start/end` | Tool call line with status icon, collapsible output |
| `act_start/end` | Delegation block with colored border, collapsible |
| `warning` | Yellow inline message |
| `error` | Red inline message |
| `compaction` | System message (dim) |
| `steering` | User message (distinct from initial goal) |
| `context_update` | Updates status bar (not rendered in conversation) |

**Filtering:** When an agent is selected in the tree, the conversation view filters to show events where `event.agent_id` matches the selected agent or any of its descendants. The filter is purely client-side — all events are still received and stored.

### Input Area

- Textarea with auto-resize
- Enter submits, Shift+Enter for newline (browser convention, differs from terminal's Alt+Enter)
- Slash commands work the same as terminal: `/help`, `/compact`, `/clear`, `/model`, `/status`, `/quit`
- When agent is running, submissions automatically route as steer commands
- Input history with up/down arrow navigation (stored in localStorage)

### Status Bar

Same information as the terminal status bar:
- Context token usage with percentage
- Turn count
- Input/output token totals (during run)
- Current model name
- Session ID (truncated, click to copy full)
- Connection status indicator (green dot = connected, red = disconnected)

### Real-time Updates

Events stream over the WebSocket and are appended to a React state array. The conversation view auto-scrolls to the bottom unless the user has scrolled up (same behavior as the terminal). A "scroll to bottom" button appears when not at the bottom.

`plan_delta` events (streaming text) update the most recent assistant message in-place for a typing effect.

## Startup and Integration

### Option 1: Combined process (recommended for v1)

The web server starts alongside the TUI when `--web` flag is passed:

```bash
sprout --web              # interactive mode + web UI on default port
sprout --web --port 8080  # specify port
sprout --web-only         # web UI only, no terminal TUI
```

This is the simplest approach: one process, one EventBus, one SessionController. The web server is just another subscriber to the same bus.

### Option 2: Standalone web server (future)

A separate `sprout-web` command that connects to an existing session's agent bus. Requires the bus bridge discussed above. Not needed for v1.

## File Structure

```
src/web/
  server.ts          <- Bun HTTP+WS server
  protocol.ts        <- message type definitions and validation

web/                 <- SPA source (Vite project root)
  index.html
  src/
    main.tsx         <- React entry point
    App.tsx          <- root component with layout
    hooks/
      useWebSocket.ts    <- WS connection + reconnect
      useEvents.ts       <- event stream state management
      useAgentTree.ts    <- build tree from events
    components/
      Header.tsx
      AgentTree.tsx
      ConversationView.tsx
      EventLine.tsx      <- renders a single SessionEvent
      InputArea.tsx
      StatusBar.tsx
      MarkdownBlock.tsx  <- markdown rendering wrapper
      CodeBlock.tsx      <- syntax-highlighted code block
    styles/
      global.css
      variables.css      <- color palette, spacing tokens
      *.module.css       <- per-component styles
    lib/
      events.ts          <- event type re-exports from kernel/types
      commands.ts         <- command builders
  vite.config.ts
  tsconfig.json
```

The `web/` directory is a separate Vite project with its own tsconfig. It imports type definitions from `src/kernel/types.ts` but no runtime code from the main Sprout source. The build output goes to `web/dist/` which the Bun server serves as static files.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Server framework | Bun.serve() directly | Already using Bun, zero dependencies |
| Frontend framework | React + Vite | React already a dependency, Vite is fast |
| CSS approach | CSS Modules | No runtime, scoped, works with Vite |
| Component library | None | UI is simple enough, avoid bloat |
| Markdown rendering | marked | Already a dependency |
| Code highlighting | shiki | Engine behind ink-shiki-code, browser-compatible |
| Event bridge | In-process EventBus | Same as TUI, proven, simple |
| Agent tree data | Derived from event stream | No new data source needed |
| Filtering | Client-side | All events buffered, filter is just a view |
| Startup | --web flag on existing CLI | One process, minimal integration surface |
| Build tool | Vite | Fast, zero-config TS, good Bun compat |

## What This Does NOT Do (v1 scope limits)

- No multi-session support (one session per server instance)
- No authentication (localhost only)
- No persistent web-side preferences (use localStorage for basics)
- No genome editor or memory browser
- No agent spec viewer
- No log file browser
- No mobile-optimized layout
- No dark/light theme toggle (dark theme only, matching terminal aesthetic)

These are all reasonable v2+ features.
