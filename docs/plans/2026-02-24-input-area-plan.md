# Improved Text Entry Component Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the basic InputArea with a proper text editor featuring block cursor, in-buffer navigation, emacs keybindings, and smart history navigation.

**Architecture:** Use `ink-multiline-input`'s `ControlledMultilineInput` for rendering (block cursor, viewport scrolling, auto-grow). Extract cursor navigation and text editing into pure utility functions. InputArea owns all state and input handling.

**Tech Stack:** ink-multiline-input (ControlledMultilineInput), Ink 6, React 19, Bun

**Design doc:** `docs/plans/2026-02-24-input-area-design.md`

---

### Task 1: Install ink-multiline-input

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `cd /Users/jesse/prime-radiant/sprout && bun add ink-multiline-input`

Expected: `ink-multiline-input` appears in dependencies. Should install cleanly — peers are ink >=6 and react >=19, which we have.

**Step 2: Verify typecheck**

Run: `bun run typecheck`

Expected: Clean.

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: add ink-multiline-input for improved text entry rendering"
```

---

### Task 2: Buffer editing utilities

Pure functions for cursor math and text editing operations. These are the building blocks the InputArea will use for all navigation and editing.

**Files:**
- Create: `src/tui/buffer.ts`
- Create: `test/tui/buffer.test.ts`

**Step 1: Write tests for cursor line detection**

Create `test/tui/buffer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
	cursorLine,
	lineCount,
	isOnFirstLine,
	isOnLastLine,
} from "../../src/tui/buffer.ts";

describe("cursorLine", () => {
	test("returns 0 for empty string", () => {
		expect(cursorLine("", 0)).toBe(0);
	});

	test("returns 0 for single line", () => {
		expect(cursorLine("hello", 3)).toBe(0);
	});

	test("returns correct line for multiline", () => {
		const text = "abc\ndef\nghi";
		expect(cursorLine(text, 0)).toBe(0); // start of line 0
		expect(cursorLine(text, 3)).toBe(0); // end of line 0
		expect(cursorLine(text, 4)).toBe(1); // start of line 1
		expect(cursorLine(text, 7)).toBe(1); // end of line 1
		expect(cursorLine(text, 8)).toBe(2); // start of line 2
	});
});

describe("lineCount", () => {
	test("returns 1 for empty string", () => {
		expect(lineCount("")).toBe(1);
	});

	test("returns 1 for single line", () => {
		expect(lineCount("hello")).toBe(1);
	});

	test("returns correct count for multiline", () => {
		expect(lineCount("a\nb\nc")).toBe(3);
	});

	test("trailing newline adds a line", () => {
		expect(lineCount("a\n")).toBe(2);
	});
});

describe("isOnFirstLine", () => {
	test("true for empty string", () => {
		expect(isOnFirstLine("", 0)).toBe(true);
	});

	test("true when cursor is on first line", () => {
		expect(isOnFirstLine("abc\ndef", 2)).toBe(true);
	});

	test("false when cursor is on second line", () => {
		expect(isOnFirstLine("abc\ndef", 4)).toBe(false);
	});
});

describe("isOnLastLine", () => {
	test("true for empty string", () => {
		expect(isOnLastLine("", 0)).toBe(true);
	});

	test("true when cursor is on last line", () => {
		expect(isOnLastLine("abc\ndef", 5)).toBe(true);
	});

	test("false when cursor is on first line of multiline", () => {
		expect(isOnLastLine("abc\ndef", 2)).toBe(false);
	});

	test("true for single line", () => {
		expect(isOnLastLine("hello", 3)).toBe(true);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/tui/buffer.test.ts`

Expected: FAIL — module not found.

**Step 3: Implement cursor line detection**

Create `src/tui/buffer.ts`:

```typescript
/** Return which line (0-indexed) the cursor is on. */
export function cursorLine(text: string, cursorIndex: number): number {
	let line = 0;
	for (let i = 0; i < cursorIndex; i++) {
		if (text[i] === "\n") line++;
	}
	return line;
}

/** Return the number of lines in the text. */
export function lineCount(text: string): number {
	if (text === "") return 1;
	let count = 1;
	for (const ch of text) {
		if (ch === "\n") count++;
	}
	return count;
}

/** True if the cursor is on the first line. */
export function isOnFirstLine(text: string, cursorIndex: number): boolean {
	return cursorLine(text, cursorIndex) === 0;
}

/** True if the cursor is on the last line. */
export function isOnLastLine(text: string, cursorIndex: number): boolean {
	return cursorLine(text, cursorIndex) === lineCount(text) - 1;
}
```

**Step 4: Run tests**

Run: `bun test test/tui/buffer.test.ts`

Expected: All pass.

**Step 5: Write tests for line-based cursor movement**

Add to `test/tui/buffer.test.ts`:

```typescript
import {
	// ... existing imports
	lineStart,
	lineEnd,
	moveCursorUp,
	moveCursorDown,
} from "../../src/tui/buffer.ts";

describe("lineStart", () => {
	test("returns 0 for first line", () => {
		expect(lineStart("hello", 3)).toBe(0);
	});

	test("returns position after newline for second line", () => {
		expect(lineStart("abc\ndef", 5)).toBe(4);
	});

	test("returns 0 for empty string", () => {
		expect(lineStart("", 0)).toBe(0);
	});
});

describe("lineEnd", () => {
	test("returns text length for single line", () => {
		expect(lineEnd("hello", 2)).toBe(5);
	});

	test("returns position before newline", () => {
		expect(lineEnd("abc\ndef", 1)).toBe(3);
	});

	test("returns text length for last line", () => {
		expect(lineEnd("abc\ndef", 5)).toBe(7);
	});
});

describe("moveCursorUp", () => {
	test("returns same position on first line", () => {
		expect(moveCursorUp("hello", 3)).toBe(3);
	});

	test("moves to same column on previous line", () => {
		expect(moveCursorUp("abc\ndef", 5)).toBe(1); // col 1 of "def" -> col 1 of "abc"
	});

	test("clamps to shorter line", () => {
		expect(moveCursorUp("ab\ndefgh", 7)).toBe(2); // col 5 of "defgh" -> end of "ab"
	});
});

describe("moveCursorDown", () => {
	test("returns same position on last line", () => {
		expect(moveCursorDown("hello", 3)).toBe(3);
	});

	test("moves to same column on next line", () => {
		expect(moveCursorDown("abc\ndef", 1)).toBe(5); // col 1 of "abc" -> col 1 of "def"
	});

	test("clamps to shorter line", () => {
		expect(moveCursorDown("abcde\nfg", 4)).toBe(8); // col 4 of "abcde" -> end of "fg"
	});
});
```

**Step 6: Run tests to verify failures**

Run: `bun test test/tui/buffer.test.ts`

Expected: New tests fail — functions not exported.

**Step 7: Implement line movement**

Add to `src/tui/buffer.ts`:

```typescript
/** Return the index of the start of the line the cursor is on. */
export function lineStart(text: string, cursorIndex: number): number {
	const lastNewline = text.lastIndexOf("\n", cursorIndex - 1);
	return lastNewline + 1;
}

/** Return the index of the end of the line the cursor is on (before the \n or at text end). */
export function lineEnd(text: string, cursorIndex: number): number {
	const nextNewline = text.indexOf("\n", cursorIndex);
	return nextNewline === -1 ? text.length : nextNewline;
}

/** Move cursor up one line, preserving column where possible. */
export function moveCursorUp(text: string, cursorIndex: number): number {
	if (isOnFirstLine(text, cursorIndex)) return cursorIndex;
	const col = cursorIndex - lineStart(text, cursorIndex);
	const prevLineEnd = lineStart(text, cursorIndex) - 1; // the \n before current line
	const prevLineStart = lineStart(text, prevLineEnd);
	const prevLineLen = prevLineEnd - prevLineStart;
	return prevLineStart + Math.min(col, prevLineLen);
}

/** Move cursor down one line, preserving column where possible. */
export function moveCursorDown(text: string, cursorIndex: number): number {
	if (isOnLastLine(text, cursorIndex)) return cursorIndex;
	const col = cursorIndex - lineStart(text, cursorIndex);
	const nextLineStart = lineEnd(text, cursorIndex) + 1; // skip the \n
	const nextLineEnd = lineEnd(text, nextLineStart);
	const nextLineLen = nextLineEnd - nextLineStart;
	return nextLineStart + Math.min(col, nextLineLen);
}
```

**Step 8: Run tests**

Run: `bun test test/tui/buffer.test.ts`

Expected: All pass.

**Step 9: Write tests for text editing operations**

Add to `test/tui/buffer.test.ts`:

```typescript
import {
	// ... existing imports
	insertAt,
	deleteBackward,
	killToLineEnd,
	killToLineStart,
	killWordBackward,
} from "../../src/tui/buffer.ts";

describe("insertAt", () => {
	test("inserts at beginning", () => {
		expect(insertAt("hello", 0, "X")).toEqual({ text: "Xhello", cursor: 1 });
	});

	test("inserts in middle", () => {
		expect(insertAt("hllo", 1, "e")).toEqual({ text: "hello", cursor: 2 });
	});

	test("inserts at end", () => {
		expect(insertAt("hello", 5, "!")).toEqual({ text: "hello!", cursor: 6 });
	});

	test("inserts multi-char (paste)", () => {
		expect(insertAt("ad", 1, "bc")).toEqual({ text: "abcd", cursor: 3 });
	});
});

describe("deleteBackward", () => {
	test("does nothing at position 0", () => {
		expect(deleteBackward("hello", 0)).toEqual({ text: "hello", cursor: 0 });
	});

	test("deletes char before cursor", () => {
		expect(deleteBackward("hello", 3)).toEqual({ text: "helo", cursor: 2 });
	});

	test("deletes at end", () => {
		expect(deleteBackward("hello", 5)).toEqual({ text: "hell", cursor: 4 });
	});
});

describe("killToLineEnd", () => {
	test("kills to end of single line", () => {
		expect(killToLineEnd("hello", 2)).toEqual({ text: "he", cursor: 2 });
	});

	test("kills to newline on first line", () => {
		expect(killToLineEnd("abc\ndef", 1)).toEqual({ text: "a\ndef", cursor: 1 });
	});

	test("does nothing at end of text", () => {
		expect(killToLineEnd("hello", 5)).toEqual({ text: "hello", cursor: 5 });
	});

	test("kills newline when cursor is at end of line", () => {
		expect(killToLineEnd("abc\ndef", 3)).toEqual({ text: "abcdef", cursor: 3 });
	});
});

describe("killToLineStart", () => {
	test("kills to start of line", () => {
		expect(killToLineStart("hello", 3)).toEqual({ text: "lo", cursor: 0 });
	});

	test("kills to start of current line in multiline", () => {
		expect(killToLineStart("abc\ndef", 6)).toEqual({ text: "abc\nf", cursor: 4 });
	});

	test("does nothing at start of line", () => {
		expect(killToLineStart("abc\ndef", 4)).toEqual({ text: "abc\ndef", cursor: 4 });
	});
});

describe("killWordBackward", () => {
	test("kills word before cursor", () => {
		expect(killWordBackward("hello world", 11)).toEqual({ text: "hello ", cursor: 6 });
	});

	test("kills word and trailing spaces", () => {
		expect(killWordBackward("hello  world", 7)).toEqual({ text: "world", cursor: 0 });
	});

	test("does nothing at position 0", () => {
		expect(killWordBackward("hello", 0)).toEqual({ text: "hello", cursor: 0 });
	});

	test("kills single word", () => {
		expect(killWordBackward("hello", 5)).toEqual({ text: "", cursor: 0 });
	});
});
```

**Step 10: Run tests to verify failures**

Run: `bun test test/tui/buffer.test.ts`

Expected: New tests fail.

**Step 11: Implement text editing operations**

Add to `src/tui/buffer.ts`:

```typescript
interface EditResult {
	text: string;
	cursor: number;
}

/** Insert text at cursor position. */
export function insertAt(text: string, cursorIndex: number, input: string): EditResult {
	return {
		text: text.slice(0, cursorIndex) + input + text.slice(cursorIndex),
		cursor: cursorIndex + input.length,
	};
}

/** Delete one character before the cursor. */
export function deleteBackward(text: string, cursorIndex: number): EditResult {
	if (cursorIndex === 0) return { text, cursor: 0 };
	return {
		text: text.slice(0, cursorIndex - 1) + text.slice(cursorIndex),
		cursor: cursorIndex - 1,
	};
}

/** Kill from cursor to end of current line. If at line end, join with next line. */
export function killToLineEnd(text: string, cursorIndex: number): EditResult {
	const end = lineEnd(text, cursorIndex);
	if (end === cursorIndex && cursorIndex < text.length) {
		// Cursor is at the end of a line but not at text end — kill the newline
		return { text: text.slice(0, cursorIndex) + text.slice(cursorIndex + 1), cursor: cursorIndex };
	}
	return { text: text.slice(0, cursorIndex) + text.slice(end), cursor: cursorIndex };
}

/** Kill from start of current line to cursor. */
export function killToLineStart(text: string, cursorIndex: number): EditResult {
	const start = lineStart(text, cursorIndex);
	return {
		text: text.slice(0, start) + text.slice(cursorIndex),
		cursor: start,
	};
}

/** Kill one word backward (like Ctrl-W in bash). */
export function killWordBackward(text: string, cursorIndex: number): EditResult {
	if (cursorIndex === 0) return { text, cursor: 0 };
	let i = cursorIndex;
	// Skip spaces backward
	while (i > 0 && text[i - 1] === " ") i--;
	// Skip word chars backward
	while (i > 0 && text[i - 1] !== " ") i--;
	return {
		text: text.slice(0, i) + text.slice(cursorIndex),
		cursor: i,
	};
}
```

**Step 12: Run tests**

Run: `bun test test/tui/buffer.test.ts`

Expected: All pass.

**Step 13: Run full test suite**

Run: `bun run test:unit`

Expected: All pass.

**Step 14: Commit**

```bash
git add src/tui/buffer.ts test/tui/buffer.test.ts
git commit -m "feat: add buffer editing utilities for cursor nav and text editing"
```

---

### Task 3: Rewrite InputArea with ControlledMultilineInput

Replace the current InputArea implementation. Use `ControlledMultilineInput` for rendering and the buffer utilities for all editing operations. All existing behaviors must be preserved.

**Files:**
- Modify: `src/tui/input-area.tsx`
- Modify: `test/tui/input-area.test.tsx`

**Context for the implementer:**

The current `InputArea` at `src/tui/input-area.tsx` is ~115 lines. It:
- Uses a single `value` string state (append-only, backspace from end)
- Renders as `<Box><Text>{prompt} {value}</Text></Box>`
- Has history navigation on up/down arrows
- Has Ctrl-C handling (interrupt when running, exit when idle, double-tap exits)
- Has Alt-Enter for newlines
- Has slash command detection on submit
- Has steering mode (onSteer) when running

The rewrite needs to:
1. Add `cursorIndex` state alongside `value`
2. Use buffer utilities (`insertAt`, `deleteBackward`, etc.) for all edits
3. Use `ControlledMultilineInput` for rendering instead of `<Text>`
4. Smart history: up from first line → history previous, down from last line → history next
5. Add emacs keybindings: Ctrl-A/E/F/B/K/U/W
6. Render with `>` prompt on first line

**Step 1: Update existing tests and add new ones**

Update `test/tui/input-area.test.tsx`. The existing tests should mostly still work but some need adjustments because rendering changes (ControlledMultilineInput instead of plain Text). Add new tests for the new features.

Key test updates:
- The prompt `>` and `...` tests need to check the new rendering structure
- Add tests for: left/right arrow cursor movement, Ctrl-A/E, Ctrl-K, Ctrl-W, Ctrl-U
- Add tests for: up-from-first-line navigates history, down-from-last-line navigates history
- Add tests for: up/down within multiline text moves between lines (not history)

New tests to add (append to the existing describe block):

```tsx
test("left arrow moves cursor backward", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
		/>,
	);

	stdin.write("abc");
	await flush();
	// Move cursor left, then type
	stdin.write("\x1B[D"); // left arrow
	await flush();
	stdin.write("X");
	await flush();
	stdin.write("\r");
	await flush();
	expect(submitted).toBe("abXc");
});

test("Ctrl-A moves to start of line", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
		/>,
	);

	stdin.write("hello");
	await flush();
	stdin.write("\x01"); // Ctrl-A
	await flush();
	stdin.write("X");
	await flush();
	stdin.write("\r");
	await flush();
	expect(submitted).toBe("Xhello");
});

test("Ctrl-E moves to end of line", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
		/>,
	);

	stdin.write("hello");
	await flush();
	stdin.write("\x01"); // Ctrl-A (go to start)
	await flush();
	stdin.write("\x05"); // Ctrl-E (go to end)
	await flush();
	stdin.write("!");
	await flush();
	stdin.write("\r");
	await flush();
	expect(submitted).toBe("hello!");
});

test("Ctrl-K kills to end of line", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
		/>,
	);

	stdin.write("hello world");
	await flush();
	stdin.write("\x01"); // Ctrl-A
	await flush();
	// Move right 5 times to position after "hello"
	for (let i = 0; i < 5; i++) {
		stdin.write("\x1B[C"); // right arrow
		await flush();
	}
	stdin.write("\x0B"); // Ctrl-K
	await flush();
	stdin.write("\r");
	await flush();
	expect(submitted).toBe("hello");
});

test("Ctrl-U kills to start of line", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
		/>,
	);

	stdin.write("hello world");
	await flush();
	// Cursor is at end, Ctrl-U kills everything before cursor on current line
	stdin.write("\x15"); // Ctrl-U
	await flush();
	stdin.write("\r");
	await flush();
	// Empty after Ctrl-U, so nothing submitted (trim check)
	expect(submitted).toBe("");
});

test("Ctrl-W kills word backward", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
		/>,
	);

	stdin.write("hello world");
	await flush();
	stdin.write("\x17"); // Ctrl-W
	await flush();
	stdin.write("\r");
	await flush();
	expect(submitted).toBe("hello");
});

test("backspace deletes character before cursor, not just from end", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
		/>,
	);

	stdin.write("abcd");
	await flush();
	stdin.write("\x1B[D"); // left arrow (cursor before 'd')
	await flush();
	stdin.write("\x7F"); // backspace (should delete 'c', not 'd')
	await flush();
	stdin.write("\r");
	await flush();
	expect(submitted).toBe("abd");
});

test("up arrow from first line navigates history", async () => {
	const { lastFrame, stdin } = render(
		<InputArea
			onSubmit={() => {}}
			onSlashCommand={() => {}}
			isRunning={false}
			initialHistory={["prev command"]}
		/>,
	);

	// Cursor is on first (only) line, so up should navigate history
	stdin.write("\x1B[A"); // up arrow
	await flush();
	expect(lastFrame()).toContain("prev command");
});

test("up arrow within multiline text moves cursor up, not history", async () => {
	let submitted = "";
	const { stdin } = render(
		<InputArea
			onSubmit={(text) => { submitted = text; }}
			onSlashCommand={() => {}}
			isRunning={false}
			initialHistory={["should not appear"]}
		/>,
	);

	// Type multiline text
	stdin.write("line1");
	await flush();
	stdin.write("\x1B\r"); // Alt-Enter (newline)
	await flush();
	stdin.write("line2");
	await flush();

	// Up arrow from line 2 should move to line 1, not history
	stdin.write("\x1B[A");
	await flush();

	// Type something to verify we're on line 1
	stdin.write("X");
	await flush();
	stdin.write("\r");
	await flush();
	// If cursor moved up, 'X' is inserted into line 1 — the submitted text should contain both lines
	expect(submitted).toContain("line1");
	expect(submitted).toContain("line2");
	expect(submitted).not.toContain("should not appear");
});
```

**Step 2: Run new tests to verify they fail**

Run: `bun test test/tui/input-area.test.tsx`

Expected: New tests fail (left arrow, Ctrl-A, etc. don't work in current implementation).

**Step 3: Rewrite InputArea**

Replace the contents of `src/tui/input-area.tsx` with the new implementation. Key changes:

1. Import `ControlledMultilineInput` from `ink-multiline-input`
2. Import buffer utilities from `./buffer.ts`
3. Add `cursorIndex` state
4. Rewrite `useInput` handler to use buffer utilities for all operations
5. Smart history: check `isOnFirstLine`/`isOnLastLine` before navigating history
6. Render with `ControlledMultilineInput` instead of plain `<Text>`

The new implementation should:
- Preserve all existing behaviors (submit, slash commands, steering, Ctrl-C, Alt-Enter)
- Add cursor-aware editing (insert at cursor, delete at cursor)
- Add emacs keybindings
- Add smart up/down (line movement vs history)
- Render with block cursor via ControlledMultilineInput

Important implementation notes:
- `ControlledMultilineInput` props we need: `value`, `cursorIndex`, `showCursor`, `rows` (1 min), `maxRows` (let it grow)
- The `>` prompt should be rendered separately in a `<Box>` next to the input
- When `isRunning`, show `...` prompt and optionally disable cursor
- The newline insertion (Alt-Enter) should use `insertAt(value, cursorIndex, "\n")`
- When loading a history entry, set `cursorIndex` to the end of the loaded text
- `Ctrl-F` and `Ctrl-B` map to right/left (use ink's `key.ctrl && input === "f"` etc.)

**Step 4: Run tests**

Run: `bun test test/tui/input-area.test.tsx`

Expected: All tests pass (both old and new).

**Step 5: Run full test suite**

Run: `bun run test:unit`

Expected: All pass. No other files import InputArea internals — they all go through the component.

**Step 6: Run typecheck**

Run: `bun run typecheck`

Expected: Clean.

**Step 7: Commit**

```bash
git add src/tui/input-area.tsx test/tui/input-area.test.tsx
git commit -m "feat: rewrite InputArea with block cursor, emacs keys, smart history

Use ControlledMultilineInput for rendering. Add cursor position tracking,
in-buffer navigation (arrow keys + Ctrl-A/E/F/B), text editing
(Ctrl-K/U/W), and smart history (up/down navigate history only from
first/last line of multiline input)."
```

---

### Task 4: Verify integration and fix rendering details

Manually verify the TUI looks correct end-to-end and fix any rendering issues.

**Files:**
- Possibly modify: `src/tui/input-area.tsx`
- Possibly modify: `src/tui/app.tsx`

**Step 1: Run the app interactively**

Run: `cd /Users/jesse/prime-radiant/sprout && bun src/host/cli.ts`

Verify:
- Block cursor visible at end of prompt line
- Typing inserts characters, cursor advances
- Backspace deletes before cursor
- Left/Right arrows move cursor (block cursor moves)
- Ctrl-A jumps to start, Ctrl-E to end
- Alt-Enter inserts newline, input grows
- Up/Down navigate lines in multiline, or history when at edge
- Ctrl-K kills to end of line
- Ctrl-C works as before
- `/help` works as before

**Step 2: Fix any rendering issues found**

Common things to check:
- `>` prompt alignment with multi-line input
- Input area height/maxRows — should the input have a maximum height before scrolling?
- When running, should the `...` prompt still show the ControlledMultilineInput or just plain text?

**Step 3: Run full test suite**

Run: `bun run test:unit`

Expected: All pass.

**Step 4: Commit any fixes**

```bash
git add -u
git commit -m "fix: input area rendering adjustments after manual testing"
```
