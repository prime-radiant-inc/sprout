# Web Interface — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

Companion design doc: `2026-02-26-web-interface-design.md`

## Phase 1: Server-Side Bridge (tasks 1-4)

### Task 1: WebSocket protocol types

Create `src/web/protocol.ts` with the shared message types used between the Bun server and browser client.

**Types:**
```typescript
// Server -> Browser
type ServerMessage =
  | { type: "event"; event: SessionEvent }
  | { type: "snapshot"; events: SessionEvent[]; session: { id: string; status: string } };

// Browser -> Server
type CommandMessage = { type: "command"; command: Command };
```

Include a `parseCommandMessage(raw: string): CommandMessage` validator (similar to `parseBusMessage`).

**Test:** Unit test for `parseCommandMessage` — valid commands parse, invalid JSON throws, missing fields throw, unknown command kinds pass through (the SessionController decides what's valid).

**Files:** `src/web/protocol.ts`, `test/web/protocol.test.ts`

### Task 2: Web server with event bridging

Create `src/web/server.ts` — a Bun HTTP+WebSocket server.

**Behavior:**
- Constructor takes `{ bus: SessionBus, port: number, staticDir: string, sessionId: string }`
- `start()` — starts `Bun.serve()` with HTTP and WebSocket handlers
- `stop()` — shuts down
- HTTP `GET /` and `GET /assets/*` serve static files from `staticDir`
- HTTP `GET /api/session` returns `{ id, status }` JSON
- On WebSocket upgrade: subscribe to `bus.onEvent()`, send snapshot of buffered events, then stream new events
- On WebSocket message: parse as `CommandMessage`, call `bus.emitCommand()`
- On WebSocket close: unsubscribe from bus
- Buffers events internally (cap at 10,000, same as EventBus)

**Test:** Integration test using a real EventBus + WebServer + WebSocket client.
- Start server, connect WS, verify snapshot message received
- Emit events into bus, verify they arrive over WS
- Send command over WS, verify bus.onCommand listener fires
- Disconnect, reconnect, verify new snapshot includes events from before

**Files:** `src/web/server.ts`, `test/web/server.test.ts`

### Task 3: CLI integration — `--web` flag

Modify `src/host/cli.ts` to support `--web`, `--web-only`, and `--port` flags.

**Behavior:**
- `--web` — starts web server alongside the Ink TUI (both subscribe to same bus)
- `--web-only` — starts web server without Ink TUI (for headless/remote use)
- `--port N` — sets web server port (default: 7777)
- Web server starts after SessionController is created, before Ink render
- Web server stops in the cleanup phase
- Console logs the URL: `Web UI: http://localhost:7777`

**Parsing changes to `parseArgs`:**
- New CliCommand variant: add `web?: boolean`, `webOnly?: boolean`, `port?: number` fields to the interactive/resume commands

**Test:** Unit tests for `parseArgs` with new flags. Integration test is deferred to Phase 3 (needs the SPA).

**Files:** Modified `src/host/cli.ts`, modified/new tests in `test/host/cli.test.ts`

### Task 4: Slash command for web server

Add `/web` slash command that starts the web server on-demand from an interactive session. This is a convenience — users can type `/web` to open the browser UI without restarting.

**Behavior:**
- `/web` — starts web server if not already running, opens browser via `open http://localhost:PORT`
- `/web stop` — stops the web server
- Requires wiring through the slash command handler to start/stop the web server

**Test:** Unit test for parseSlashCommand recognizing `/web` and `/web stop`.

**Files:** Modified `src/tui/slash-commands.ts`, modified `src/host/cli.ts`

## Phase 2: Frontend SPA (tasks 5-11)

### Task 5: Vite project scaffold

Create the `web/` directory with Vite + React + TypeScript configuration.

**Files to create:**
- `web/index.html` — minimal HTML shell with `<div id="root">`
- `web/src/main.tsx` — React entry, renders `<App />`
- `web/src/App.tsx` — placeholder layout with header, empty panels
- `web/vite.config.ts` — configure Vite with React plugin, alias `@kernel` to `../src/kernel` for type imports
- `web/tsconfig.json` — strict TypeScript, JSX react-jsx, path aliases
- `web/src/styles/global.css` — CSS reset, dark theme base, monospace font
- `web/src/styles/variables.css` — color palette (match terminal TUI colors)
- `web/package.json` — dependencies: react, react-dom, @vitejs/plugin-react, vite, shiki, marked

**Test:** `bun run --cwd web build` succeeds and produces `web/dist/index.html`.

**Files:** Everything under `web/`

### Task 6: WebSocket hook

Create `web/src/hooks/useWebSocket.ts` — manages the browser WebSocket connection.

**Behavior:**
- Connects to `ws://localhost:PORT` on mount
- Auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s)
- Exposes: `{ connected, send, lastMessage }`
- `send(msg)` queues messages if not connected, sends when connection opens
- Parses incoming messages as `ServerMessage`
- Handles snapshot vs event messages

**Test:** Unit test with a mock WebSocket (or use the real web server from task 2). Verify reconnect behavior, message parsing, queue-while-disconnected.

**Files:** `web/src/hooks/useWebSocket.ts`, `web/src/hooks/useWebSocket.test.ts`

### Task 7: Event state hook

Create `web/src/hooks/useEvents.ts` — manages the event stream and session state.

**Behavior:**
- Takes the WebSocket hook's output as input
- Maintains `events: SessionEvent[]` array
- On snapshot message: replaces events array
- On event message: appends to events array
- Derives status state from events (same logic as TUI `App.tsx`): running/idle, model, turns, tokens
- Exposes: `{ events, status, sendCommand }`

**Test:** Unit test — feed mock messages, verify state transitions.

**Files:** `web/src/hooks/useEvents.ts`, `web/src/hooks/useEvents.test.ts`

### Task 8: Agent tree hook

Create `web/src/hooks/useAgentTree.ts` — builds the agent tree from events.

**Behavior:**
- Takes `events: SessionEvent[]` as input
- Builds tree of `AgentTreeNode` objects by scanning for `act_start`/`act_end` pairs
- Root node is implicit (agent_id from depth=0 events)
- Tracks active/completed/failed status per agent
- Returns: `{ tree: AgentTreeNode, selectedAgent: string | null, setSelectedAgent }`

**Test:** Unit test — feed mock events, verify tree structure.

**Files:** `web/src/hooks/useAgentTree.ts`, `web/src/hooks/useAgentTree.test.ts`

### Task 9: Conversation view components

Create the conversation rendering components.

**Components:**
- `web/src/components/ConversationView.tsx` — the scrollable event list
  - Auto-scroll to bottom (with "jump to bottom" button when scrolled up)
  - Optional agent filter (from tree selection)
  - Duration tracking (same logic as TUI's `trackDuration`)
- `web/src/components/EventLine.tsx` — dispatcher: event kind -> component
- `web/src/components/UserMessage.tsx` — styled user message
- `web/src/components/AssistantMessage.tsx` — markdown-rendered assistant text
- `web/src/components/ToolCall.tsx` — collapsible tool call with status, duration, output preview
- `web/src/components/DelegationBlock.tsx` — collapsible delegation with colored border
- `web/src/components/SystemMessage.tsx` — dim system/warning/error messages
- `web/src/components/MarkdownBlock.tsx` — wrapper around `marked` with custom renderer
- `web/src/components/CodeBlock.tsx` — syntax-highlighted code via `shiki`

**Test:** Render tests for key components with mock events. Verify markdown renders, code blocks highlight, tool calls collapse.

**Files:** All under `web/src/components/`, tests under `web/src/components/__tests__/`

### Task 10: Agent tree panel

Create `web/src/components/AgentTree.tsx`.

**Behavior:**
- Renders the tree as a nested list
- Each node shows: agent name, goal (truncated), status icon
- Active agent has a pulsing indicator (CSS animation)
- Completed shows checkmark (green) or X (red)
- Click a node to filter the conversation view
- "All agents" option at top to clear the filter
- Breadcrumb trail above conversation view shows current filter path
- Collapsible sidebar (toggle button or keyboard shortcut)

**Test:** Render test with a mock tree. Verify click handler fires, active/completed states render correctly.

**Files:** `web/src/components/AgentTree.tsx`, `web/src/components/Breadcrumb.tsx`, tests

### Task 11: Input area and status bar

Create the bottom panel components.

**InputArea:**
- `web/src/components/InputArea.tsx`
- Textarea with auto-resize (grows to content, max 10 lines)
- Enter submits, Shift+Enter for newline
- Up/down arrow for input history (stored in localStorage)
- Slash command parsing (reuse logic from `src/tui/slash-commands.ts`)
- Visual indicator when agent is running ("steering mode")
- Disable submit button (or show loading) while submitting

**StatusBar:**
- `web/src/components/StatusBar.tsx`
- Same info as terminal: context tokens, turns, I/O tokens, model, session ID
- Connection status dot (green/red)
- Click session ID to copy

**Test:** Render tests for both components.

**Files:** `web/src/components/InputArea.tsx`, `web/src/components/StatusBar.tsx`, tests

## Phase 3: Integration and Polish (tasks 12-14)

### Task 12: App assembly

Wire everything together in `web/src/App.tsx`.

**Behavior:**
- Three-panel layout: sidebar (AgentTree), main (ConversationView), bottom (StatusBar + InputArea)
- WebSocket connection managed at top level
- Event state flows down via props (no global state library needed for v1)
- Keyboard shortcuts: Ctrl+/ to toggle sidebar, Escape to clear agent filter
- Responsive: sidebar collapses on narrow viewports

**Test:** End-to-end test: start web server + SPA dev server, connect, submit a goal, verify events render. (This may be manual for v1.)

**Files:** `web/src/App.tsx`, `web/src/App.module.css`

### Task 13: Build pipeline

Set up the build so the SPA can be served by the Bun server.

**Behavior:**
- `bun run web:build` — runs `vite build` in the `web/` directory, outputs to `web/dist/`
- The Bun web server in `src/web/server.ts` serves from `web/dist/` by default
- In development: `bun run web:dev` runs Vite dev server with HMR, proxies API/WS to the Bun server
- Add scripts to root `package.json`

**Files:** Modified `package.json`, `web/vite.config.ts` (proxy config)

### Task 14: Documentation

Update or create documentation for the web interface.

- Usage instructions in `--help` output
- Brief mention in project README if one exists

**Files:** Modified `src/host/cli.ts` (help text)

## Task Dependency Graph

```
Task 1 (protocol types)
  └─> Task 2 (web server)
        └─> Task 3 (CLI integration)
        └─> Task 4 (slash command)

Task 5 (Vite scaffold)
  └─> Task 6 (WS hook)
        └─> Task 7 (event state hook)
              └─> Task 8 (agent tree hook)
              └─> Task 9 (conversation components)
              └─> Task 11 (input + status)
        └─> Task 10 (agent tree panel)
              └─> Task 12 (app assembly)

Task 12 (app assembly)
  └─> Task 13 (build pipeline)
        └─> Task 14 (documentation)
```

Phases 1 and 2 can proceed in parallel after Task 1 (protocol types are shared).

## Estimated Effort

| Phase | Tasks | Estimate |
|-------|-------|----------|
| Phase 1: Server bridge | 4 tasks | 1-2 sessions |
| Phase 2: Frontend SPA | 7 tasks | 3-4 sessions |
| Phase 3: Integration | 3 tasks | 1-2 sessions |
| **Total** | **14 tasks** | **5-8 sessions** |

## Risk and Open Questions

1. **Vite + Bun compatibility** — Vite officially supports Bun as of v5. Should work, but may hit edge cases. Fallback: use Node for the Vite dev server only.

2. **shiki bundle size** — shiki loads grammar/theme WASM bundles. For v1, lazy-load only common languages (TypeScript, JavaScript, JSON, bash, markdown). Can optimize later.

3. **Event buffer memory** — 10,000 events in browser memory is fine. Long-running sessions might accumulate more. For v1, cap at 10,000 (matching the server). Add pagination later if needed.

4. **Type sharing between web/ and src/kernel/** — The SPA needs `SessionEvent`, `Command`, `EventKind`, and `CommandKind` types. Options:
   - (a) Vite path alias to import from `../src/kernel/types.ts` — simplest, works for types
   - (b) Copy types into `web/src/lib/` — more isolated but can drift
   - Recommend (a) for v1.
