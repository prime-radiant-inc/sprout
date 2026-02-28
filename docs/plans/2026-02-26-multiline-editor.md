# Multiline Text Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port lace's multiline text editor (useTextBuffer + TextRenderer + autocomplete infrastructure) into sprout, replacing the flat-string buffer model.

**Architecture:** Extract lace's text buffer logic as pure functions on a `TextBufferState` (lines array + 2D cursor + preferred column). Wrap in a thin React hook. Port TextRenderer for visual multi-line rendering with cursor overlay. Port simplified autocomplete component (not wired to file scanning yet). Rewrite InputArea to use new components while preserving sprout-specific behavior (history, Ctrl+C, slash commands, steer). Replace Tab tool-collapse toggle with `/collapse-tools` slash command.

**Tech Stack:** TypeScript, React, Ink 6.x, Bun runtime

**Key source references:**
- Lace useTextBuffer: `~/git/lace/src/interfaces/terminal/hooks/use-text-buffer.ts` (tag: `last-ink-tui`)
- Lace TextRenderer: `~/git/lace/src/interfaces/terminal/components/text-renderer.tsx`
- Lace FileAutocomplete: `~/git/lace/src/interfaces/terminal/components/file-autocomplete.tsx`
- Lace ShellInput: `~/git/lace/src/interfaces/terminal/components/shell-input.tsx`
- Sprout InputArea: `src/tui/input-area.tsx`
- Sprout buffer.ts: `src/tui/buffer.ts`

---

### Task 1: Pure text buffer functions

Port lace's `useTextBuffer` logic as **pure functions** on a `TextBufferState` record. This replaces sprout's flat-string `buffer.ts` with a lines-array model that supports 2D cursor positioning and preferred column memory.

**Files:**
- Create: `src/tui/text-buffer.ts`
- Test: `test/tui/text-buffer.test.ts`

The `TextBufferState` interface:

```ts
export interface TextBufferState {
  lines: string[];
  cursorLine: number;
  cursorColumn: number;
  preferredColumn: number;
}
```

Pure functions to implement (all return new `TextBufferState`):

| Function | Source | Notes |
|----------|--------|-------|
| `createBufferState(text?: string)` | New | Factory; splits on `\n`, cursor at 0,0 |
| `insertText(state, text)` | Lace `insertText` | Handles newlines, multi-line paste |
| `deleteChar(state, direction)` | Lace `deleteChar` | 'forward' / 'backward', line merging |
| `moveCursor(state, direction)` | Lace `moveCursor` | 'left'/'right'/'up'/'down'/'home'/'end'; up/down use `preferredColumn` |
| `setText(state, text)` | Lace `setText` | Replaces all content |
| `getText(state)` | Lace `getText` | Returns `lines.join('\n')` (returns string, not state) |
| `killLine(state)` | Lace `killLine` | Cursor to EOL (Ctrl+K) |
| `killLineBackward(state)` | Lace `killLineBackward` | SOL to cursor (Ctrl+U) |
| `killWordBackward(state)` | Sprout `buffer.ts` | Skip spaces then non-spaces, stop at newlines (Ctrl+W) |
| `isOnFirstLine(state)` | Sprout `buffer.ts` | Returns boolean |
| `isOnLastLine(state)` | Sprout `buffer.ts` | Returns boolean |

Port logic from lace's `use-text-buffer.ts` lines 69-316 for the main operations. Port `killWordBackward` from sprout's `buffer.ts:124-135`, adapting from flat-string to lines-array model.

**Step 1: Write failing tests**

Create `test/tui/text-buffer.test.ts`. Port test cases from:
- Lace: `~/git/lace/src/interfaces/terminal/__tests__/use-text-buffer.test.ts` (adapt from vitest+renderHook to bun:test+direct function calls)
- Sprout: `test/tui/buffer.test.ts` (adapt from flat-string to TextBufferState)

Key test groups:
1. `createBufferState` — empty, single line, multi-line initialization
2. `insertText` — single char, middle of line, newline insertion, multi-line paste
3. `deleteChar` — backward within line, backward at line start (merge), forward within line, forward at line end (merge), no-op at boundaries
4. `moveCursor` — left/right within line, left/right wrapping across lines, up/down with column preservation, up/down with preferred column clamping, home/end, no-op at boundaries
5. `setText` / `getText` — round-trip, multi-line
6. `killLine` — middle of line, at EOL (no-op), empty line
7. `killLineBackward` — middle of line, at SOL (no-op)
8. `killWordBackward` — single word, skip spaces, stop at newlines, no-op at SOL
9. `isOnFirstLine` / `isOnLastLine` — single line, multi-line positions

No React dependencies — these are pure function tests. No renderHook needed.

**Step 2: Run tests to verify they fail**

```bash
bun test test/tui/text-buffer.test.ts
```

Expected: All tests fail (module not found).

**Step 3: Implement text-buffer.ts**

Create `src/tui/text-buffer.ts` with all functions listed above. Port logic from lace's `use-text-buffer.ts`, converting from `setState` callbacks to pure function returns.

Key adaptation: lace's functions are closures inside `setState((prevState) => { ... })`. Extract the return values as pure functions: `(state: TextBufferState) => TextBufferState`.

For `killWordBackward`, adapt sprout's flat-string implementation to the lines-array model:

```ts
export function killWordBackward(state: TextBufferState): TextBufferState {
  const { lines, cursorLine, cursorColumn } = state;
  const line = lines[cursorLine] ?? "";
  if (cursorColumn === 0) return state;
  let i = cursorColumn;
  while (i > 0 && line[i - 1] === " ") i--;
  while (i > 0 && line[i - 1] !== " ") i--;
  const newLine = line.slice(0, i) + line.slice(cursorColumn);
  const newLines = [...lines];
  newLines[cursorLine] = newLine;
  return { ...state, lines: newLines, cursorColumn: i, preferredColumn: i };
}
```

**Step 4: Run tests to verify they pass**

```bash
bun test test/tui/text-buffer.test.ts
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/tui/text-buffer.ts test/tui/text-buffer.test.ts
git commit -m "feat(tui): add pure text buffer functions with lines-array model"
```

---

### Task 2: useTextBuffer hook + TextRenderer

Create the React hook wrapping Task 1's pure functions, and port lace's TextRenderer component.

**Files:**
- Create: `src/tui/use-text-buffer.ts`
- Create: `src/tui/text-renderer.tsx`
- Test: `test/tui/text-renderer.test.tsx`

**Step 1: Create useTextBuffer hook**

Create `src/tui/use-text-buffer.ts`. This is a thin wrapper — no separate tests needed since the pure functions are already tested.

```ts
import { useCallback, useState } from "react";
import {
  type TextBufferState,
  createBufferState,
  deleteChar,
  getText,
  insertText,
  isOnFirstLine,
  isOnLastLine,
  killLine,
  killLineBackward,
  killWordBackward,
  moveCursor,
  setText,
} from "./text-buffer.ts";

export function useTextBuffer(initialText = "") {
  const [state, setState] = useState<TextBufferState>(() =>
    createBufferState(initialText),
  );

  const ops = {
    insertText: (text: string) => setState((s) => insertText(s, text)),
    deleteChar: (dir: "forward" | "backward") => setState((s) => deleteChar(s, dir)),
    moveCursor: (dir: "left" | "right" | "up" | "down" | "home" | "end") =>
      setState((s) => moveCursor(s, dir)),
    setText: (text: string) => setState((s) => setText(s, text)),
    getText: () => getText(state),
    setCursorPosition: (line: number, column: number) =>
      setState((s) => ({
        ...s,
        cursorLine: Math.max(0, Math.min(line, s.lines.length - 1)),
        cursorColumn: Math.max(0, column),
        preferredColumn: Math.max(0, column),
      })),
    killLine: () => setState((s) => killLine(s)),
    killLineBackward: () => setState((s) => killLineBackward(s)),
    killWordBackward: () => setState((s) => killWordBackward(s)),
    isOnFirstLine: () => isOnFirstLine(state),
    isOnLastLine: () => isOnLastLine(state),
    reset: () => setState(createBufferState("")),
  };

  return [state, ops] as const;
}
```

**Step 2: Write failing TextRenderer tests**

Create `test/tui/text-renderer.test.tsx`. Port test cases from lace's `~/git/lace/src/interfaces/terminal/__tests__/text-renderer.test.tsx`, adapting from vitest to bun:test and from lace's `renderInkComponent` helper to ink-testing-library's `render`:

Test groups:
1. Basic rendering — renders text content, handles empty props
2. Focus handling — shows cursor when focused, hides when not
3. Multi-line content — displays all lines, handles empty lines between content
4. Placeholder — shows when empty+unfocused, hides when focused, hides when content exists
5. Edge cases — long lines, cursor beyond content bounds, negative cursor positions, empty lines array

**Step 3: Run tests to verify they fail**

```bash
bun test test/tui/text-renderer.test.tsx
```

Expected: All tests fail (module not found).

**Step 4: Implement TextRenderer**

Create `src/tui/text-renderer.tsx`. Port from lace's `~/git/lace/src/interfaces/terminal/components/text-renderer.tsx`, removing:
- The `instanceId` ref (use simpler keys)
- The `inlineCompletion` prop (add later with autocomplete)

Keep:
- Safety bounds for cursor line/column
- Inverse text for cursor character
- Placeholder logic (only when empty + unfocused)
- Empty line rendering (space character for height)

```tsx
import { Box, Text } from "ink";

interface TextRendererProps {
  lines: string[];
  cursorLine: number;
  cursorColumn: number;
  isFocused: boolean;
  placeholder?: string;
}

export function TextRenderer({
  lines,
  cursorLine,
  cursorColumn,
  isFocused,
  placeholder = "Type your message...",
}: TextRendererProps) {
  const safeLines = lines.length === 0 ? [""] : lines;
  const safeCursorLine = Math.max(0, Math.min(cursorLine, safeLines.length - 1));
  const currentLine = safeLines[safeCursorLine] ?? "";
  const safeCursorColumn = Math.max(0, Math.min(cursorColumn, currentLine.length));

  if (!isFocused && safeLines.length === 1 && safeLines[0] === "") {
    return <Text dimColor>{placeholder}</Text>;
  }

  return (
    <Box flexDirection="column">
      {safeLines.map((line, i) => {
        const isCurrentLine = i === safeCursorLine;
        if (isCurrentLine && isFocused) {
          return (
            <Box key={i} flexDirection="row">
              <Text>{line.slice(0, safeCursorColumn)}</Text>
              <Text inverse>
                {line.slice(safeCursorColumn, safeCursorColumn + 1) || " "}
              </Text>
              <Text>{line.slice(safeCursorColumn + 1)}</Text>
            </Box>
          );
        }
        if (line.length === 0) {
          return <Text key={i}> </Text>;
        }
        return <Text key={i}>{line}</Text>;
      })}
    </Box>
  );
}
```

**Step 5: Run tests to verify they pass**

```bash
bun test test/tui/text-renderer.test.tsx
```

Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/tui/use-text-buffer.ts src/tui/text-renderer.tsx test/tui/text-renderer.test.tsx
git commit -m "feat(tui): add useTextBuffer hook and TextRenderer component"
```

---

### Task 3: /collapse-tools slash command + remove Tab tool-collapse

Replace the Tab key tool-collapse toggle in ConversationView with a `/collapse-tools` slash command. Tool visibility state moves from ConversationView to App.

**Files:**
- Modify: `src/tui/slash-commands.ts`
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/conversation-view.tsx`
- Modify: `test/tui/slash-commands.test.ts`
- Modify: `test/tui/conversation-view.test.tsx`
- Modify: `test/tui/app.test.tsx`

**Step 1: Write failing tests for /collapse-tools slash command**

In `test/tui/slash-commands.test.ts`, add:

```ts
test("parses /collapse-tools", () => {
  expect(parseSlashCommand("/collapse-tools")).toEqual({ kind: "collapse_tools" });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test test/tui/slash-commands.test.ts
```

Expected: FAIL — type error or wrong return value.

**Step 3: Add /collapse-tools to slash command type and parser**

In `src/tui/slash-commands.ts`:
- Add `| { kind: "collapse_tools" }` to `SlashCommand` type union
- Add `case "/collapse-tools": return { kind: "collapse_tools" };` to switch

**Step 4: Run test to verify it passes**

```bash
bun test test/tui/slash-commands.test.ts
```

Expected: All tests pass.

**Step 5: Update ConversationView to accept toolsCollapsed as prop**

In `src/tui/conversation-view.tsx`:
- Add `toolsCollapsed?: boolean` to `ConversationViewProps`
- Remove `useState(false)` for `toolsCollapsed` — use prop instead
- Remove `toolsCollapsedRef` and its sync useEffect
- Use prop directly with a ref (for the bus callback)
- Remove the `useInput` handler for Tab

In `test/tui/conversation-view.test.tsx`:
- Remove the two Tab toggle tests ("Tab hides tool events..." and "Tab hides act_start...")
- Add test: "hides tool events when toolsCollapsed prop is true" — render with `toolsCollapsed={true}`, emit tool events, verify hidden
- Add test: "shows tool events when toolsCollapsed prop is false" — render with `toolsCollapsed={false}` (or omitted), emit tool events, verify visible

**Step 6: Wire /collapse-tools in App**

In `src/tui/app.tsx`:
- Add `const [toolsCollapsed, setToolsCollapsed] = useState(false);` state
- In `handleSlash`: add `if (cmd.kind === "collapse_tools") { setToolsCollapsed(prev => !prev); return; }`
- Pass `toolsCollapsed={toolsCollapsed}` to `<ConversationView>`
- Emit a bus warning when toggling: `bus.emitEvent("warning", "cli", 0, { message: toolsCollapsed ? "Tool details visible" : "Tool details hidden" })`

Note: the ternary is inverted because we read `toolsCollapsed` before the setter runs.

**Step 7: Run all affected tests**

```bash
bun test test/tui/slash-commands.test.ts test/tui/conversation-view.test.tsx test/tui/app.test.tsx
```

Expected: All pass.

**Step 8: Commit**

```bash
git add src/tui/slash-commands.ts src/tui/app.tsx src/tui/conversation-view.tsx test/tui/slash-commands.test.ts test/tui/conversation-view.test.tsx test/tui/app.test.tsx
git commit -m "feat(tui): add /collapse-tools slash command, remove Tab tool-collapse toggle"
```

---

### Task 4: Autocomplete component

Port lace's autocomplete dropdown UI as a standalone component, stripped of lace's focus system. State management lives in the parent (InputArea will manage it in Task 5). The component is purely presentational + handles its own keyboard navigation.

**Files:**
- Create: `src/tui/autocomplete.tsx`
- Test: `test/tui/autocomplete.test.tsx`

**Step 1: Write failing tests**

Create `test/tui/autocomplete.test.tsx`:

```tsx
describe("Autocomplete", () => {
  test("renders nothing when not visible", ...);
  test("renders nothing when items is empty", ...);
  test("renders visible items with selected highlight", ...);
  test("Enter calls onSelect with selected item", ...);
  test("Escape calls onCancel", ...);
  test("down arrow calls onNavigate('down')", ...);
  test("up arrow calls onNavigate('up')", ...);
  test("caps visible items to maxItems", ...);
  test("scrolls window to keep selected visible", ...);
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test test/tui/autocomplete.test.tsx
```

Expected: All fail (module not found).

**Step 3: Implement Autocomplete component**

Create `src/tui/autocomplete.tsx`. Simplified from lace's `file-autocomplete.tsx`:

```tsx
import { Box, Text, useInput } from "ink";

export interface AutocompleteProps {
  items: string[];
  selectedIndex: number;
  visible: boolean;
  maxItems?: number;
  isActive?: boolean;
  onSelect?: (item: string) => void;
  onCancel?: () => void;
  onNavigate?: (direction: "up" | "down") => void;
}

export function Autocomplete({
  items,
  selectedIndex,
  visible,
  maxItems = 5,
  isActive = true,
  onSelect,
  onCancel,
  onNavigate,
}: AutocompleteProps) {
  useInput(
    (_input, key) => {
      if (key.escape) { onCancel?.(); return; }
      if (key.return || key.tab) {
        const item = items[selectedIndex];
        if (item) onSelect?.(item);
        return;
      }
      if (key.upArrow) { onNavigate?.("up"); return; }
      if (key.downArrow) { onNavigate?.("down"); return; }
    },
    { isActive: visible && isActive },
  );

  if (!visible || items.length === 0) return null;

  const startIndex = Math.max(0, Math.min(selectedIndex, items.length - maxItems));
  const endIndex = Math.min(items.length, startIndex + maxItems);
  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column">
      {visibleItems.map((item, i) => {
        const actual = startIndex + i;
        const selected = actual === selectedIndex;
        return (
          <Text key={`${actual}-${item}`} color={selected ? "cyan" : "gray"}>
            {selected ? "> " : "  "}{item}
          </Text>
        );
      })}
    </Box>
  );
}
```

Key differences from lace:
- No focus system — uses `isActive` prop for `useInput`
- No `backgroundColor` (simpler styling)
- Tab selects (same as Enter)

**Step 4: Run tests to verify they pass**

```bash
bun test test/tui/autocomplete.test.tsx
```

Expected: All pass.

**Step 5: Commit**

```bash
git add src/tui/autocomplete.tsx test/tui/autocomplete.test.tsx
git commit -m "feat(tui): add Autocomplete dropdown component"
```

---

### Task 5: Clipboard support

Add clipboard paste (Ctrl+V / Cmd+V) as a utility function.

**Files:**
- Create: `src/tui/clipboard.ts`
- Test: `test/tui/clipboard.test.ts`

**Step 1: Write failing test**

```ts
describe("readClipboard", () => {
  test("returns a string", async () => {
    const result = await readClipboard();
    expect(typeof result).toBe("string");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test test/tui/clipboard.test.ts
```

**Step 3: Implement clipboard.ts**

```ts
export async function readClipboard(): Promise<string> {
  try {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}
```

macOS-only via `pbpaste`. Returns empty string on failure. Can be extended for Linux (`xclip -selection clipboard -o`) later.

**Step 4: Run test to verify it passes**

```bash
bun test test/tui/clipboard.test.ts
```

**Step 5: Commit**

```bash
git add src/tui/clipboard.ts test/tui/clipboard.test.ts
git commit -m "feat(tui): add clipboard read support via pbpaste"
```

---

### Task 6: Rewrite InputArea

Replace the flat-string InputArea with one built on `useTextBuffer` + `TextRenderer`. Keep all sprout-specific behavior: history navigation, Ctrl+C two-stage exit, slash commands, steer mode, clipboard paste.

**Files:**
- Modify: `src/tui/input-area.tsx`
- Modify: `test/tui/input-area.test.tsx`

**Step 1: Update existing tests**

The existing tests in `test/tui/input-area.test.tsx` test behavior, not implementation — most should still pass with the new implementation. Review each test and adapt if needed:

- Tests that check submitted text via `onSubmit` — should work as-is
- Tests that use `\x7F` for backspace — verify still works
- Tests that use arrow keys, Ctrl+A/E/K/U/W/F/B — should work
- Tests for history (up/down arrow on first/last line) — should work
- Tests for Alt+Enter newline — **change**: lace uses `\` at EOL for newlines. In sprout, keep Alt+Enter behavior. Ensure test still works.
- Tests for Ctrl+C behavior — should work as-is

Add new tests:
- "displays multi-line text with cursor on correct line"
- "preferred column preserved across up/down movement"
- "Ctrl+V pastes clipboard content" (may need mock)
- "Tab shows autocomplete when text exists" (placeholder test for now — autocomplete won't be wired to a data source yet)

**Step 2: Rewrite InputArea**

Replace implementation of `src/tui/input-area.tsx`:

```tsx
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { readClipboard } from "./clipboard.ts";
import type { SlashCommand } from "./slash-commands.ts";
import { parseSlashCommand } from "./slash-commands.ts";
import { TextRenderer } from "./text-renderer.tsx";
import { getText, isOnFirstLine, isOnLastLine } from "./text-buffer.ts";
import { useTextBuffer } from "./use-text-buffer.ts";

export interface InputAreaProps {
  onSubmit: (text: string) => void;
  onSlashCommand: (cmd: SlashCommand) => void;
  isRunning: boolean;
  initialHistory?: string[];
  onInterrupt?: () => void;
  onIdleCtrlC?: () => void;
  onExit?: () => void;
  onSteer?: (text: string) => void;
  onCancelExit?: () => void;
  exitPending?: boolean;
}
```

Key architecture:
- Use `useTextBuffer` for all text state
- Use `TextRenderer` for rendering
- History: when up-arrow on first line, swap buffer to history entry; when down-arrow on last line, restore
- Ctrl+C: same two-stage logic as current implementation
- Slash commands: check on Enter, same as current
- Steer: same as current (submit while running)
- Newlines: Alt+Enter inserts newline (like current), also support `\n` (Ctrl+J)
- Enter on single line: submit; Enter on multi-line: still submit (Alt+Enter for newlines)
- Keyboard shortcuts: Ctrl+A (home), Ctrl+E (end), Ctrl+F (right), Ctrl+B (left), Ctrl+K (kill-line), Ctrl+U (kill-line-backward), Ctrl+W (kill-word-backward), Ctrl+V/Cmd+V (paste)
- Tab: reserved for future autocomplete (no-op for now, don't consume)

**Step 3: Run all InputArea tests**

```bash
bun test test/tui/input-area.test.tsx
```

Expected: All pass.

**Step 4: Run full test suite**

```bash
bun test test/tui/
```

Expected: All TUI tests pass.

**Step 5: Commit**

```bash
git add src/tui/input-area.tsx test/tui/input-area.test.tsx
git commit -m "feat(tui): rewrite InputArea with useTextBuffer + TextRenderer"
```

---

### Task 7: Clean up old buffer.ts

Remove the old flat-string buffer module now that InputArea uses the new text-buffer.

**Files:**
- Delete: `src/tui/buffer.ts`
- Delete: `test/tui/buffer.test.ts`

**Step 1: Verify no remaining imports of buffer.ts**

Search for any file importing from `./buffer` or `../tui/buffer`:

```bash
grep -r "from.*buffer" src/tui/ test/tui/
```

Should only find text-buffer imports. If input-area.tsx still imports from buffer.ts, something was missed in Task 6.

**Step 2: Delete files**

```bash
rm src/tui/buffer.ts test/tui/buffer.test.ts
```

**Step 3: Run full test suite**

```bash
bun test
```

Expected: All tests pass. No broken imports.

**Step 4: Commit**

```bash
git add -u src/tui/buffer.ts test/tui/buffer.test.ts
git commit -m "chore: remove old flat-string buffer.ts, replaced by text-buffer.ts"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `bun test` — all tests pass
- [ ] `bun run typecheck` — no type errors
- [ ] `bun run check` — biome clean
- [ ] Manual test: `bun src/host/cli.ts` — type multi-line text with Alt+Enter, verify cursor renders correctly
- [ ] Manual test: arrow keys navigate within multi-line text, preferred column preserved
- [ ] Manual test: `/collapse-tools` toggles tool event visibility
- [ ] Manual test: Ctrl+V pastes clipboard
- [ ] Manual test: history navigation still works (up/down on single-line input)
- [ ] Manual test: Ctrl+C interrupt/exit still works
