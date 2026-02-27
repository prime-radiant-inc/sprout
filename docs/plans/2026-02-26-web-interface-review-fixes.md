# Web Interface Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all issues found by the three-reviewer audit of the web interface redesign.

**Architecture:** Fixes are grouped by file/subsystem to minimize context switching. React hook fixes are first (correctness), then wiring/integration fixes, then CSS/token cleanup, then dead code removal. Each task is independent after Task 1 (hook fixes), which must go first because other tasks may touch the same files.

**Tech Stack:** React 19, TypeScript, CSS Modules, Bun test runner, `renderToStaticMarkup` for component tests.

**Test command:** `cd web && bun test`

**Full test command:** `bun test` (from project root)

---

## Issue Inventory

Every issue from the three-reviewer audit, grouped into tasks:

| # | Issue | Severity | Task |
|---|-------|----------|------|
| 1 | `useFaviconStatus` mutates DOM during render (no `useEffect`) | Critical | 1 |
| 2 | `subscribe` in `useSyncExternalStore` recreated every render (both hooks) | Critical | 1 |
| 3 | `send` in `useWebSocket` not memoized, causes `useEffect` reruns | Important | 1 |
| 4 | `onSelectAgent` not passed to `ConversationView` — thread navigation dead | Critical | 2 |
| 5 | `agentName` never passed to `AssistantMessage` — all agents say "Assistant" | Critical | 2 |
| 6 | ConversationView uses array index as React key | Minor | 2 |
| 7 | InputArea "Stop" button doesn't stop — calls `submitValue()` not interrupt | Critical | 3 |
| 8 | StatusBar Pause/Stop buttons both call same `onInterrupt` | Important | 3 |
| 9 | `Sidebar.collapsed` prop accepted but never used | Important | 4 |
| 10 | Breadcrumb segments look clickable (hover) but aren't | Important | 4 |
| 11 | `StreamingBanner`/`TypingIndicator` built but never rendered | Important | 5 |
| 12 | Cost hardcoded `$0.00` — never updates | Important | 3 |
| 13 | `truncate()` off-by-3 — output exceeds `maxLen` | Bug | 6 |
| 14 | Hardcoded `#fff` in InputArea button CSS | Important | 7 |
| 15 | Hardcoded `rgba(245, 158, 11, 0.1)` in UserMessage badge CSS | Important | 7 |
| 16 | Hardcoded hex colors in `getFaviconSvg` bypass theme system | Important | 7 |
| 17 | AgentTree.module.css uses `3px` radius, `bold`, off-grid spacing | Minor | 7 |
| 18 | 26 dead backward-compat aliases in variables.css | Minor | 8 |
| 19 | `lastMessage` tracked in WebSocketClient but never consumed | Minor | 8 |
| 20 | `global.css` body font is `--font-mono` instead of `--font-ui` | Minor | 7 |
| 21 | Responsive breakpoint is 768px, should be 1024px | Minor | 7 |
| 22 | Escape when input focused should interrupt, not clear filter | Minor | 6 |
| 23 | `autoResize` captures potentially stale `textareaRef` | Minor | 6 |

---

### Task 1: Fix React hook correctness issues

Three hooks have correctness bugs: `useFaviconStatus` runs side effects during render, `subscribe` functions passed to `useSyncExternalStore` are recreated on every render, and `send` is not memoized.

**Files:**
- Modify: `web/src/hooks/useFaviconStatus.ts`
- Modify: `web/src/hooks/useWebSocket.ts`
- Modify: `web/src/hooks/useEvents.ts`
- Modify: `web/src/hooks/__tests__/useFaviconStatus.test.ts`

**Step 1: Write failing test for `useFaviconStatus` useEffect behavior**

The existing tests only test the pure `getFaviconSvg` function. That's fine — the pure function tests stay. No new test needed for the `useEffect` wrapper since it's a DOM side effect that's hard to test without a full browser. The existing tests cover the pure logic.

**Step 2: Fix `useFaviconStatus` — wrap DOM mutation in `useEffect`**

Replace the body of `useFaviconStatus` with a proper `useEffect`:

```typescript
import { useEffect } from "react";

/** Generate a simple colored circle SVG for the favicon. */
export function getFaviconSvg(status: string): string {
	let color: string;
	switch (status) {
		case "running":
			color = "#8b5cf6"; // accent purple
			break;
		case "error":
			color = "#ef4444"; // error red
			break;
		default:
			color = "#22c55e"; // success green (idle)
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/></svg>`;
}

/** Hook that updates the favicon based on session status. */
export function useFaviconStatus(status: string): void {
	useEffect(() => {
		if (typeof document === "undefined") return;

		const svg = getFaviconSvg(status);
		const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;

		let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
		if (!link) {
			link = document.createElement("link");
			link.rel = "icon";
			document.head.appendChild(link);
		}
		link.href = dataUrl;
	}, [status]);
}
```

**Step 3: Fix `subscribe` in `useWebSocket` — memoize with `useCallback`**

In `web/src/hooks/useWebSocket.ts`, wrap the `subscribe` function (currently at line 180) in `useCallback`:

```typescript
const subscribe = useCallback((onStoreChange: () => void) => {
	const unsubMsg = client.onMessage(() => {
		stateRef.current = { connected: client.connected, lastMessage: client.lastMessage };
		onStoreChange();
	});

	const unsubState = client.onStateChange(() => {
		stateRef.current = { connected: client.connected, lastMessage: client.lastMessage };
		onStoreChange();
	});

	return () => {
		unsubMsg();
		unsubState();
	};
}, [client]);
```

**Step 4: Fix `send` in `useWebSocket` — memoize with `useCallback`**

In the return statement of `useWebSocket` (line 217), replace the inline arrow with a memoized version:

```typescript
const send = useCallback((msg: object) => client.send(msg), [client]);

return {
	connected: state.connected,
	lastMessage: state.lastMessage,
	send,
	/** Subscribe to every incoming message (no batching/dropping). */
	onMessage,
};
```

**Step 5: Fix `subscribe` in `useEvents` — memoize with `useCallback`**

In `web/src/hooks/useEvents.ts`, wrap the `subscribe` function (currently at line 170) in `useCallback`:

```typescript
const subscribe = useCallback((onStoreChange: () => void) => {
	return store.subscribe(() => {
		snapshotRef.current = { events: store.events, status: store.status };
		onStoreChange();
	});
}, [store]);
```

Also update the import line to include `useCallback`:

```typescript
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
```

**Step 6: Run tests**

Run: `cd web && bun test`
Expected: All 240 tests pass, 0 fail.

**Step 7: Commit**

```bash
git add web/src/hooks/useFaviconStatus.ts web/src/hooks/useWebSocket.ts web/src/hooks/useEvents.ts
git commit -m "fix(web): wrap useFaviconStatus in useEffect, memoize subscribe/send in hooks"
```

---

### Task 2: Wire thread navigation and agent names

The headline feature ("threads, not a log") is broken: `onSelectAgent` is not passed to `ConversationView`, so "View thread" buttons never appear on delegation blocks. Also, `agentName` is never passed to `AssistantMessage`, so all agents say "Assistant."

**Files:**
- Modify: `web/src/App.tsx:165`
- Modify: `web/src/components/EventLine.tsx:8-14,43-55,153-161`
- Modify: `web/src/components/groupEvents.ts:4,51-55`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Write failing tests for agent name resolution and thread navigation**

Add tests to `components.test.tsx`:

```typescript
test("EventLine passes agentName from tree to AssistantMessage for plan_end", () => {
	const event = makeEvent("plan_end", { text: "hello" }, { agent_id: "child-1" });
	const html = renderToStaticMarkup(
		<EventLine event={event} durationMs={null} isFirstInGroup agentName="test-agent" />,
	);
	expect(html).toContain("test-agent");
});

test("EventLine passes agentName to AssistantMessage for plan_delta streaming", () => {
	const event = makeEvent("plan_delta", { text: "..." }, { agent_id: "child-1" });
	const html = renderToStaticMarkup(
		<EventLine event={event} durationMs={null} isFirstInGroup streamingText="hello" agentName="streamer" />,
	);
	expect(html).toContain("streamer");
});

test("ConversationView renders onSelectAgent on delegation blocks", () => {
	const events: SessionEvent[] = [
		makeEvent("act_start", { agent_name: "sub-agent", goal: "do stuff" }, { agent_id: "child-1", depth: 1 }),
	];
	const tree = buildAgentTree(events);
	let selectedId: string | null = null;
	const html = renderToStaticMarkup(
		<ConversationView events={events} tree={tree} onSelectAgent={(id) => { selectedId = id; }} />,
	);
	expect(html).toContain("View thread");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd web && bun test src/components/__tests__/components.test.tsx`
Expected: New tests FAIL (agentName not rendered, "View thread" not in output).

**Step 3: Add `agentName` prop to EventLine and pass through to AssistantMessage**

In `web/src/components/EventLine.tsx`, add `agentName` to the props interface:

```typescript
interface EventLineProps {
	event: SessionEvent;
	durationMs: number | null;
	streamingText?: string;
	isFirstInGroup?: boolean;
	onSelectAgent?: (agentId: string) => void;
	agentName?: string;
}
```

Update the function signature and both `AssistantMessage` render sites:

In the `plan_end` case (line 48):
```typescript
<AssistantMessage
	text={text}
	reasoning={reasoning}
	agentName={agentName}
	isFirstInGroup={isFirstInGroup}
	timestamp={event.timestamp}
/>
```

In the `plan_delta` case (line 156):
```typescript
<AssistantMessage
	text={streamingText}
	agentName={agentName}
	isFirstInGroup={isFirstInGroup}
	timestamp={event.timestamp}
/>
```

**Step 4: Add `agentName` to `GroupedEvent` and resolve it in `groupEvents`**

In `web/src/components/groupEvents.ts`, add `agentName` to the `GroupedEvent` interface:

```typescript
export interface GroupedEvent {
	event: SessionEvent;
	isFirstInGroup: boolean;
	isLastInGroup: boolean;
	durationMs: number | null;
	streamingText?: string;
	agentName?: string;
}
```

Add an agent name lookup map built from the tree. Add this helper at the top of the file:

```typescript
/** Build a flat map of agentId -> agentName from the tree. */
function buildNameMap(node: AgentTreeNode): Map<string, string> {
	const map = new Map<string, string>();
	function walk(n: AgentTreeNode) {
		map.set(n.agentId, n.agentName);
		for (const child of n.children) walk(child);
	}
	walk(node);
	return map;
}
```

In the `groupEvents` function, build the name map from the tree:

```typescript
const nameMap = tree ? buildNameMap(tree) : new Map<string, string>();
```

Then add `agentName` to every `result.push(...)` call and the `plan_delta` entry:

```typescript
// In the plan_delta handling:
const entry: GroupedEvent = {
	event,
	durationMs,
	isFirstInGroup: true,
	isLastInGroup: true,
	streamingText: streamBuffers.get(event.agent_id),
	agentName: nameMap.get(event.agent_id),
};

// In the default push:
result.push({
	event,
	durationMs,
	isFirstInGroup: true,
	isLastInGroup: true,
	agentName: nameMap.get(event.agent_id),
});
```

**Step 5: Pass `agentName` through ConversationView → EventLine**

In `web/src/components/ConversationView.tsx`, update the map to pass `agentName`:

```typescript
{grouped.map(({ event, durationMs, streamingText, isFirstInGroup, agentName }, i) => (
	<EventLine
		key={`${event.agent_id}-${event.kind}-${event.timestamp}-${i}`}
		event={event}
		durationMs={durationMs}
		streamingText={streamingText}
		isFirstInGroup={isFirstInGroup}
		onSelectAgent={onSelectAgent}
		agentName={agentName}
	/>
))}
```

Note: this also fixes the array-index key issue by using a composite key.

**Step 6: Wire `onSelectAgent` in App.tsx**

In `web/src/App.tsx`, add the `onSelectAgent` prop to the `ConversationView` render (line 165):

```typescript
<ConversationView
	events={events}
	agentFilter={selectedAgent}
	tree={tree}
	onSelectAgent={setSelectedAgent}
/>
```

**Step 7: Run tests**

Run: `cd web && bun test`
Expected: All tests pass including the new ones.

**Step 8: Commit**

```bash
git add web/src/App.tsx web/src/components/EventLine.tsx web/src/components/groupEvents.ts web/src/components/ConversationView.tsx web/src/components/__tests__/components.test.tsx
git commit -m "fix(web): wire thread navigation and resolve agent names for messages"
```

---

### Task 3: Fix InputArea Stop button and StatusBar controls

The InputArea "Stop" button calls `submitValue()` (which steers or does nothing), not interrupt. The StatusBar has two buttons (Pause/Stop) that both call the same handler. Cost is hardcoded to "$0.00".

**Files:**
- Modify: `web/src/components/InputArea.tsx`
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/components/__tests__/input-status.test.tsx`

**Step 1: Write failing test for InputArea stop behavior**

Add test to `input-status.test.tsx`:

```typescript
test("Stop button renders when running and calls onInterrupt", () => {
	const html = renderToStaticMarkup(
		<InputArea isRunning onSubmit={() => {}} onSlashCommand={() => {}} onSteer={() => {}} onInterrupt={() => {}} />,
	);
	expect(html).toContain("Stop");
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && bun test src/components/__tests__/input-status.test.tsx`
Expected: FAIL — `InputArea` does not accept `onInterrupt`.

**Step 3: Add `onInterrupt` to InputArea and wire the Stop button**

In `web/src/components/InputArea.tsx`, add `onInterrupt` to the props:

```typescript
export interface InputAreaProps {
	isRunning: boolean;
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void;
	onSteer: (text: string) => void;
	onInterrupt?: () => void;
	/** Optional external ref for focusing the textarea from outside. */
	textareaRef?: RefObject<HTMLTextAreaElement | null>;
}
```

Add it to the destructured props:

```typescript
export function InputArea({
	isRunning,
	onSubmit,
	onSlashCommand,
	onSteer,
	onInterrupt,
	textareaRef: externalRef,
}: InputAreaProps) {
```

Replace the button click handler: when `isRunning` and textarea is empty, call `onInterrupt`. When textarea has text, submit as steer:

```typescript
const handleSubmitClick = () => {
	if (isRunning && !value.trim() && onInterrupt) {
		onInterrupt();
	} else {
		submitValue();
	}
	textareaRef.current?.focus();
};
```

**Step 4: Wire `onInterrupt` in App.tsx**

In `web/src/App.tsx`, pass `onInterrupt` to `InputArea`:

```typescript
<InputArea
	isRunning={isRunning}
	onSubmit={handleSubmit}
	onSlashCommand={handleSlashCommand}
	onSteer={handleSteer}
	onInterrupt={handleInterrupt}
	textareaRef={inputRef}
/>
```

**Step 5: Consolidate StatusBar Pause/Stop into one Interrupt button**

In `web/src/components/StatusBar.tsx`, replace the two separate buttons with a single Interrupt button. There's no backend distinction between pause and stop, so showing two buttons is misleading:

```typescript
{runStatus === "running" && (
	<button
		type="button"
		className={styles.iconButton}
		onClick={onInterrupt}
		title="Interrupt"
	>
		{"\u23F9"}
	</button>
)}
```

**Step 6: Remove hardcoded cost display**

In `web/src/components/StatusBar.tsx`, remove line 64 (`<span>$0.00</span>`). Cost tracking is not implemented yet and showing "$0.00" is misleading.

**Step 7: Run tests**

Run: `cd web && bun test`
Expected: All tests pass. Some existing StatusBar tests may need updates if they assert on the two-button layout or "$0.00".

**Step 8: Commit**

```bash
git add web/src/components/InputArea.tsx web/src/components/StatusBar.tsx web/src/App.tsx web/src/components/__tests__/input-status.test.tsx
git commit -m "fix(web): InputArea Stop button calls onInterrupt, consolidate StatusBar controls"
```

---

### Task 4: Make Breadcrumb clickable and remove dead Sidebar prop

The Breadcrumb hover style implies interactivity but segments have no onClick. The Sidebar accepts `collapsed` but never reads it.

**Files:**
- Modify: `web/src/components/Breadcrumb.tsx`
- Modify: `web/src/components/Sidebar.tsx`
- Modify: `web/src/App.tsx:151`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Write failing test for clickable breadcrumb**

Add test to `components.test.tsx`:

```typescript
test("Breadcrumb segments include onClick handlers", () => {
	const tree = buildAgentTree([
		makeEvent("act_start", { agent_name: "child", goal: "g" }, { agent_id: "child-1", depth: 1 }),
	]);
	const html = renderToStaticMarkup(
		<Breadcrumb tree={tree} selectedAgent="child-1" onSelectAgent={() => {}} />,
	);
	// Segments should be rendered as buttons, not spans
	expect(html).toContain("button");
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && bun test src/components/__tests__/components.test.tsx`
Expected: FAIL — Breadcrumb doesn't accept `onSelectAgent` or render buttons.

**Step 3: Make Breadcrumb segments clickable**

In `web/src/components/Breadcrumb.tsx`:

1. Add `onSelectAgent` to the props interface.
2. Change `findPath` to return `{ name, agentId }` tuples instead of just names.
3. Render segments as `<button>` elements with `onClick` calling `onSelectAgent(agentId)`.

```typescript
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import styles from "./Breadcrumb.module.css";

interface BreadcrumbProps {
	tree: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent?: (agentId: string | null) => void;
}

interface PathSegment {
	name: string;
	agentId: string;
}

function findPath(node: AgentTreeNode, targetId: string): PathSegment[] | null {
	if (node.agentId === targetId) {
		return [{ name: node.agentName, agentId: node.agentId }];
	}
	for (const child of node.children) {
		const childPath = findPath(child, targetId);
		if (childPath) {
			return [{ name: node.agentName, agentId: node.agentId }, ...childPath];
		}
	}
	return null;
}

export function Breadcrumb({ tree, selectedAgent, onSelectAgent }: BreadcrumbProps) {
	if (!selectedAgent) return null;

	const path = findPath(tree, selectedAgent);
	if (!path) return null;

	return (
		<nav className={styles.breadcrumb}>
			{path.map((seg, i) => (
				<span key={seg.agentId}>
					{i > 0 && (
						<span className={styles.separator}>{"\u203A"}</span>
					)}
					<button
						type="button"
						className={styles.segment}
						onClick={() => onSelectAgent?.(i === 0 ? null : seg.agentId)}
					>
						{seg.name}
					</button>
				</span>
			))}
		</nav>
	);
}
```

**Step 4: Update Breadcrumb CSS for button styling**

In `web/src/components/Breadcrumb.module.css`, update `.segment` to look like a text button:

```css
.segment {
	color: var(--color-text-secondary);
	background: none;
	border: none;
	cursor: pointer;
	font: inherit;
	padding: 0;
}
```

**Step 5: Wire `onSelectAgent` to Breadcrumb in App.tsx**

In `web/src/App.tsx` line 164:

```typescript
<Breadcrumb tree={tree} selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} />
```

**Step 6: Remove dead `collapsed` prop from Sidebar**

In `web/src/components/Sidebar.tsx`, remove `collapsed` from `SidebarProps` and the destructured params.

In `web/src/App.tsx`, remove `collapsed={!sidebarOpen}` from the `<Sidebar>` render.

**Step 7: Run tests**

Run: `cd web && bun test`
Expected: All tests pass.

**Step 8: Commit**

```bash
git add web/src/components/Breadcrumb.tsx web/src/components/Breadcrumb.module.css web/src/components/Sidebar.tsx web/src/App.tsx web/src/components/__tests__/components.test.tsx
git commit -m "fix(web): make Breadcrumb segments clickable, remove dead Sidebar collapsed prop"
```

---

### Task 5: Wire StreamingBanner into ConversationView

StreamingBanner and TypingIndicator are built and tested but never rendered.

**Files:**
- Modify: `web/src/components/ConversationView.tsx`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Write failing test**

Add test to `components.test.tsx`:

```typescript
test("ConversationView shows StreamingBanner when last event is plan_delta", () => {
	const events: SessionEvent[] = [
		makeEvent("plan_delta", { text: "thinking..." }, { agent_id: "root", timestamp: 1000 }),
	];
	const tree = buildAgentTree([]);
	const html = renderToStaticMarkup(
		<ConversationView events={events} tree={tree} />,
	);
	expect(html).toContain("is responding");
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && bun test src/components/__tests__/components.test.tsx`
Expected: FAIL — "is responding" not in output.

**Step 3: Wire StreamingBanner at the bottom of ConversationView**

In `web/src/components/ConversationView.tsx`, import `StreamingBanner` and show it when the last visible event is a `plan_delta`:

```typescript
import { StreamingBanner } from "./StreamingBanner.tsx";

// Inside the component, after the grouped useMemo:
const isStreaming = events.length > 0 && events[events.length - 1]?.kind === "plan_delta";
const streamingAgentId = isStreaming ? events[events.length - 1]!.agent_id : null;

// In the JSX, after the map:
{isStreaming && streamingAgentId && (
	<StreamingBanner agentName={streamingAgentId} />
)}
```

**Step 4: Run tests**

Run: `cd web && bun test`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add web/src/components/ConversationView.tsx web/src/components/__tests__/components.test.tsx
git commit -m "feat(web): show StreamingBanner when agent is actively streaming"
```

---

### Task 6: Fix truncate, Escape behavior, and autoResize stale ref

Three smaller logic bugs: `truncate()` output exceeds `maxLen` by 2 characters, Escape in textarea should not clear agent filter, and `autoResize` has an empty dependency array.

**Files:**
- Modify: `web/src/components/format.ts:33-36`
- Modify: `web/src/hooks/useKeyboardShortcuts.ts:15-18`
- Modify: `web/src/components/InputArea.tsx:60-67`
- Modify: `web/src/components/__tests__/components.test.tsx`
- Modify: `web/src/hooks/__tests__/useKeyboardShortcuts.test.ts`

**Step 1: Write failing test for truncate**

Add test to `components.test.tsx`:

```typescript
test("smartArgs exec truncation respects maxLen", () => {
	const longCmd = "a".repeat(100);
	const result = smartArgs("exec", { command: longCmd });
	// Backticks add 2 chars, so the inner truncated string should be <=60
	// Total: 2 (backticks) + 57 (chars) + 3 (ellipsis) = 62
	expect(result.length).toBeLessThanOrEqual(62);
});
```

**Step 2: Write failing test for Escape in textarea**

Add test to `useKeyboardShortcuts.test.ts`:

```typescript
test("Escape in textarea does NOT trigger clearFilter", () => {
	let cleared = false;
	const actions: ShortcutActions = {
		toggleSidebar: () => {},
		clearFilter: () => { cleared = true; },
		focusInput: () => {},
	};
	const handled = handleKeyboardShortcut(
		{ key: "Escape", ctrlKey: false, metaKey: false, target: textareaTarget } as unknown as KeyboardEvent,
		actions,
	);
	expect(cleared).toBe(false);
	expect(handled).toBe(false);
});
```

**Step 3: Run tests to verify they fail**

Run: `cd web && bun test`
Expected: Both new tests FAIL.

**Step 4: Fix `truncate` — use `maxLen - 3` for the slice**

In `web/src/components/format.ts` line 35:

```typescript
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 3)}...`;
}
```

**Step 5: Fix Escape in useKeyboardShortcuts — skip when in input/textarea**

In `web/src/hooks/useKeyboardShortcuts.ts`, update the Escape handler to check the target:

```typescript
// Escape clears agent filter (only when not in an input/textarea)
if (event.key === "Escape") {
	const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
	if (tag === "input" || tag === "textarea" || tag === "select") {
		return false;
	}
	actions.clearFilter();
	return true;
}
```

**Step 6: Fix `autoResize` dependency array**

In `web/src/components/InputArea.tsx`, the `textareaRef` is derived from `externalRef ?? internalRef` on every render. Since `externalRef` is a stable ref object, `textareaRef` itself is stable. However, the dependency array should include it for correctness:

```typescript
const autoResize = useCallback(() => {
	const el = textareaRef.current;
	if (!el) return;
	el.style.height = "auto";
	const maxHeight = 10 * 20;
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
}, [textareaRef]);
```

**Step 7: Run tests**

Run: `cd web && bun test`
Expected: All tests pass.

**Step 8: Commit**

```bash
git add web/src/components/format.ts web/src/hooks/useKeyboardShortcuts.ts web/src/components/InputArea.tsx web/src/components/__tests__/components.test.tsx web/src/hooks/__tests__/useKeyboardShortcuts.test.ts
git commit -m "fix(web): truncate respects maxLen, Escape skips inputs, autoResize deps"
```

---

### Task 7: CSS token consistency cleanup

Multiple components use hardcoded colors instead of theme tokens: `#fff` in buttons, `rgba(...)` in badge, off-grid spacing in AgentTree, wrong body font in global.css, wrong responsive breakpoint.

**Files:**
- Modify: `web/src/components/InputArea.module.css:38,56`
- Modify: `web/src/components/UserMessage.module.css:48`
- Modify: `web/src/components/AgentTree.module.css:4,11,27,42-43,60,66,74-75,90`
- Modify: `web/src/styles/global.css:20`
- Modify: `web/src/App.module.css:58`
- Modify: `web/src/styles/themes.css` (add `--color-on-accent` token)

**Step 1: Add `--color-on-accent` token to themes.css**

Both themes need a "text on accent background" token. In `themes.css`:

Light theme:
```css
--color-on-accent: #ffffff;
```

Dark theme:
```css
--color-on-accent: #ffffff;
```

**Step 2: Replace hardcoded `#fff` in InputArea.module.css**

Replace `color: #fff` in `.sendBtn` and `.stopBtn` with `color: var(--color-on-accent)`.

**Step 3: Replace hardcoded `rgba(245, 158, 11, 0.1)` in UserMessage.module.css**

Replace `.badge` background with:
```css
background: color-mix(in srgb, var(--color-warning) 10%, transparent);
```

Note: `color-mix` has excellent browser support (96%+) and is already used implicitly through the theme system pattern.

**Step 4: Fix AgentTree.module.css spacing and radius**

Replace off-grid values with token variables:

| Line | Old | New |
|------|-----|-----|
| 4 | `gap: 4px` | `gap: var(--space-xs)` |
| 11 | `margin-bottom: 4px` | `margin-bottom: var(--space-xs)` |
| 27 | `padding: 0 4px` | `padding: 0 var(--space-xs)` |
| 42-43 | `padding: 4px 8px; border-radius: 3px` | `padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm)` |
| 60 | `padding-left: 12px` | `padding-left: var(--space-md)` |
| 66 | `gap: 6px` | `gap: var(--space-sm)` |
| 74-75 | `padding: 3px 8px; border-radius: 3px` | `padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm)` |
| 90 | `font-weight: bold` | `font-weight: 600` |

**Step 5: Fix body font in global.css**

Replace line 20:
```css
font-family: var(--font-ui);
```

**Step 6: Fix responsive breakpoint in App.module.css**

Replace line 58:
```css
@media (max-width: 1024px) {
```

**Step 7: Run tests**

Run: `cd web && bun test`
Expected: All tests pass (CSS changes don't affect test logic).

**Step 8: Commit**

```bash
git add web/src/styles/themes.css web/src/components/InputArea.module.css web/src/components/UserMessage.module.css web/src/components/AgentTree.module.css web/src/styles/global.css web/src/App.module.css
git commit -m "fix(web): replace hardcoded colors with tokens, fix spacing and breakpoint"
```

---

### Task 8: Remove dead code

Remove backward-compat aliases that nothing uses, and the `lastMessage` tracking that nothing consumes.

**Files:**
- Modify: `web/src/styles/variables.css:31-59`
- Modify: `web/src/hooks/useWebSocket.ts` (remove `lastMessage` from state/return)

**Step 1: Remove backward-compat aliases from variables.css**

Delete lines 31-59 (the entire backward-compat alias block) from `web/src/styles/variables.css`. Verify nothing references them:

Run: `grep -r "bg-primary\|bg-secondary\|bg-surface\|bg-input\|text-primary\|text-secondary\|text-dim\|color-cyan\|color-green\|color-red\|color-yellow\|color-blue\|color-magenta\|color-agent\|color-tool\|color-user\|border-color\|border-active\|statusbar-bg\|statusbar-text" web/src/ --include='*.css' --include='*.tsx' --include='*.ts'`

Expected: No matches (all components were migrated in the redesign).

**Step 2: Remove `lastMessage` from useWebSocket**

In `web/src/hooks/useWebSocket.ts`:

1. Remove `lastMessage` from `WebSocketState` interface (line 158).
2. Remove `lastMessage: null` from the initial state ref (line 178).
3. Remove `lastMessage: client.lastMessage` from both snapshot updates (lines 182, 187).
4. Remove `lastMessage: state.lastMessage` from the return (line 216).

Keep the `lastMessage` property on `WebSocketClient` itself — it's part of the class's internal state and removing it could affect the test suite.

**Step 3: Run tests**

Run: `cd web && bun test`
Expected: All tests pass.

Run: `bun test` (full suite)
Expected: All 1466+ tests pass.

**Step 4: Commit**

```bash
git add web/src/styles/variables.css web/src/hooks/useWebSocket.ts
git commit -m "chore(web): remove dead backward-compat aliases and unused lastMessage state"
```

---

## Task Dependency Summary

```
[Task 1] (hook fixes — must go first)
     ↓
[Task 2, 3, 4, 5, 6, 7, 8] (all independent, can run in parallel)
```

Task 1 modifies the hooks that other tasks' code may touch. Tasks 2-8 are independent of each other and can be executed in any order or in parallel.
