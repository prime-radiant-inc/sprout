# Static Rendering Architecture Implementation Plan

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

**Goal:** Eliminate scrollback re-rendering by using Ink's `<Static>` component for completed conversation events, keeping the dynamic render area tiny (streaming + status + input).

**Architecture:** Split ConversationView into two zones: (1) a `<Static>` zone for committed/completed events that are written once to terminal scrollback and never re-rendered, and (2) a small dynamic zone for the currently-streaming event plus scroll indicators. Add a `useWindowSize` hook so layout responds to terminal resize (SIGWINCH). Isolate InputArea state so keystrokes don't trigger re-renders of the conversation.

**Tech Stack:** Ink 6.8.0, React 19, `<Static>` component, `useStdout()` + `stdout.on('resize')` for dimensions.

---

### Overview

Current architecture: every `SessionEvent` becomes a `Line` in a single React state array. The entire visible slice is rendered inside a `<Box>` every frame. Typing, status updates, or new events cause Ink to erase and redraw the full output including all visible conversation history.

New architecture:
```
<Static items={committedLines}>     ← written once, never re-rendered
  {(line) => <Box key={...}>{line.node}</Box>}
</Static>
<Box flexDirection="column">        ← dynamic: only this re-renders
  {activeLine}                      ← current streaming event (if any)
  {scrollIndicator}                 ← "-- SCROLL --" when scrolled up
  <StatusBar />
  <InputArea />
</Box>
```

Key insight: `<Static>` items are permanently rendered to the terminal above the dynamic area. They are never part of Ink's redraw loop. This means the dynamic render area is only ~5-10 lines regardless of conversation length.

**Scrolling caveat:** With `<Static>`, we lose programmatic scroll (PgUp/PgDown) over committed lines since they're now part of terminal native scrollback. The user scrolls native scrollback with their terminal. We keep PgUp/PgDown only for the active/recent lines buffer if needed, or remove it entirely.

---

### Task 1: Add `useWindowSize` hook

A custom hook that returns `{ columns, rows }` and re-renders on terminal resize. Ink 6.8.0 doesn't export `useWindowSize`, so we build it using `useStdout()` + `stdout.on('resize')` (same pattern as lace).

**Files:**
- Create: `src/tui/use-window-size.ts`
- Test: `test/tui/use-window-size.test.tsx`

**Step 1: Write the failing test**

```tsx
// test/tui/use-window-size.test.tsx
import { describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { useWindowSize } from "../../src/tui/use-window-size.ts";

function SizeDisplay() {
  const { columns, rows } = useWindowSize();
  return <Text>{columns}x{rows}</Text>;
}

describe("useWindowSize", () => {
  test("returns stdout dimensions", () => {
    const { lastFrame } = render(<SizeDisplay />);
    const frame = lastFrame()!;
    // ink-testing-library uses a default size; just verify format
    expect(frame).toMatch(/\d+x\d+/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/tui/use-window-size.test.tsx`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/tui/use-window-size.ts
import { useStdout } from "ink";
import { useEffect, useState } from "react";

export function useWindowSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const handler = () => {
      setSize({ columns: stdout.columns, rows: stdout.rows });
    };
    stdout.on("resize", handler);
    return () => { stdout.off("resize", handler); };
  }, [stdout]);

  return size;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/tui/use-window-size.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tui/use-window-size.ts test/tui/use-window-size.test.tsx
git commit -m "feat(tui): add useWindowSize hook with SIGWINCH support"
```

---

### Task 2: Wire `useWindowSize` into App and StatusBar

Replace `useStdout()` dimension reads with `useWindowSize()` so the layout reflows on terminal resize.

**Files:**
- Modify: `src/tui/app.tsx` (lines 1, 58-60)
- Modify: `src/tui/status-bar.tsx` (lines 1, 43-44)
- Test: existing `test/tui/app.test.tsx` and `test/tui/status-bar.test.tsx` must still pass

**Step 1: Write the failing test**

No new test needed — the existing tests verify layout behavior. The change is swapping the dimension source. But we should verify it compiles and existing tests pass.

**Step 2: Update app.tsx**

Replace:
```tsx
const { stdout } = useStdout();
const terminalRows = stdout?.rows ?? 40;
```

With:
```tsx
const { rows: terminalRows } = useWindowSize();
```

Import `useWindowSize` from `./use-window-size.ts`, remove `useStdout` import if no longer needed.

**Step 3: Update status-bar.tsx**

Replace:
```tsx
const { stdout } = useStdout();
const cols = stdout?.columns ?? 100;
```

With:
```tsx
const { columns: cols } = useWindowSize();
```

Import `useWindowSize`, remove `useStdout` import.

**Step 4: Run tests to verify they pass**

Run: `bun test test/tui/app.test.tsx test/tui/status-bar.test.tsx`
Expected: All existing tests PASS

**Step 5: Commit**

```bash
git add src/tui/app.tsx src/tui/status-bar.tsx
git commit -m "refactor(tui): use useWindowSize for resize-responsive layout"
```

---

### Task 3: Split ConversationView into Static + Dynamic zones

The core change. ConversationView currently maintains a single `lines` array and renders a viewport slice. We split this into:
- `committedLines`: completed events → rendered via `<Static>` (write-once)
- `activeLine`: the currently-streaming assistant response (if any) → rendered in dynamic area

An event is "committed" as soon as it's received — every event goes straight to `<Static>`. The only exception is if we want to show a live-updating streaming line, but currently serf's events are discrete (each `plan_end` is a complete response), so ALL events are immediately committable.

**Files:**
- Modify: `src/tui/conversation-view.tsx` (major rewrite)
- Test: `test/tui/conversation-view.test.tsx` (update tests for new behavior)

**Step 1: Write the failing test for Static rendering**

Add a test that verifies events are rendered via Static (they appear in output and are stable):

```tsx
test("renders events via Static (write-once)", async () => {
  const bus = new EventBus();
  const { lastFrame } = render(<ConversationView bus={bus} />);

  bus.emitEvent("warning", "cli", 0, { message: "committed-line" });
  await flush();

  expect(lastFrame()).toContain("committed-line");
});
```

This test should pass with both old and new implementations. The key difference is behavioral — with `<Static>`, the items are written once above the dynamic area.

**Step 2: Run test to verify baseline**

Run: `bun test test/tui/conversation-view.test.tsx`
Expected: All tests PASS (baseline before refactor)

**Step 3: Rewrite ConversationView**

```tsx
// src/tui/conversation-view.tsx
import { Box, Static, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { SessionBus } from "../host/event-bus.ts";
import type { EventKind, SessionEvent } from "../kernel/types.ts";
import { renderEventComponent } from "./event-components.tsx";

interface StaticLine {
  id: number;
  node: ReactNode;
}

export interface ConversationViewProps {
  bus: SessionBus;
  /** Maximum height is no longer used for viewport slicing (Static handles scrollback).
   *  Kept for API compatibility but ignored. */
  maxHeight?: number;
  /** Historical events to display before new events (for resume). */
  initialEvents?: SessionEvent[];
}

/** Build a key for matching start/end event pairs for duration tracking. */
function durationKey(event: SessionEvent): string | null {
  const { kind, agent_id, data } = event;
  switch (kind) {
    case "plan_start":
    case "plan_end":
      return `${agent_id}:plan`;
    case "primitive_start":
    case "primitive_end":
      return `${agent_id}:primitive:${data.name}`;
    case "act_start":
    case "act_end":
      return `${agent_id}:act:${data.agent_name}`;
    default:
      return null;
  }
}

/** Track start times and compute duration for end events. */
function trackDuration(event: SessionEvent, startTimes: Map<string, number>): number | null {
  const key = durationKey(event);
  if (!key) return null;
  const isEnd = event.kind.endsWith("_end");
  if (!isEnd) {
    startTimes.set(key, event.timestamp);
    return null;
  }
  const startTime = startTimes.get(key);
  startTimes.delete(key);
  return startTime != null ? event.timestamp - startTime : null;
}

const TOOL_DETAIL_KINDS: Set<EventKind> = new Set([
  "primitive_start",
  "primitive_end",
  "act_start",
  "act_end",
]);

export function ConversationView({ bus, initialEvents }: ConversationViewProps) {
  const nextId = useRef(0);
  const startTimes = useRef(new Map<string, number>());
  const [toolsCollapsed, setToolsCollapsed] = useState(false);

  const [committedLines, setCommittedLines] = useState<StaticLine[]>(() => {
    if (!initialEvents) return [];
    const initial: StaticLine[] = [];
    for (const event of initialEvents) {
      const durationMs = trackDuration(event, startTimes.current);
      const node = renderEventComponent(event, durationMs);
      if (node !== null) {
        if (!toolsCollapsed || !TOOL_DETAIL_KINDS.has(event.kind)) {
          initial.push({ id: nextId.current++, node });
        }
      }
    }
    return initial;
  });

  useEffect(() => {
    return bus.onEvent((event: SessionEvent) => {
      if (event.kind === "session_clear") {
        // Static items can't be un-rendered, but we stop adding new ones.
        // The session_clear visual break is shown as a new committed line.
        const node = renderEventComponent(event, null);
        if (node !== null) {
          const id = nextId.current++;
          setCommittedLines((prev) => [...prev, { id, node }]);
        }
        startTimes.current.clear();
        return;
      }
      if (event.kind === "exit_hint") return;

      const durationMs = trackDuration(event, startTimes.current);
      const node = renderEventComponent(event, durationMs);
      if (node !== null) {
        if (!toolsCollapsed || !TOOL_DETAIL_KINDS.has(event.kind)) {
          const id = nextId.current++;
          setCommittedLines((prev) => [...prev, { id, node }]);
        }
      }
    });
  }, [bus, toolsCollapsed]);

  useInput((_input, key) => {
    if (key.tab) {
      setToolsCollapsed((prev) => !prev);
    }
  });

  return (
    <>
      <Static items={committedLines}>
        {(line) => <Box key={line.id}>{line.node}</Box>}
      </Static>
    </>
  );
}
```

**Important behavioral changes:**
- No more `maxHeight` viewport slicing — `<Static>` handles scrollback natively
- No more PgUp/PgDown scroll — terminal native scrollback replaces it
- `session_clear` can't un-render Static items, but adds a visual separator
- Tool collapse (`Tab`) applies only to events received after the toggle (Static items are immutable)

**Step 4: Update tests**

Several tests need updating:
- Remove tests for `maxHeight` viewport slicing (no longer applicable)
- Remove tests for PgUp/PgDown scroll (terminal native scrollback)
- Keep tests for: event rendering, ordering, initialEvents, tool collapse, session_clear, duration tracking, depth borders
- The `session_clear` test changes behavior — it can't remove Static items, but the session_clear event itself renders

**Step 5: Run tests**

Run: `bun test test/tui/conversation-view.test.tsx`
Expected: Updated tests PASS

**Step 6: Commit**

```bash
git add src/tui/conversation-view.tsx test/tui/conversation-view.test.tsx
git commit -m "feat(tui): use Static for write-once conversation rendering

Events are immediately committed to Ink's <Static> zone, written once
to terminal scrollback, and never re-rendered. This eliminates the
primary rendering bottleneck where all visible conversation lines were
redrawn on every state change.

Removes programmatic PgUp/PgDown scrolling in favor of terminal native
scrollback."
```

---

### Task 4: Simplify App layout (remove maxHeight calculation)

With `<Static>` handling conversation output, the App no longer needs to compute `conversationHeight` based on terminal rows. The dynamic area auto-sizes to its content (status bar + input).

**Files:**
- Modify: `src/tui/app.tsx`
- Test: `test/tui/app.test.tsx` (remove maxHeight-dependent tests)

**Step 1: Update app.tsx**

Remove the `conversationHeight` calculation and `maxHeight` prop:

```tsx
// Before:
const { rows: terminalRows } = useWindowSize();
const conversationHeight = Math.max(5, terminalRows - 4);
// ...
<ConversationView bus={bus} maxHeight={conversationHeight} initialEvents={initialEvents} />

// After:
<ConversationView bus={bus} initialEvents={initialEvents} />
```

If `useWindowSize` is no longer used in app.tsx after this, remove the import (StatusBar still uses it).

**Step 2: Update app.test.tsx**

The test "caps visible conversation lines via maxHeight" should be removed — this behavior no longer exists.

**Step 3: Run tests**

Run: `bun test test/tui/app.test.tsx`
Expected: All remaining tests PASS

**Step 4: Commit**

```bash
git add src/tui/app.tsx test/tui/app.test.tsx
git commit -m "refactor(tui): remove maxHeight calculation from App

ConversationView now uses <Static> for write-once rendering, so viewport
height calculation is no longer needed."
```

---

### Task 5: Remove unused `ink-multiline-input` dependency

This dependency is declared in package.json but never imported anywhere.

**Files:**
- Modify: `package.json`

**Step 1: Verify it's unused**

Run: `grep -r "ink-multiline-input" src/`
Expected: No matches

**Step 2: Remove from package.json**

Remove the `"ink-multiline-input": "^0.1.0"` line from dependencies.

**Step 3: Run install and tests**

Run: `bun install && bun test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: remove unused ink-multiline-input dependency"
```

---

### Task 6: Verify full test suite and manual test

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS, 0 failures

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

**Step 3: Manual test**

Run: `bun src/host/cli.ts`

Verify:
- Events appear as they arrive (committed to scrollback)
- Typing does NOT cause scrollback to flicker/re-render
- Terminal resize (drag window edge) causes status bar to reflow
- Tab still toggles tool detail visibility (for new events)
- Ctrl+C two-stage exit still works
- `/model` picker still works
- Session resume (`--resume`) shows prior events

**Step 4: Commit any fixes from manual testing**

---

## Notes

### What we're giving up
- **Programmatic scroll (PgUp/PgDown):** Users now use terminal native scrollback instead. This is standard behavior for CLIs.
- **Tool collapse for past events:** `Tab` toggle only affects events received after the toggle. Static items are immutable. This is a reasonable trade-off — if we need retroactive collapse, we'd need a different approach.

### What we gain
- **No scrollback re-rendering:** The biggest win. Typing, status updates, and new events only redraw the tiny dynamic area (~5 lines).
- **SIGWINCH support:** Layout responds to terminal resize.
- **Simpler code:** No viewport slicing, no scroll offset tracking.

### Future improvements (not in this plan)
- Streaming line: if we add token-by-token streaming display, the streaming line would live in the dynamic area (not Static) until the response completes, then commit to Static.
- `React.memo` on event components: if Static commit causes a flash, memoize the component rendering.
- Component isolation: ensure InputArea state changes don't trigger ConversationView re-renders (they shouldn't with Static, but verify).
