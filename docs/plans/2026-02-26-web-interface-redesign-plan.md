# Web Interface Redesign — Implementation Plan

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the terminal-reproduction web UI with a threaded conversation interface featuring rich tool renderers, an adaptive sidebar, full theming, and session controls.

**Architecture:** Reuse the existing hooks (useWebSocket, useEvents, useAgentTree) and server (src/web/server.ts) unchanged. Replace all components and styles. Add a theme system via CSS custom properties. Adapt rendering patterns from Lace's web UI (message grouping, tool renderers, sidebar, animations).

**Tech Stack:** React 19, Vite, CSS Modules, marked + DOMPurify, CSS custom properties for theming. No new dependencies unless noted per task.

**Reference files:**
- Design doc: `docs/plans/2026-02-26-web-interface-redesign.md`
- Lace sidebar: `~/git/lace/packages/web/components/layout/Sidebar.tsx`
- Lace timeline: `~/git/lace/packages/web/components/timeline/TimelineMessage.tsx`
- Lace tool renderers: `~/git/lace/packages/web/components/timeline/tool/`
- Lace input: `~/git/lace/packages/web/components/chat/ChatInput.tsx`
- Lace animations: `~/git/lace/packages/web/lib/animations.ts`
- Lace globals: `~/git/lace/packages/web/app/globals.css`

**Existing code to keep unchanged:**
- `web/src/hooks/useWebSocket.ts` (and its test)
- `web/src/hooks/useEvents.ts` (and its test)
- `web/src/hooks/useAgentTree.ts` (and its test)
- `web/src/components/format.ts`
- `src/web/server.ts`
- `src/web/protocol.ts`
- `src/host/event-bus.ts`

**Test pattern:** Tests use `renderToStaticMarkup` from `react-dom/server` and `bun:test`. Run with `bun test web/src/`. See `web/src/components/__tests__/components.test.tsx` for the established pattern.

---

## Phase 1: Theme Foundation

### Task 1: Create the theme token system

Replace `web/src/styles/variables.css` with a theme-based CSS custom property system.

**Files:**
- Create: `web/src/styles/themes.css`
- Delete contents of: `web/src/styles/variables.css` (import themes.css instead)

**Step 1: Write themes.css**

Create `web/src/styles/themes.css` with a `[data-theme="light"]` block defining all tokens. Study the design doc's "Token Categories" section for the complete list. Include:

- Surface tokens: `--color-canvas`, `--color-surface`, `--color-elevated`, `--color-inset`
- Text tokens: `--color-text-primary`, `--color-text-secondary`, `--color-text-tertiary`, `--color-text-placeholder`
- Border tokens: `--color-border`, `--color-border-strong`
- Shadow tokens: `--shadow-sm`, `--shadow-md`, `--shadow-lg`
- Accent tokens: `--color-accent`, `--color-accent-hover`, `--color-accent-subtle`
- Semantic tokens: `--color-success`, `--color-warning`, `--color-error`, `--color-info`
- Agent status tokens: `--color-running`, `--color-completed`, `--color-failed`
- Typography tokens: `--font-ui`, `--font-mono`, `--font-size-base` (15px), `--font-size-sm` (13px), `--font-size-xs` (12px), `--font-size-xxs` (11px), `--line-height` (1.5)
- Spacing tokens: `--space-xs` (4px), `--space-sm` (8px), `--space-md` (16px), `--space-lg` (24px), `--space-xl` (32px)
- Radius tokens: `--radius-sm` (6px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-full` (9999px)

Use warm, friendly light colors: off-white canvas (#fafafa), white surfaces, soft purple accent (#8b5cf6). Reference Lace's color system for inspiration but pick values that feel warm and approachable.

Also add a `[data-theme="dark"]` block with equivalent dark values (deep charcoal backgrounds, lighter text). The dark theme doesn't need to be perfect — it just needs to exist so the system is proven.

**Step 2: Update variables.css**

Replace the contents of `web/src/styles/variables.css` with a single `@import "./themes.css";` and move any non-theme layout constants (sidebar-width, statusbar-height, etc.) into the same file as plain `:root` variables.

**Step 3: Update global.css**

Update `web/src/styles/global.css` to reference the new tokens. Replace hardcoded colors with `var(--color-*)` references. Update the body background to `var(--color-canvas)`, text color to `var(--color-text-primary)`, scrollbar colors, selection colors.

**Step 4: Update index.html**

Add `data-theme="light"` to the `<html>` element in `web/index.html`.

**Step 5: Run tests**

Run: `bun test web/src/`
Expected: All existing tests pass. Theme changes are CSS-only and don't affect `renderToStaticMarkup` output.

**Step 6: Commit**

```bash
git add web/src/styles/ web/index.html
git commit -m "feat(web): add CSS custom property theme system with light and dark themes"
```

---

## Phase 2: Core Layout Restructure

### Task 2: Rewrite App.tsx with new layout

Replace the current App layout with the redesigned three-region structure: status bar (top), sidebar + conversation (middle), input (bottom).

**Files:**
- Rewrite: `web/src/App.tsx`
- Rewrite: `web/src/styles/App.module.css`

**Step 1: Write the failing test**

Add a test in `web/src/components/__tests__/components.test.tsx` that renders `App` (or a simplified version) and asserts the presence of key structural elements: a status bar region, a sidebar region, a conversation region, and an input region. Use data attributes (e.g., `data-region="status-bar"`, `data-region="sidebar"`) for testability.

Note: `App` currently calls hooks that need WebSocket. For the structural test, you may need to mock the WebSocket URL or test a layout sub-component. Consider extracting a `Layout` component that accepts props instead of calling hooks directly — this makes it testable via `renderToStaticMarkup`.

**Step 2: Run test to verify it fails**

Run: `bun test web/src/`
Expected: FAIL — new assertions don't match current markup.

**Step 3: Rewrite App.tsx**

Restructure the layout:

```
<div data-region="app">
  <StatusBar ... />                           <!-- top -->
  <div data-region="body">
    <Sidebar ... />                            <!-- left -->
    <main data-region="conversation">
      <Breadcrumb ... />
      <ConversationView ... />
      <ScrollToBottom ... />
    </main>
  </div>
  <InputArea ... />                            <!-- bottom -->
</div>
```

Keep the existing hook calls (useWebSocket, useEvents, useAgentTree) and state logic. Change only the JSX structure and how props flow to children.

Move the header content (logo, model, session ID) into the StatusBar component — there is no longer a separate header.

**Step 4: Rewrite App.module.css**

New layout CSS using CSS Grid:

```css
.app {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100vh;
  background: var(--color-canvas);
  color: var(--color-text-primary);
  font-family: var(--font-ui);
  font-size: var(--font-size-base);
}

.body {
  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  overflow: hidden;
}

.conversation {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  position: relative;
}
```

Add responsive behavior: at `max-width: 768px`, hide sidebar by default and show it as an overlay.

**Step 5: Run tests**

Run: `bun test web/src/`
Expected: All tests pass including the new structural test.

**Step 6: Commit**

```bash
git add web/src/App.tsx web/src/styles/App.module.css web/src/components/__tests__/
git commit -m "feat(web): restructure layout with status bar, sidebar, conversation regions"
```

---

### Task 3: Redesign the StatusBar

Move from a bottom status strip to a top command bar with context pressure, cost, model selector, and session controls.

**Files:**
- Rewrite: `web/src/components/StatusBar.tsx`
- Rewrite: `web/src/styles/StatusBar.module.css`
- Modify: `web/src/components/__tests__/input-status.test.tsx`

**Step 1: Update StatusBar props**

The StatusBar now needs additional props beyond `status` and `connected`:

```typescript
interface StatusBarProps {
  status: SessionStatus;
  connected: boolean;
  onInterrupt: () => void;
  onSwitchModel?: (model: string) => void;
}
```

**Step 2: Update tests**

Update `web/src/components/__tests__/input-status.test.tsx` StatusBar tests:
- Keep existing tests for context tokens, turns, model name, session ID, connection dot
- Add test: renders cost display (will need `costUsd` added to SessionStatus — for now test with `$0.00` default)
- Add test: renders pause/stop buttons when running
- Add test: does not render pause/stop buttons when idle
- Add test: renders context pressure bar element

**Step 3: Run tests to verify failures**

Run: `bun test web/src/`
Expected: New tests fail.

**Step 4: Implement StatusBar**

Rewrite the component. Layout: single row, flexbox with space-between.

Left group: context pressure (mini bar + text), turn count, cost.
Right group: model name (with dropdown trigger if onSwitchModel provided), pause button, stop button, connection dot.

Use themed CSS: backgrounds use `var(--color-surface)`, text uses `var(--color-text-secondary)`, accent for active states. The context pressure bar should shift color from `var(--color-success)` → `var(--color-warning)` → `var(--color-error)` based on percentage thresholds (0-60% green, 60-85% yellow, 85%+ red).

Pause and stop buttons emit `onInterrupt` when clicked. Style them as small icon buttons with `var(--color-text-tertiary)` default, `var(--color-error)` on hover.

**Step 5: Style StatusBar.module.css**

Themed styles. Height: 40px. Border-bottom: `1px solid var(--color-border)`. Background: `var(--color-surface)`. All colors reference theme tokens.

**Step 6: Run tests**

Run: `bun test web/src/`
Expected: All pass.

**Step 7: Commit**

```bash
git add web/src/components/StatusBar.tsx web/src/styles/StatusBar.module.css web/src/components/__tests__/
git commit -m "feat(web): redesign StatusBar as top command bar with controls"
```

---

### Task 4: Redesign the Sidebar with adaptive content

Replace the current AgentTree sidebar with an adaptive sidebar that shows the agent tree while running and a session summary while idle.

**Files:**
- Create: `web/src/components/Sidebar.tsx` (new shell component)
- Create: `web/src/styles/Sidebar.module.css`
- Create: `web/src/components/SidebarSessionSummary.tsx`
- Create: `web/src/styles/SidebarSessionSummary.module.css`
- Modify: `web/src/components/AgentTree.tsx` (keep logic, restyle)
- Modify: `web/src/styles/AgentTree.module.css` (retheme)
- Create: `web/src/components/__tests__/sidebar.test.tsx`

**Step 1: Write tests for the Sidebar shell**

In `web/src/components/__tests__/sidebar.test.tsx`:
- Test: renders agent tree when status is "running"
- Test: renders session summary when status is "idle"
- Test: sidebar has data-collapsed attribute for responsive behavior
- Test: renders toggle button

**Step 2: Write tests for SidebarSessionSummary**

In the same test file:
- Test: renders cost display
- Test: renders turn count
- Test: renders model name
- Test: renders session duration (if available)

**Step 3: Run tests to verify failures**

Run: `bun test web/src/`

**Step 4: Implement Sidebar.tsx**

The shell component that conditionally renders AgentTree or SidebarSessionSummary based on session status. Props:

```typescript
interface SidebarProps {
  status: SessionStatus;
  tree: AgentTreeNode;
  selectedAgent: string | null;
  onSelectAgent: (agentId: string | null) => void;
  collapsed: boolean;
  onToggle: () => void;
  events: SessionEvent[];  // for session summary computation
}
```

Responsive: at narrow widths, render as an overlay with backdrop (study Lace's Sidebar.tsx for the pattern). On desktop, render inline with collapsible width.

**Step 5: Implement SidebarSessionSummary.tsx**

Shows: total cost, total turns, model, duration, files touched (derived from primitive_end events where name is edit_file/write_file/read_file — extract unique file paths).

**Step 6: Restyle AgentTree**

Update `AgentTree.module.css` to use theme tokens. Replace hardcoded colors with `var(--color-*)`. Keep the existing tree logic and pulse animation but use `var(--color-running)` for the pulse color.

**Step 7: Run tests**

Run: `bun test web/src/`
Expected: All pass.

**Step 8: Commit**

```bash
git add web/src/components/Sidebar.tsx web/src/components/SidebarSessionSummary.tsx web/src/components/AgentTree.tsx web/src/styles/ web/src/components/__tests__/
git commit -m "feat(web): adaptive sidebar with agent tree and session summary"
```

---

### Task 5: Redesign the InputArea

Restyle the input area with themed colors, a Send/Stop toggle button, and cleaner layout.

**Files:**
- Rewrite: `web/src/components/InputArea.tsx`
- Rewrite: `web/src/styles/InputArea.module.css`
- Modify: `web/src/components/__tests__/input-status.test.tsx`

**Step 1: Update tests**

Update InputArea tests:
- Keep existing tests (textarea present, button present, steering label, placeholder)
- Add test: renders Send button text/icon when idle
- Add test: renders Stop button text/icon when running
- Add test: stop button has error/warning color styling indicator
- Remove tests for the old `>` prompt indicator (we're removing the terminal-style prompt)

**Step 2: Run tests to verify failures**

Run: `bun test web/src/`

**Step 3: Implement InputArea**

Restyle:
- Remove the terminal-style `>` prompt character
- Textarea: `var(--color-inset)` background, `var(--color-border)` border, `var(--radius-md)` corners
- Send button: `var(--color-accent)` background, white text. Transforms to Stop button (red background) when `isRunning` is true.
- Placeholder: "What should I work on?" when idle, "Steer the agent..." when running
- Keep all existing logic: auto-resize, Enter/Shift+Enter, slash commands, history

**Step 4: Style InputArea.module.css**

Themed styles. Padding: `var(--space-sm) var(--space-md)`. Border-top: `1px solid var(--color-border)`. Background: `var(--color-surface)`.

**Step 5: Run tests**

Run: `bun test web/src/`
Expected: All pass.

**Step 6: Commit**

```bash
git add web/src/components/InputArea.tsx web/src/styles/InputArea.module.css web/src/components/__tests__/
git commit -m "feat(web): redesign InputArea with themed styling and Send/Stop toggle"
```

---

## Phase 3: Message Rendering

### Task 6: Implement message grouping logic

Add a `groupEvents` function that groups consecutive events from the same agent, inserting group boundaries when the agent changes, a tool call or delegation intervenes, or >60s passes.

**Files:**
- Create: `web/src/components/groupEvents.ts`
- Create: `web/src/components/__tests__/groupEvents.test.ts`

**Step 1: Write tests**

```typescript
// Test: groups consecutive plan_end events from same agent
// Test: breaks group on agent_id change
// Test: breaks group when tool call intervenes between plan_end events
// Test: breaks group when >60s gap between events
// Test: returns isFirstInGroup and isLastInGroup flags on each item
// Test: non-groupable events (tool calls, delegations, system) are always standalone
```

Each test should create arrays of SessionEvent objects and verify the grouping output.

**Step 2: Run tests to verify failures**

Run: `bun test web/src/`

**Step 3: Implement groupEvents.ts**

```typescript
interface GroupedEvent {
  event: SessionEvent;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  durationMs: number | null;
  streamingText?: string;
}

function groupEvents(events: SessionEvent[], agentFilter?: string, tree?: AgentTreeNode): GroupedEvent[]
```

This function replaces the inline `resolveEvents` logic currently in ConversationView.tsx. It should:
1. Filter by agent (if agentFilter provided) using getDescendantIds
2. Pair start/end events for duration tracking (existing logic)
3. Accumulate plan_delta text (existing logic)
4. Add grouping metadata: consecutive plan_end or perceive events from the same agent_id are grouped

**Step 4: Run tests**

Run: `bun test web/src/`
Expected: All pass.

**Step 5: Commit**

```bash
git add web/src/components/groupEvents.ts web/src/components/__tests__/groupEvents.test.ts
git commit -m "feat(web): add message grouping logic for conversation view"
```

---

### Task 7: Redesign UserMessage

Replace the terminal-style `>` prompt with a proper message bubble with avatar and timestamp.

**Files:**
- Rewrite: `web/src/components/UserMessage.tsx`
- Rewrite: `web/src/styles/UserMessage.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Update tests**

Update UserMessage tests:
- Test: renders user text content
- Test: renders "You" label when isFirstInGroup is true
- Test: does not render header when isFirstInGroup is false
- Test: renders steering badge when isSteering is true
- Test: renders timestamp when provided
- Remove: test for `>` prompt indicator

**Step 2: Run to verify failures**

Run: `bun test web/src/`

**Step 3: Implement UserMessage**

New props:

```typescript
interface UserMessageProps {
  text: string;
  isSteering?: boolean;
  isFirstInGroup?: boolean;
  timestamp?: number;
}
```

Render: left-aligned message. When `isFirstInGroup`, show a header row with user icon + "You" + formatted timestamp. Below the header (or directly if not first): message text in a subtle accent-tinted card (`var(--color-accent-subtle)` background). Steering messages get a small "steering" badge.

**Step 4: Style with theme tokens**

UserMessage.module.css: all colors from theme tokens. The accent background uses `var(--color-accent-subtle)`. Text uses `var(--color-text-primary)`. Badge uses `var(--color-accent)` with white text.

**Step 5: Run tests**

Run: `bun test web/src/`
Expected: All pass.

**Step 6: Commit**

```bash
git add web/src/components/UserMessage.tsx web/src/styles/UserMessage.module.css web/src/components/__tests__/
git commit -m "feat(web): redesign UserMessage with grouped headers and themed styling"
```

---

### Task 8: Redesign AssistantMessage

Replace the plain markdown block with a properly grouped agent message with avatar, name, and collapsible reasoning.

**Files:**
- Rewrite: `web/src/components/AssistantMessage.tsx`
- Rewrite: `web/src/styles/AssistantMessage.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Update tests**

- Test: renders markdown text via MarkdownBlock
- Test: renders agent name header when isFirstInGroup
- Test: does not render header when not isFirstInGroup
- Test: renders reasoning in collapsible details
- Test: renders without reasoning when none provided
- Test: renders timestamp when provided

**Step 2: Run to verify failures**

**Step 3: Implement**

New props:

```typescript
interface AssistantMessageProps {
  text?: string;
  reasoning?: string;
  agentName?: string;
  isFirstInGroup?: boolean;
  timestamp?: number;
}
```

When `isFirstInGroup`: header row with agent icon + agent name + timestamp.
Body: MarkdownBlock for text. Collapsible `<details>` for reasoning (dimmer text, `var(--color-text-tertiary)`).

**Step 4: Style with theme tokens**

**Step 5: Run tests, commit**

```bash
git commit -m "feat(web): redesign AssistantMessage with grouped headers and themed styling"
```

---

### Task 9: Redesign ToolCall with expand/collapse and tool-type renderers

This is the biggest rendering change. Replace the current `<details>` + `<pre>` output with a compact collapsed line and type-specific expanded renderers.

**Files:**
- Rewrite: `web/src/components/ToolCall.tsx` (collapsed summary line + expand/collapse)
- Rewrite: `web/src/styles/ToolCall.module.css`
- Create: `web/src/components/tools/ToolRendererRegistry.ts`
- Create: `web/src/components/tools/ReadFileRenderer.tsx`
- Create: `web/src/components/tools/EditFileRenderer.tsx`
- Create: `web/src/components/tools/ExecRenderer.tsx`
- Create: `web/src/components/tools/FallbackRenderer.tsx`
- Create: `web/src/styles/tools.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Write tests**

Update ToolCall tests:
- Test: renders collapsed summary with tool name, smart args, status icon, duration
- Test: clicking expand reveals tool output
- Test: success shows green check icon
- Test: failure shows red X icon and error message

Add new tests for renderers:
- Test: ReadFileRenderer renders filename and line preview
- Test: EditFileRenderer renders diff-style output (green/red lines) when output contains +/- lines
- Test: ExecRenderer renders terminal-styled output with exit code
- Test: FallbackRenderer renders formatted JSON

**Step 2: Run to verify failures**

**Step 3: Implement ToolRendererRegistry**

```typescript
// Maps tool names to renderer components
interface ToolRendererProps {
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  success: boolean;
  error?: string;
}

const rendererMap: Record<string, React.ComponentType<ToolRendererProps>> = {
  read_file: ReadFileRenderer,
  edit_file: EditFileRenderer,
  write_file: ReadFileRenderer,  // reuse with different header
  exec: ExecRenderer,
  bash: ExecRenderer,
  // all others fall through to FallbackRenderer
};
```

**Step 4: Implement each renderer**

Study Lace's tool renderers at `~/git/lace/packages/web/components/timeline/tool/` for patterns. Adapt to our CSS Modules approach.

- **ReadFileRenderer**: Show filename, line count from args. Show first 10 lines of output as syntax-highlighted preview (use existing MarkdownBlock with a fenced code block).
- **EditFileRenderer**: Parse output for unified diff lines (starting with +/-). Render with green/red line backgrounds. Fall back to plain output if not a diff.
- **ExecRenderer**: Terminal-styled block. Monospace font. Show command from args at top. Output below. Non-zero exit codes highlighted. Study Lace's bash renderer.
- **FallbackRenderer**: Pretty-print args and output as formatted JSON in a code block.

**Step 5: Rewrite ToolCall.tsx**

Collapsed state: single line with `⚡` icon, tool name, smart args, status icon (✓/✗), duration. Entire line is clickable to toggle expansion.

Expanded state: render the appropriate renderer from the registry. Max-height with scroll. "Copy" button on hover.

Style with theme tokens: collapsed line has subtle `var(--color-border)` bottom border. Expanded area has `var(--color-inset)` background.

**Step 6: Run tests**

Run: `bun test web/src/`
Expected: All pass.

**Step 7: Commit**

```bash
git add web/src/components/ToolCall.tsx web/src/components/tools/ web/src/styles/ web/src/components/__tests__/
git commit -m "feat(web): tool-type-specific renderers with expand/collapse"
```

---

### Task 10: Redesign DelegationBlock with inline preview and thread navigation

Replace the bracket-style delegation markers with a rich block that shows a preview of sub-agent activity and offers "open thread" navigation.

**Files:**
- Rewrite: `web/src/components/DelegationBlock.tsx`
- Rewrite: `web/src/styles/DelegationBlock.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Update tests**

- Test: renders agent name and goal
- Test: renders status indicator (running/completed/failed)
- Test: renders inline preview of child events when provided
- Test: renders "open thread" link
- Test: completed delegation shows summary line (name + ✓ + turns + duration)
- Test: failed delegation shows error styling

**Step 2: Run to verify failures**

**Step 3: Implement**

New props:

```typescript
interface DelegationBlockProps {
  agentName: string;
  goal: string;
  status: "running" | "completed" | "failed";
  turns?: number;
  durationMs?: number;
  childPreview?: SessionEvent[];  // last 2-3 events from this agent
  onOpenThread?: () => void;
}
```

Rendering:
- A bordered card with left accent stripe (`var(--color-accent)` for running, `var(--color-completed)` for done, `var(--color-failed)` for error)
- Header: agent name + goal + status badge
- Body (when running or recently completed): compact preview of last 2-3 child events rendered as mini ToolCall/AssistantMessage lines
- Footer: "open thread →" link that calls `onOpenThread`
- When completed: can collapse to a single summary line (agent name + ✓ + turns + duration)

**Step 4: Style with theme tokens**

Card background: `var(--color-surface)`. Border: `var(--color-border)`. Left accent stripe: 3px solid. Rounded corners: `var(--radius-lg)`.

**Step 5: Run tests, commit**

```bash
git commit -m "feat(web): redesign DelegationBlock with inline preview and thread navigation"
```

---

### Task 11: Redesign SystemMessage

Replace the current three-variant system message with centered pill-shaped messages matching the Lace pattern.

**Files:**
- Rewrite: `web/src/components/SystemMessage.tsx`
- Rewrite: `web/src/styles/SystemMessage.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Update tests**

Keep the existing test assertions (warning shows warning content, error shows error content, compaction shows compaction content). Add:
- Test: system messages are centered (check for centering CSS class or wrapper)
- Test: warning has warning-colored indicator dot
- Test: error has error-colored indicator dot

**Step 2: Run to verify failures**

**Step 3: Implement**

Centered pill design (adapted from Lace's `LOCAL_SYSTEM_MESSAGE`):

```tsx
<div className={styles.wrapper}>
  <div className={styles.pill} data-kind={kind}>
    <span className={styles.dot} />
    <span className={styles.text}>{message}</span>
  </div>
</div>
```

Dot color: `var(--color-warning)` for warnings, `var(--color-error)` for errors, `var(--color-text-tertiary)` for info/dim messages.

**Step 4: Style**

```css
.wrapper { display: flex; justify-content: center; padding: var(--space-xs) 0; }
.pill {
  display: inline-flex; align-items: center; gap: var(--space-xs);
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-full); padding: var(--space-xs) var(--space-md);
  font-size: var(--font-size-xs); color: var(--color-text-tertiary);
}
.dot { width: 6px; height: 6px; border-radius: 50%; }
```

**Step 5: Run tests, commit**

```bash
git commit -m "feat(web): redesign SystemMessage as centered themed pills"
```

---

### Task 12: Redesign MarkdownBlock with themed code blocks

Restyle the markdown renderer to use theme tokens and add copy buttons to code blocks.

**Files:**
- Rewrite: `web/src/components/MarkdownBlock.tsx`
- Rewrite: `web/src/styles/MarkdownBlock.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Update tests**

Keep existing markdown rendering tests. Add:
- Test: code blocks have a copy button (check for button element inside code block wrapper)
- Test: inline code has distinct styling class

**Step 2: Implement**

Keep using `marked` + `DOMPurify`. Restyle the CSS to use theme tokens throughout:
- Headings: `var(--color-text-primary)`, appropriate sizes
- Code blocks: `var(--color-inset)` background, `var(--color-border)` border, `var(--radius-md)` corners, `var(--font-mono)` font
- Inline code: `var(--color-inset)` background, `var(--radius-sm)` corners
- Links: `var(--color-accent)` color
- Blockquotes: left border `var(--color-border-strong)`, italic
- Tables: `var(--color-border)` borders

For copy buttons on code blocks: since we use `dangerouslySetInnerHTML`, we can't easily add React buttons inside the rendered HTML. Two options:
(a) Post-process the rendered HTML to wrap `<pre>` blocks in a container div, then use a `useEffect` to attach click handlers
(b) Switch from dangerouslySetInnerHTML to a custom markdown renderer that outputs React components

Option (a) is simpler and preserves the existing architecture. Add a `useEffect` that finds all `pre > code` elements inside the markdown container and injects a copy button.

**Step 3: Run tests, commit**

```bash
git commit -m "feat(web): restyle MarkdownBlock with themed tokens and code copy buttons"
```

---

## Phase 4: Conversation Wiring

### Task 13: Rewrite ConversationView with grouping and new components

Wire everything together: use `groupEvents` to process events, render with the redesigned components, support message grouping and thread navigation.

**Files:**
- Rewrite: `web/src/components/ConversationView.tsx`
- Rewrite: `web/src/styles/ConversationView.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Update ConversationView tests**

Keep existing tests for:
- Renders a list of events
- Skips invisible events
- Tracks duration
- Filters by agentId
- Includes descendant events
- Empty state
- Accumulates plan_delta text
- Clears buffer on plan_end

Add:
- Test: groups consecutive plan_end messages from same agent (verify only first has header)
- Test: delegation blocks include child preview events

**Step 2: Run to verify failures**

**Step 3: Implement**

Replace the current inline `resolveEvents` with the `groupEvents` function from Task 6. Render using the new component props (isFirstInGroup, timestamp, agentName).

For delegation blocks: when rendering `act_start`, collect the last 2-3 events from that agent's children as `childPreview`. Pass `onOpenThread` callback that calls the parent's `onSelectAgent`.

Replace the `EventLine` dispatcher with updated mapping that passes grouping props:
- `perceive`/`steering` → `UserMessage` with `isFirstInGroup`, `timestamp`
- `plan_end` → `AssistantMessage` with `isFirstInGroup`, `agentName`, `timestamp`
- `plan_delta` → `AssistantMessage` (streaming)
- `primitive_end` → `ToolCall` (unchanged)
- `act_start` → `DelegationBlock` with childPreview and onOpenThread
- System events → `SystemMessage` (unchanged)

**Step 4: Style ConversationView**

Padding: `var(--space-md)`. Gap between items: `var(--space-sm)`. Background: `var(--color-canvas)`.

**Step 5: Run tests**

Run: `bun test web/src/`
Expected: All pass.

**Step 6: Commit**

```bash
git add web/src/components/ConversationView.tsx web/src/components/EventLine.tsx web/src/styles/
git commit -m "feat(web): wire ConversationView with message grouping and new components"
```

---

### Task 14: Redesign Breadcrumb with themed styling

**Files:**
- Rewrite: `web/src/components/Breadcrumb.tsx`
- Rewrite: `web/src/styles/Breadcrumb.module.css`

**Step 1: Restyle**

Keep the existing logic (find path from root to selected agent). Restyle with theme tokens:
- Background: `var(--color-surface)` with bottom border
- Segments: `var(--color-text-secondary)`, last segment `var(--color-text-primary)`
- Separator: `›` in `var(--color-text-tertiary)`
- Clickable segments: `var(--color-accent)` on hover
- Font size: `var(--font-size-sm)`

**Step 2: Run tests, commit**

```bash
git commit -m "feat(web): restyle Breadcrumb with theme tokens"
```

---

### Task 15: Add typing indicator and streaming banner

Add visual indicators for when the agent is actively generating a response.

**Files:**
- Create: `web/src/components/TypingIndicator.tsx`
- Create: `web/src/styles/TypingIndicator.module.css`
- Create: `web/src/components/StreamingBanner.tsx`
- Create: `web/src/styles/StreamingBanner.module.css`
- Modify: `web/src/components/ConversationView.tsx` (add typing indicator)
- Modify: `web/src/App.tsx` (add streaming banner)

**Step 1: Write tests**

- Test: TypingIndicator renders three animated dots
- Test: StreamingBanner renders agent name and "is responding" text
- Test: StreamingBanner renders stop button
- Test: ConversationView shows TypingIndicator when last event is plan_delta (streaming in progress)

**Step 2: Implement TypingIndicator**

Three dots with staggered CSS animation (adapted from Lace):

```tsx
<div className={styles.indicator}>
  <span className={styles.dot} style={{ animationDelay: '0ms' }} />
  <span className={styles.dot} style={{ animationDelay: '150ms' }} />
  <span className={styles.dot} style={{ animationDelay: '300ms' }} />
</div>
```

CSS: dots are 6px circles with `var(--color-accent)` background, bounce keyframe animation.

**Step 3: Implement StreamingBanner**

Fixed-position banner at top center of conversation area (adapted from Lace's streaming header):

```tsx
<div className={styles.banner}>
  <span className={styles.agentName}>{agentName}</span>
  <span className={styles.label}>is responding</span>
  <TypingIndicator />
</div>
```

Styled: `var(--color-surface)` background, `var(--shadow-md)` shadow, `var(--radius-full)` pill shape, small font.

**Step 4: Wire into ConversationView and App**

ConversationView: if the events end with a `plan_delta` (streaming), show TypingIndicator at the bottom of the list.

App: if status is "running" and there are recent plan_delta events, show StreamingBanner at the top of the conversation area.

**Step 5: Run tests, commit**

```bash
git commit -m "feat(web): add typing indicator and streaming banner"
```

---

## Phase 5: Integration & Polish

### Task 16: Add favicon status indicator

Change the browser tab favicon based on session state.

**Files:**
- Create: `web/src/hooks/useFaviconStatus.ts`
- Modify: `web/src/App.tsx` (call the hook)

**Step 1: Write test**

Test the hook logic (not DOM mutation): given a status string, it returns the correct favicon data URL or path.

**Step 2: Implement**

A hook that watches `status.status` and updates `document.querySelector('link[rel="icon"]')`:
- Idle: default favicon (sprout icon or neutral)
- Running: accent-colored favicon (purple dot or animated)
- Error: red favicon

Use canvas-generated data URLs for simple colored circles, or SVG data URLs. Keep it simple.

**Step 3: Commit**

```bash
git commit -m "feat(web): favicon reflects session status"
```

---

### Task 17: Add keyboard shortcuts

Wire up keyboard shortcuts for the new layout.

**Files:**
- Modify: `web/src/App.tsx`

**Step 1: Write test**

Test the keyboard handler function (extract it for testability):
- Test: Ctrl+/ toggles sidebar collapsed state
- Test: Escape clears agent filter when not in input
- Test: / focuses input when not already focused

**Step 2: Implement**

Update the existing keyboard handler in App.tsx. The current code already handles Ctrl+/ and Escape. Add the `/` shortcut to focus input.

**Step 3: Commit**

```bash
git commit -m "feat(web): add keyboard shortcuts for sidebar toggle and input focus"
```

---

### Task 18: Clean up old files and run full test suite

Remove any files that are no longer imported after the redesign.

**Files:**
- Audit all files in `web/src/` for unused imports and dead code

**Step 1: Check for orphaned files**

The old `EventLine.tsx` dispatcher may still be used or may have been replaced by inline logic in ConversationView. Check if it's still imported. If ConversationView now handles dispatch directly, consider whether EventLine still adds value as a separation layer. Keep it if it's clean; remove if it's dead code.

Check all CSS module files — any that aren't imported should be removed.

**Step 2: Run full test suite**

Run: `bun test web/src/`
Expected: All tests pass. No regressions.

**Step 3: Run the full project test suite**

Run: `bun test`
Expected: All 1170+ tests pass.

**Step 4: Manual smoke test**

Start the web server and verify in a browser:
- Layout renders correctly
- Theme applies (light theme visible)
- StatusBar shows context/cost/model
- Sidebar shows agent tree (or session summary when idle)
- Messages render with grouping
- Tool calls expand/collapse
- Delegation blocks show preview and "open thread" navigation
- Input works (submit goals, steering)
- Breadcrumb appears when filtering by agent
- Keyboard shortcuts work

**Step 5: Commit any cleanup**

```bash
git commit -m "chore(web): clean up unused files after redesign"
```

---

### Task 19: Final commit and verification

**Step 1: Run all tests one more time**

Run: `bun test`
Expected: All pass.

**Step 2: Review git diff**

Run: `git diff main --stat`
Verify the changes make sense — new files created, old style files replaced, hooks untouched.

**Step 3: Commit any remaining changes**

If there are uncommitted changes from polish or fixes during manual testing, commit them.

---

## Task Dependency Summary

```
Phase 1: [Task 1] (theme foundation)
              ↓
Phase 2: [Task 2] → [Task 3] → [Task 4] → [Task 5]
              ↓
Phase 3: [Task 6] → [Task 7, 8, 9, 10, 11, 12] (parallel — independent components)
              ↓
Phase 4: [Task 13] → [Task 14] → [Task 15]
              ↓
Phase 5: [Task 16, 17] (parallel) → [Task 18] → [Task 19]
```

Tasks within Phase 3 (individual component redesigns) can be done in any order or in parallel, since they don't depend on each other. They all depend on Task 6 (grouping logic) and Task 1 (theme tokens). Task 13 (ConversationView wiring) depends on all Phase 3 components being complete.
