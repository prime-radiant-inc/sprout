# Web Interface Redesign

The current web UI reproduces the terminal TUI in a browser. It renders events as a scrolling conversation log with raw `<pre>` output. Sub-agent filtering doesn't work. Tool output has no rich formatting. Nothing collapses. The agent tree is invisible.

This design replaces it with a threaded conversation interface — one that treats each agent delegation as a navigable conversation thread, renders tool output with type-specific formatters, and adapts its layout to session state.

## Design Principles

**Conversation is primary.** Engineers interact with agents through conversation, not code. The conversation view dominates the layout. Code diffs and file contents appear as expandable details within the conversation flow, not as peer panels.

**Threads, not a log.** Each sub-agent delegation is a conversation thread that branches from the parent. Users see a preview inline and can navigate into the full thread. This mirrors how delegation actually works: the root agent starts a conversation, sub-agents carry out focused sub-conversations.

**Adaptive context.** The sidebar shows what matters now. While an agent runs: the live agent tree. When idle: session summary, cost breakdown, files touched. The UI shifts to match the user's current need — monitoring vs. reviewing.

**Themeable from day one.** Every color, shadow, radius, and surface tone is a CSS custom property. The default theme is light and friendly. Dark mode and custom themes require only a new set of variable assignments.

## Competitive Landscape

We studied ten AI coding agent interfaces and eight engineering tools. The findings that shaped this design:

**What works elsewhere:**
- Cline's per-tool-call checkpoints and full audit trail build trust through transparency
- Devin's multi-panel workspace (terminal + editor + browser) gives maximum observability
- Bolt.new's live preview provides the tightest feedback loop on generative tasks
- GitHub Actions' workflow DAG shows plan progress visually
- Linear's optimistic UI and keyboard shortcuts make dense interfaces feel fast
- Vercel's favicon status lets engineers monitor without switching tabs

**What fails everywhere:**
- Cost opacity. Engineers get bill shock across every tool. Nobody shows real-time cost with projections.
- Approval fatigue vs. magic box. Either every action needs approval (Cline) or nothing is visible (Bolt). The middle ground — smart defaults with expandable detail — barely exists.
- Flat conversation. Every tool renders agent work as a single scrolling log. None handle nested agent delegation as a first-class concept.

**Our advantage:** Sprout's event protocol already carries agent hierarchy data (agent_id, depth, act_start/act_end). No competitor surfaces delegation structure as navigable threads. We will.

## Architecture

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  ctx ████░░ 42k/200k   3 turns   $0.47   opus-4 ▾   ⏸  ⏹   │
├──────────┬───────────────────────────────────────────────────┤
│          │                                                    │
│  Agent   │  [root > code-editor]                              │
│  Tree    │                                                    │
│          │  ┌─────────────────────────────────────────────┐   │
│  ● root  │  │ You                             12:04 PM    │   │
│  ├● edit │  │ Fix the login bug in src/auth.ts            │   │
│  └○ read │  └─────────────────────────────────────────────┘   │
│          │                                                    │
│  ──────  │  ┌─────────────────────────────────────────────┐   │
│  Session │  │ sprout                                      │   │
│  $0.47   │  │ I'll analyze the login module and fix the   │   │
│  3 turns │  │ token validation issue.                     │   │
│  opus-4  │  └─────────────────────────────────────────────┘   │
│          │                                                    │
│          │  ⚡ read_file src/auth.ts  ✓ 0.3s          [▸]    │
│          │                                                    │
│          │  ┬─ code-editor: Fix validation  ● 2 turns        │
│          │  │  ⚡ edit_file src/auth.ts  ✓ 1.2s       [▸]    │
│          │  │  ⚡ run_tests  ● running...                     │
│          │  ╰─                       [open thread →]          │
│          │                                                    │
├──────────┴───────────────────────────────────────────────────┤
│  > Steer the agent...                                 [Send]  │
└──────────────────────────────────────────────────────────────┘
```

Three regions:

1. **Status bar** (top) — always-visible telemetry and controls
2. **Sidebar** (left, collapsible) — agent tree when running, session summary when idle
3. **Conversation** (center) — threaded message view with rich rendering
4. **Input** (bottom) — auto-resizing textarea with steering mode

### Status Bar

A single compact row with:

| Element | Display | Behavior |
|---------|---------|----------|
| Context pressure | Mini progress bar + `42k/200k 21%` | Bar color shifts green → yellow → red as pressure rises |
| Turn count | `3 turns` | Increments on each `plan_end` |
| Cost | `$0.47` | Cumulative, updates in real-time |
| Model | `opus-4 ▾` | Dropdown to switch model mid-run (emits `switch_model` command) |
| Pause | `⏸` button | Sends `interrupt`, preserves session |
| Stop | `⏹` button | Sends `interrupt` + signals done |
| Connection | Small dot, top-right corner | Green when WebSocket connected, red when disconnected |

The browser favicon also reflects session state: default when idle, accent color when running, warning on error.

### Sidebar

**While running — Agent Tree:**

```
● root (sprout)                    running
├── ● code-editor                  running (2 turns, 1.4s)
│   └── ○ test-runner              completed (1 turn, 3.2s)
└── ● code-reader                  running
```

- Status indicators: filled dot = running, hollow dot = completed, red dot = failed
- Click a node to filter the conversation to that agent's events and its descendants
- Hover reveals: goal text, duration, turn count
- Active/selected node gets a highlighted background
- Animated: nodes appear with a fade-in when agents spawn

**While idle — Session Summary:**

- Total cost, total turns, total duration
- Files touched (list with add/modify/delete indicators)
- Errors and warnings encountered (count + expandable list)
- Learning events (if any `learn_*` events occurred)

The transition between running and idle states is a smooth crossfade, not a hard swap.

**Responsive behavior** (adapted from Lace):
- Desktop (≥1024px): sidebar always visible, 240px wide, collapsible to icon rail
- Mobile (<1024px): sidebar hidden by default, opens as overlay with backdrop
- Toggle via hamburger button or `Ctrl+/` keyboard shortcut

### Conversation View

The conversation panel renders the event stream as grouped, threaded messages.

#### Message Grouping

Consecutive messages from the same agent are grouped. The header (avatar + name + timestamp) appears only on the first message in a group. Subsequent messages show content only, with reduced top margin. A group breaks when the agent changes, a tool call or delegation intervenes, or more than 60 seconds pass between messages.

#### Message Types

**User messages** (`perceive`, `steer` events):
- Left-aligned, subtle accent background
- User icon + "You" label
- Steering messages show a "steering" badge to distinguish from the initial goal

**Agent messages** (`plan_end` events):
- Left-aligned, no special background
- Agent name + avatar
- Content rendered as full GitHub-Flavored Markdown: headings, lists, links, tables, inline code
- Code blocks syntax-highlighted (language auto-detected)
- Extended thinking / reasoning in a collapsible `<details>` block, dimmer text

**Streaming text** (`plan_delta` events):
- Updates the current message content in place
- Three-dot typing indicator shown while waiting for the first token
- Smooth text appearance (no flicker or layout shift)

**Tool calls** (`primitive_end` events):
- Compact single line by default: `⚡ tool_name key_args  ✓ 0.3s  [▸]`
- Status icon: ✓ green for success, ✗ red for failure
- Duration shown inline
- Click `[▸]` to expand and reveal full output via a type-specific renderer

**Delegation blocks** (`act_start` / `act_end` events):
- Renders as a bordered block with left accent stripe
- Header: agent name + goal + status indicator
- Body: collapsed preview showing the agent's last 2-3 events
- Footer: "open thread →" link to navigate into the full thread
- When completed: collapses to a single summary line showing agent name + ✓/✗ + turn count + duration
- When failed: remains expanded with error context visible

**System messages** (`warning`, `error`, `compaction`, `session_resume`, `session_clear`, `learn_*`):
- Centered, pill-shaped, dimmer text
- Warning: amber accent dot
- Error: red accent dot
- Compaction: gray, shows "Context compacted: N → M messages"
- Learning: subtle, shows mutation description

#### Thread Navigation

Two ways to view a sub-agent's work:

1. **Inline expansion** (default): The delegation block shows a preview of recent activity. Clicking `[▸]` on individual tool calls within the block expands them in place.

2. **Navigate into thread**: Clicking "open thread →" (or clicking the agent in the sidebar tree) filters the conversation to show only that agent's events and its descendants. A breadcrumb trail appears at the top: `root > code-editor > test-runner`. Each segment is clickable. Clicking root (or pressing Escape) returns to the unfiltered view.

Thread navigation is a client-side filter — all events remain buffered. The transition animates smoothly (fade/slide, not a page reload).

#### Auto-scroll

The conversation auto-scrolls to the bottom as new events arrive, unless the user has scrolled up. A "Jump to bottom" button appears when the user is scrolled away from the bottom. Threshold: `scrollHeight - scrollTop - clientHeight < 40px`.

### Tool Renderers

Each tool type gets a dedicated renderer. All renderers share a common expand/collapse shell and are registered in a renderer map for extensibility.

| Tool | Collapsed Display | Expanded Display |
|------|------------------|-----------------|
| `read_file` | `⚡ read_file src/auth.ts ✓ 0.3s` | Filename, line count, first ~10 lines as syntax-highlighted preview |
| `edit_file` | `⚡ edit_file src/auth.ts ✓ 1.2s` | Unified diff view: red lines removed, green lines added, context lines in gray |
| `write_file` | `⚡ write_file src/new.ts ✓ 0.1s` | Filename + line count + syntax-highlighted content preview |
| `exec` / `bash` | `⚡ exec "npm test" ✓ 3.2s` | Terminal-styled output block. Non-zero exit code highlighted in red. Stderr separated from stdout. |
| `search` / `grep` | `⚡ search "pattern" ✓ 0.5s` | Results list with file paths + matching line previews |
| `web_fetch` | `⚡ web_fetch url ✓ 1.1s` | URL + response summary |
| Other | `⚡ tool_name ✓ 0.2s` | Formatted JSON of args and output |

Expanded content has a maximum height with scroll. A "Copy" button appears on hover for code/output blocks.

### Input Area

An auto-resizing textarea pinned to the bottom.

- **Idle state**: Placeholder "Enter a goal...", Send button (accent color)
- **Running state**: Placeholder "Steer the agent...", Send button transforms to Stop button (red). Submissions route as `steer` commands.
- Enter sends, Shift+Enter inserts newline
- Up/Down arrow navigates input history (persisted in localStorage, max 100 entries)
- Slash commands: `/help`, `/compact`, `/clear`, `/model`, `/status`, `/quit`
- Maximum height: 10 lines before internal scroll

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+/` | Toggle sidebar |
| `Escape` | Clear agent filter (return to root view) |
| `Escape` (when input focused) | Stop streaming agent |
| `/` (when input not focused) | Focus input |

## Theming

Every visual property is a CSS custom property defined on `[data-theme]`. Components never reference raw color values.

### Token Categories

```css
[data-theme="light"] {
  /* Surfaces */
  --color-canvas: ...;          /* Page background */
  --color-surface: ...;         /* Card/panel background */
  --color-elevated: ...;        /* Dropdown/modal background */
  --color-inset: ...;           /* Input backgrounds (darker than surface) */

  /* Text */
  --color-text-primary: ...;    /* Default text */
  --color-text-secondary: ...;  /* Supporting text */
  --color-text-tertiary: ...;   /* Metadata, timestamps */
  --color-text-placeholder: ...; /* Input placeholders */

  /* Borders */
  --color-border: ...;          /* Standard separation */
  --color-border-strong: ...;   /* Emphasis separation */

  /* Shadows */
  --shadow-sm: ...;             /* Cards, subtle lift */
  --shadow-md: ...;             /* Dropdowns, popovers */
  --shadow-lg: ...;             /* Modals */

  /* Accent */
  --color-accent: ...;          /* Primary action color */
  --color-accent-hover: ...;    /* Hover state */
  --color-accent-subtle: ...;   /* Accent tinted background */

  /* Semantic */
  --color-success: ...;
  --color-warning: ...;
  --color-error: ...;
  --color-info: ...;

  /* Agent status */
  --color-running: ...;         /* Active agent indicator */
  --color-completed: ...;       /* Finished agent indicator */
  --color-failed: ...;          /* Failed agent indicator */

  /* Typography */
  --font-ui: 'DM Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --font-size-base: 15px;
  --font-size-sm: 13px;
  --font-size-xs: 12px;
  --font-size-xxs: 11px;
  --line-height: 1.5;

  /* Spacing */
  --space-unit: 4px;    /* Base unit — all spacing is multiples of this */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;

  /* Radii */
  --radius-sm: 6px;     /* Buttons, inputs */
  --radius-md: 8px;     /* Cards, tool call blocks */
  --radius-lg: 12px;    /* Messages, delegation blocks */
  --radius-full: 9999px; /* Pills, badges */
}
```

The default theme is light with warm neutrals: off-white canvas, white surfaces, soft shadows, purple accent. A dark theme follows as a second set of assignments in the same file.

### Depth Strategy

Subtle shadows for the light theme. Cards and messages get `--shadow-sm`. Dropdowns and popovers get `--shadow-md`. Modals get `--shadow-lg`. The sidebar and conversation share the same canvas color — a single quiet border separates them.

## What We Reuse from Lace

The Lace web UI (`~/git/lace/packages/web`) has production-quality patterns worth adopting:

| Pattern | Lace Implementation | Our Adaptation |
|---------|-------------------|---------------|
| Sidebar | Responsive toggle: mobile overlay + desktop panel, spring animation (stiffness 200, damping 25) | Same responsive behavior. Content is agent tree + session stats instead of session/agent lists. |
| Message grouping | Consecutive same-sender messages grouped, header on first only | Same logic, grouped by `agent_id` |
| Tool renderers | Per-tool-type components (bash, file_read, file_edit, task) with expand/collapse pattern | Same architecture. Our tool types differ but the shell pattern is identical. |
| Chat input | Auto-resize textarea, Enter/Shift+Enter, Send↔Stop button toggle | Same, plus slash commands and steering-mode placeholder swap |
| Typing indicator | Three-dot pulse animation with staggered delay | Same |
| System messages | Centered pill with status dot and dimmer text | Same |
| Animation configs | Spring presets: gentle, snappy, bouncy, smooth, stiff | Adopt snappy (300/30) for sidebar, gentle (100/15) for message enter |
| Message enter animation | `{ opacity: 0, y: 8 }` → `{ opacity: 1, y: 0 }`, 150ms ease-out | Same |
| Provider pattern | React Context for sessions, events, settings | Same approach for WebSocket, Events, AgentTree, SessionStatus |
| Modal system | Portal-based, Escape to close, backdrop click, focus trap | Same, used for expanded tool output detail views |
| Streaming header | Fixed-position banner: "agent is responding" with pulsing indicator | Same, adapted to show current agent name |

**What we do not adopt from Lace:**
- DaisyUI / Tailwind — we use CSS Modules (already established)
- Voice input — not relevant
- Agent list as flat sidebar section — we need a tree
- File browser sidebar — deferring to v2

## What We Reuse from Existing Sprout Web Code

The current implementation has solid infrastructure underneath the poor UI:

| Layer | Status | Action |
|-------|--------|--------|
| `useWebSocket` hook | Working: auto-reconnect, message queuing, exponential backoff | Keep as-is |
| `useEvents` / `EventStore` | Working: event buffering, status derivation, token tracking | Keep as-is, extend with cost computation |
| `useAgentTree` hook | Working: builds tree from act_start/act_end events | Keep as-is |
| `src/web/server.ts` | Working: HTTP + WS + snapshot on connect | Keep as-is |
| `src/web/protocol.ts` | Working: message types and validation | Keep, extend with new command types |
| Component rendering | Poor: raw pre blocks, no grouping, no collapse | Replace entirely |
| CSS / styling | Poor: terminal-aesthetic dark theme | Replace entirely |
| Layout (App.tsx) | Partial: three-panel concept is right, execution is wrong | Rewrite with new layout |

## Event Protocol Additions

The current 23 event kinds carry most of what the UI needs. A few additions:

| Addition | Reason | Implementation |
|----------|--------|---------------|
| Cost field on `plan_end` | Real-time cost display | Compute from token usage + model pricing table; add `cost_usd` field to `plan_end` data |
| Structured diff on `primitive_end` for edit tools | Rich diff rendering | When tool is `edit_file`, include `{ before: string, after: string }` or unified diff in output |
| `interrupt_agent` command | Per-agent stop from UI | New command kind targeting a specific `agent_id`; SessionController forwards to the right agent |

These are additive — no existing event contracts change.

## New Command Types

| Command | Data | Purpose |
|---------|------|---------|
| `interrupt_agent` | `{ agent_id: string }` | Stop a specific sub-agent without stopping the entire session |

The existing commands (`submit_goal`, `steer`, `interrupt`, `compact`, `clear`, `switch_model`, `quit`) remain unchanged.

## Component Architecture

```
web/src/
  main.tsx                          Entry point
  App.tsx                           Root layout (status bar + sidebar + conversation + input)
  themes.css                        Theme definitions (CSS custom properties)

  providers/
    WebSocketProvider.tsx            Connection state + send function
    EventProvider.tsx                Event stream + derived session status
    AgentTreeProvider.tsx            Tree state + selection + filtering

  components/
    layout/
      StatusBar.tsx                  Top bar: context, cost, turns, model, controls
      Sidebar.tsx                    Responsive sidebar shell
      SidebarAgentTree.tsx           Agent tree view (running state)
      SidebarSessionSummary.tsx      Session summary view (idle state)

    conversation/
      ConversationView.tsx           Scrollable event list with auto-scroll
      Breadcrumb.tsx                 Agent filter path (root > editor > ...)
      MessageGroup.tsx               Groups consecutive same-agent messages
      UserMessage.tsx                User goal / steering messages
      AgentMessage.tsx               Plan output with markdown rendering
      DelegationBlock.tsx            Sub-agent block with inline preview + thread link
      SystemMessage.tsx              Centered pill for warnings, errors, compaction
      TypingIndicator.tsx            Three-dot streaming indicator
      StreamingBanner.tsx            Fixed banner: "agent is responding..."

    tools/
      ToolCall.tsx                   Expand/collapse shell for all tool renders
      ToolRendererRegistry.ts        Maps tool names to renderer components
      ReadFileRenderer.tsx           File preview with syntax highlighting
      EditFileRenderer.tsx           Unified diff view
      WriteFileRenderer.tsx          File content preview
      ExecRenderer.tsx               Terminal-styled output
      SearchRenderer.tsx             Results list
      FallbackRenderer.tsx           Formatted JSON

    input/
      InputArea.tsx                  Auto-resize textarea with history
      SlashCommandHandler.ts         Parse and execute slash commands

    shared/
      MarkdownBlock.tsx              GFM markdown → sanitized HTML
      CodeBlock.tsx                  Syntax-highlighted code with copy button
      Modal.tsx                      Portal-based modal with focus trap
      Badge.tsx                      Status/label badges
      ProgressBar.tsx                Context pressure and similar meters

  styles/
    themes.css                       All theme variable definitions
    global.css                       Reset, base typography, scrollbar styling
    animations.css                   Shared keyframes and transitions
    *.module.css                     Per-component scoped styles
```

## What This Does Not Do (Scope Limits)

- No multi-session support (one session per server instance)
- No authentication (localhost only)
- No file browser panel
- No session replay / playback
- No persistent preferences beyond localStorage
- No mobile-optimized layout beyond responsive sidebar collapse
- No tool approval modal (Sprout does not currently have tool approvals)
- No genome editor or memory browser

These are future work. The redesign focuses on making the core experience — threaded conversations with rich rendering — excellent.
