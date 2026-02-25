# TUI Markdown Rendering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hand-rolled markdown formatting in the TUI with `ink-markdown` for rich terminal output (headers, syntax-highlighted code blocks, lists, etc.)

**Architecture:** Swap the `formatMarkdown()` / `formatInline()` functions in `event-components.tsx` with the `ink-markdown` `<Markdown>` component. The component wraps `marked` + `marked-terminal` for full GFM rendering in the terminal.

**Tech Stack:** ink-markdown (wraps marked + marked-terminal + cli-highlight), Ink 6, React 19, Bun

**Design doc:** `docs/plans/2026-02-24-markdown-rendering-design.md`

---

### Task 1: Install ink-markdown

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `cd /Users/jesse/prime-radiant/sprout && bun add ink-markdown`

Expected: `ink-markdown` appears in `dependencies` in package.json.

**Step 2: Verify it installed correctly**

Run: `cd /Users/jesse/prime-radiant/sprout && bun run typecheck`

Expected: No type errors (the package ships with types or has `@types/marked-terminal` bundled).

**Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "deps: add ink-markdown for rich terminal markdown rendering"
```

---

### Task 2: Replace formatMarkdown with ink-markdown in AssistantTextLine

**Files:**
- Modify: `src/tui/event-components.tsx:24-90` (delete `formatMarkdown` and `formatInline`)
- Modify: `src/tui/event-components.tsx:205-224` (`AssistantTextLine` component)
- Modify: `test/tui/event-components.test.tsx:9` (remove `formatMarkdown` import)
- Modify: `test/tui/event-components.test.tsx:352-388` (update `formatMarkdown` tests)

**Step 1: Update the failing tests first**

In `test/tui/event-components.test.tsx`, replace the `formatMarkdown` describe block (lines 352-388) with tests that verify `AssistantTextLine` renders markdown properly. Also remove `formatMarkdown` from the imports.

The old tests tested `formatMarkdown` as a standalone function. The new tests should test `AssistantTextLine` rendering markdown content, since `formatMarkdown` won't be exported anymore.

Replace the `formatMarkdown` import on line 9 and the test block:

```tsx
// Remove formatMarkdown from imports (line 9)
// Keep all other imports the same

// Replace the formatMarkdown describe block with:
describe("AssistantTextLine markdown rendering", () => {
	test("renders plain text", () => {
		const { lastFrame } = render(<AssistantTextLine depth={0} text="hello world" />);
		expect(lastFrame()).toContain("hello world");
	});

	test("renders bold text without asterisks", () => {
		const { lastFrame } = render(
			<AssistantTextLine depth={0} text="hello **bold** world" />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("bold");
		expect(frame).not.toContain("**");
	});

	test("renders inline code", () => {
		const { lastFrame } = render(
			<AssistantTextLine depth={0} text="run `npm test` now" />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("npm test");
	});

	test("renders code blocks", () => {
		const text = "before\n```\ncode here\n```\nafter";
		const { lastFrame } = render(<AssistantTextLine depth={0} text={text} />);
		const frame = lastFrame()!;
		expect(frame).toContain("code here");
	});

	test("renders headers", () => {
		const { lastFrame } = render(
			<AssistantTextLine depth={0} text="# My Header" />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("My Header");
		// Should not show the raw # prefix
		expect(frame).not.toMatch(/^#\s/m);
	});

	test("renders bullet lists", () => {
		const text = "Items:\n- first\n- second\n- third";
		const { lastFrame } = render(<AssistantTextLine depth={0} text={text} />);
		const frame = lastFrame()!;
		expect(frame).toContain("first");
		expect(frame).toContain("second");
		expect(frame).toContain("third");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/jesse/prime-radiant/sprout && bun test test/tui/event-components.test.tsx`

Expected: The "renders headers" and possibly other new tests fail because `formatMarkdown` doesn't handle headers. The "renders bold text without asterisks" test may also fail depending on how ink-testing-library strips ANSI. The key is that the test file compiles and existing tests (like the `AssistantTextLine` describe block) still pass.

**Step 3: Replace formatMarkdown with ink-markdown in the implementation**

In `src/tui/event-components.tsx`:

1. Add import at top:
```tsx
import Markdown from "ink-markdown";
```

2. Delete the entire `formatMarkdown` function (lines 24-51) and `formatInline` function (lines 54-90), including the section comment above them.

3. In `AssistantTextLine` (around line 219), replace:
```tsx
{formatMarkdown(text)}
```
with:
```tsx
<Markdown>{text}</Markdown>
```

The `formatMarkdown` export is no longer needed since tests will test through `AssistantTextLine`.

**Step 4: Run tests to verify they pass**

Run: `cd /Users/jesse/prime-radiant/sprout && bun test test/tui/event-components.test.tsx`

Expected: All tests pass. If `ink-markdown` renders with trailing newlines or ANSI wrapping that affects assertions, adjust test expectations to use `toContain` rather than exact matches.

**Step 5: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout && bun run test:unit`

Expected: All 720+ tests pass. No other file imports `formatMarkdown`.

**Step 6: Run typecheck**

Run: `cd /Users/jesse/prime-radiant/sprout && bun run typecheck`

Expected: Clean.

**Step 7: Commit**

```bash
git add src/tui/event-components.tsx test/tui/event-components.test.tsx
git commit -m "feat: use ink-markdown for rich TUI markdown rendering

Replace hand-rolled formatMarkdown/formatInline with ink-markdown package.
Gets us headers, syntax-highlighted code blocks, lists, tables, links."
```
