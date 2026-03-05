# Web Interface Round 2 Fixes Implementation Plan

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

**Goal:** Fix all issues found by the second three-reviewer audit of the web interface.

**Architecture:** Fixes are grouped by subsystem. Code bugs first (correctness), then accessibility/UX, then CSS/cleanup, then test coverage. Each task is independent — no ordering dependencies this time.

**Tech Stack:** React 19, TypeScript, CSS Modules, Bun test runner, `renderToStaticMarkup` for component tests.

**Test command:** `bun test web/` (web tests only, from project root)

**Full test command:** `bun test` (all tests, from project root)

---

## Issue Inventory

Every issue from the three-reviewer audit, grouped into tasks:

| # | Issue | Severity | Task |
|---|-------|----------|------|
| 1 | StreamingBanner shows raw agent_id instead of resolved name | Critical | 1 |
| 2 | `session_clear` event appended then immediately discarded — never rendered | Important | 2 |
| 3 | `subscribe()` in useWebSocket triggers re-render on every message | Important | 3 |
| 4 | `ws://` fallback breaks HTTPS deployments | Important | 4 |
| 5 | StatusBar session ID `<span>` with onClick has no keyboard accessibility | Important | 5 |
| 6 | `DelegationBlock` goal truncation off-by-one (82 chars, not 80) | Minor | 6 |
| 7 | `learn_signal`/`learn_end` not in INVISIBLE_KINDS — pass through grouping as invisible noise | Minor | 6 |
| 8 | `StatusBar.module.css` hardcoded `8px`/`12px` instead of spacing tokens | Minor | 6 |
| 9 | `Breadcrumb.module.css` hardcoded `4px`/`2px` not tokenized | Minor | 6 |
| 10 | Dark theme CSS defined but never activated | Minor | 7 |
| 11 | `InputArea` `maxHeight` hardcoded `10 * 20` doesn't match actual line-height | Minor | 6 |
| 12 | Test: `AgentTree` component has no test file | Important | 8 |
| 13 | Test: `Breadcrumb` test is vacuous — no click or edge case coverage | Important | 9 |
| 14 | Test: `groupEvents` multi-agent plan_delta deduplication untested | Important | 10 |
| 15 | Test: `groupEvents` 60-second boundary condition not tested | Minor | 10 |
| 16 | Test: `ConversationView` empty-state test asserts `toBeDefined()` (vacuously true) | Minor | 10 |

**Issues investigated and excluded:**

| # | Issue | Reason for exclusion |
|---|-------|---------------------|
| E1 | `EventLine` `act_start` passes parent agent_id to `onOpenThread` | Investigation showed `act_start` events use the parent's `agent_id` at the parent's depth. However, the tree builder (`useAgentTree.ts:63`) stores `event.agent_id` as the child node's `agentId`. This means the tree assigns the parent's ID to child nodes, and `EventLine` navigates to `event.agent_id` — which matches the tree's lookup. The design is self-consistent (parent ID flows through both tree and EventLine), even if the naming is misleading. No functional bug. |
| E2 | `MarkdownBlock` `md.parse({ async: false })` cast is fragile | The `marked` library's `parse()` with `{ async: false }` is the documented synchronous API. The cast is safe and matches the library's actual behavior. Not worth changing. |
| E3 | e2e tests use `delay()` instead of `waitFor()` | The e2e tests run against a real WebSocket server with fast local message delivery. The delays are conservative (100-200ms) and these tests have never flaked. Converting to `waitFor` would be nice but is low priority and doesn't fix a real problem. |
| E4 | `InputArea` behavioral contract untested (submit/steer/history) | These behaviors require DOM interaction (keypress events, cursor position checks) that `renderToStaticMarkup` cannot exercise. Testing them properly requires a full DOM environment (jsdom or browser). Out of scope for this plan — would need a test infrastructure change. |
| E5 | `ToolRendererRegistry` has no test | The registry is a trivial mapping with no logic beyond `??`. Testing it adds no value. |
| E6 | `ToolCall` output hint logic untested | The hint logic is three lines of straightforward string splitting. Low risk, low value to test. |
| E7 | `useFaviconStatus` URL encoding untested | The hook uses `encodeURIComponent` on SVG containing `#` characters. `encodeURIComponent` handles `#` correctly (encodes to `%23`). No bug to test for. |
| E8 | `format.ts` `str !== undefined` vacuously true guard | Harmless defensive code. Not worth a commit to remove. |
| E9 | React keys include array index | The composite keys (`${agent_id}-${kind}-${timestamp}-${i}`) are sufficient for reconciliation. The index suffix handles the edge case of two events from the same agent with identical kind and timestamp. Not a bug. |

---

### Task 1: Fix StreamingBanner to show resolved agent name

StreamingBanner receives the raw `agent_id` (e.g. UUID or internal name) instead of the human-readable name from the agent tree. The name map is already available via `groupEvents` but the streaming banner computation bypasses it.

**Files:**
- Modify: `web/src/components/ConversationView.tsx:31-32,48`
- Test: `web/src/components/__tests__/components.test.tsx`

**Step 1: Write failing test**

Add test to `components.test.tsx`:

```typescript
test("StreamingBanner shows resolved agent name, not raw ID", () => {
	const events: SessionEvent[] = [
		makeEvent("act_start", { agent_name: "code-editor", goal: "edit" }, { agent_id: "ce-1", depth: 1 }),
		makeEvent("plan_delta", { text: "thinking..." }, { agent_id: "ce-1", timestamp: 1000 }),
	];
	const tree = buildAgentTree(events);
	const html = renderToStaticMarkup(
		<ConversationView events={events} tree={tree} />,
	);
	// Should show the resolved name, not the raw agent_id
	expect(html).toContain("code-editor");
	expect(html).toContain("is responding");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test web/src/components/__tests__/components.test.tsx`
Expected: FAIL — banner shows raw `"ce-1"` instead of `"code-editor"`.

**Step 3: Fix ConversationView to resolve agent name for StreamingBanner**

In `web/src/components/ConversationView.tsx`, import `buildNameMap` logic and resolve the name. The simplest approach is to use the tree's name map (already computed inside `groupEvents`) by extracting the resolution into the component:

```typescript
// Replace lines 31-32 and update line 48:

const isStreaming = events.length > 0 && events[events.length - 1]?.kind === "plan_delta";
const streamingAgentName = useMemo(() => {
	if (!isStreaming) return null;
	const agentId = events[events.length - 1]!.agent_id;
	// Walk tree to find the name for this agent ID
	function findName(node: AgentTreeNode): string | null {
		if (node.agentId === agentId) return node.agentName;
		for (const child of node.children) {
			const found = findName(child);
			if (found) return found;
		}
		return null;
	}
	return findName(tree) ?? agentId;
}, [isStreaming, events, tree]);

// In JSX:
{isStreaming && streamingAgentName && (
	<StreamingBanner agentName={streamingAgentName} />
)}
```

Add `useMemo` to the import from `react`.

**Step 4: Run tests**

Run: `bun test web/`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add web/src/components/ConversationView.tsx web/src/components/__tests__/components.test.tsx
git commit -m "fix(web): resolve agent name for StreamingBanner instead of showing raw ID"
```

---

### Task 2: Fix session_clear event rendering

When a `session_clear` event arrives, `EventStore.processMessage` appends it to `this.events` and then immediately replaces `this.events` with `[]`. The clear event is lost and the "New session started" system message is never shown.

**Files:**
- Modify: `web/src/hooks/useEvents.ts:59-65`
- Test: `web/src/hooks/__tests__/useEvents.test.ts`

**Step 1: Write failing test**

Add test to `useEvents.test.ts`. Read the existing test file first to understand its helper conventions.

```typescript
test("session_clear event is preserved in events array", () => {
	const store = new EventStore();

	// Send a goal event first, then session_clear
	store.processMessage({
		type: "event",
		event: {
			kind: "perceive",
			agent_id: "root",
			depth: 0,
			timestamp: 1000,
			data: { goal: "test" },
		},
	} as ServerMessage);

	store.processMessage({
		type: "event",
		event: {
			kind: "session_clear",
			agent_id: "root",
			depth: 0,
			timestamp: 2000,
			data: { new_session_id: "new-session" },
		},
	} as ServerMessage);

	// The session_clear event itself should be the ONLY event remaining
	// (previous events are cleared, but session_clear is kept)
	expect(store.events).toHaveLength(1);
	expect(store.events[0]!.kind).toBe("session_clear");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test web/src/hooks/__tests__/useEvents.test.ts`
Expected: FAIL — `store.events` is empty (`[]`), not `[session_clear]`.

**Step 3: Fix EventStore to keep the session_clear event**

In `web/src/hooks/useEvents.ts`, change the `session_clear` handling so the clear event itself is preserved:

```typescript
case "event":
	this.events = [...this.events, msg.event];
	this.applyEventToStatus(msg.event);
	if (msg.event.kind === "session_clear") {
		// Clear prior events but keep the session_clear event itself
		// so the UI can render a "New session started" message.
		this.events = [msg.event];
	}
	break;
```

**Step 4: Run tests**

Run: `bun test web/`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add web/src/hooks/useEvents.ts web/src/hooks/__tests__/useEvents.test.ts
git commit -m "fix(web): preserve session_clear event so 'New session' message renders"
```

---

### Task 3: Remove spurious re-renders from useWebSocket subscribe

The `subscribe` function in `useWebSocket` subscribes to both `onMessage` and `onStateChange`, calling `onStoreChange()` for every incoming message even when `connected` hasn't changed. Since the snapshot only tracks `{ connected: boolean }`, the message subscription is redundant and causes unnecessary React re-renders under high throughput.

**Files:**
- Modify: `web/src/hooks/useWebSocket.ts:179-197`
- Test: `test/web/websocket-client.test.ts`

**Step 1: Write failing test**

Add test to `websocket-client.test.ts`. Read the file first to understand its helpers.

The test should verify that `subscribe`'s `onStoreChange` is only called when connection state actually changes, not on every message.

```typescript
test("useWebSocket subscribe only fires onStoreChange for connection state changes, not messages", async () => {
	// This test verifies the hook-level behavior by testing the client's
	// stateChange listener separately from its message listener.
	// After the fix, subscribe() should only listen to onStateChange,
	// not onMessage, since the snapshot only tracks { connected }.

	const client = new WebSocketClient(`ws://localhost:${port}`);
	client.connect();
	await waitFor(() => client.connected);

	let stateChangeCount = 0;
	client.onStateChange(() => { stateChangeCount++; });

	let messageCount = 0;
	client.onMessage(() => { messageCount++; });

	// Send a message — should trigger onMessage but NOT onStateChange
	client.send({ type: "command", command: { kind: "steer", data: { text: "hello" } } });
	await waitFor(() => messageCount >= 1);

	// stateChangeCount should still be 0 (only the initial connect changed state,
	// which happened before we subscribed)
	expect(stateChangeCount).toBe(0);

	client.dispose();
});
```

Actually, this tests the client, not the hook. The real fix is in the hook's `subscribe` callback. Since we can't easily test the hook without a DOM, let's write a conceptual test and then just make the fix.

**Step 2: Fix subscribe to only listen for state changes**

In `web/src/hooks/useWebSocket.ts`, remove the `onMessage` subscription from `subscribe` since it only needs to track `connected`:

```typescript
const subscribe = useCallback(
	(onStoreChange: () => void) => {
		const unsubState = client.onStateChange(() => {
			stateRef.current = { connected: client.connected };
			onStoreChange();
		});

		return () => {
			unsubState();
		};
	},
	[client],
);
```

**Step 3: Run tests**

Run: `bun test web/`
Expected: All tests pass. The `useEvents` hook drives event processing via `onMessage` independently — removing `onMessage` from `subscribe` does not affect event flow.

**Step 4: Commit**

```bash
git add web/src/hooks/useWebSocket.ts
git commit -m "fix(web): remove spurious onMessage from useWebSocket subscribe to reduce re-renders"
```

---

### Task 4: Fix WS URL fallback for HTTPS

The app hardcodes `ws://` as the WebSocket protocol fallback, which breaks when served over HTTPS due to mixed-content blocking.

**Files:**
- Modify: `web/src/App.tsx:15`

**Step 1: Fix the URL computation**

In `web/src/App.tsx`, replace line 15:

```typescript
const WS_URL = import.meta.env.VITE_WS_URL ||
	`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
```

**Step 2: Run tests**

Run: `bun test web/`
Expected: All tests pass (the e2e tests use `VITE_WS_URL` override, so this fallback path isn't exercised in tests, but the logic is straightforward).

**Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "fix(web): use wss:// when served over HTTPS to prevent mixed-content blocking"
```

---

### Task 5: Make StatusBar session ID accessible

The session ID is a `<span>` with an `onClick` handler — it's not keyboard-reachable and has no ARIA semantics. Replace it with a `<button>`.

**Files:**
- Modify: `web/src/components/StatusBar.tsx:86-93`
- Modify: `web/src/components/StatusBar.module.css:59-68`
- Test: `web/src/components/__tests__/input-status.test.tsx`

**Step 1: Write failing test**

Add test to `input-status.test.tsx`:

```typescript
test("session ID is rendered as a button for keyboard accessibility", () => {
	const html = renderToStaticMarkup(
		<StatusBar status={makeStatus()} connected onInterrupt={() => {}} />,
	);
	// Session ID should be a button, not a span
	expect(html).toContain('data-action="copy-session-id"');
	// Check it's wrapped in a button element
	const match = html.match(/(<\w+)[^>]*data-action="copy-session-id"/);
	expect(match?.[1]).toBe("<button");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test web/src/components/__tests__/input-status.test.tsx`
Expected: FAIL — match is `"<span"` not `"<button"`.

**Step 3: Replace span with button in StatusBar**

In `web/src/components/StatusBar.tsx`, replace lines 86-93:

```typescript
<button
	type="button"
	className={styles.sessionId}
	data-action="copy-session-id"
	onClick={handleCopySessionId}
	title="Click to copy session ID"
>
	{sessionId}
</button>
```

**Step 4: Update CSS for button reset**

In `web/src/components/StatusBar.module.css`, update `.sessionId` (lines 60-64):

```css
.sessionId {
	color: var(--color-text-tertiary);
	cursor: pointer;
	flex-shrink: 0;
	background: none;
	border: none;
	font: inherit;
	padding: 0;
}
```

**Step 5: Run tests**

Run: `bun test web/`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add web/src/components/StatusBar.tsx web/src/components/StatusBar.module.css web/src/components/__tests__/input-status.test.tsx
git commit -m "fix(web): make session ID a button for keyboard accessibility"
```

---

### Task 6: Fix minor code bugs and CSS tokens

Several small bugs and CSS inconsistencies:
- `DelegationBlock` truncation: `slice(0, 79) + "..."` = 82 chars, not 80
- `learn_signal`/`learn_end` not in `INVISIBLE_KINDS` — they pass through grouping then render as `null`
- `StatusBar.module.css` uses raw `8px`/`12px`
- `Breadcrumb.module.css` uses raw `4px`/`2px`
- `InputArea` `maxHeight` constant doesn't match actual line-height

**Files:**
- Modify: `web/src/components/DelegationBlock.tsx:17-18`
- Modify: `web/src/components/groupEvents.ts:14-21`
- Modify: `web/src/components/StatusBar.module.css:4-5,20-21`
- Modify: `web/src/components/Breadcrumb.module.css:4,14`
- Modify: `web/src/components/InputArea.tsx:62-68`
- Test: `web/src/components/__tests__/components.test.tsx`

**Step 1: Write failing test for DelegationBlock truncation**

Add test to `components.test.tsx`:

```typescript
test("DelegationBlock truncates goal to exactly 80 characters", () => {
	const longGoal = "a".repeat(100);
	const html = renderToStaticMarkup(
		<DelegationBlock agentName="agent" goal={longGoal} status="running" />,
	);
	// The displayed goal should be at most 80 chars: 77 chars + "..."
	const goalMatch = html.match(/(a+)\.\.\./);
	expect(goalMatch).toBeTruthy();
	expect(goalMatch![1]!.length + 3).toBe(80);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test web/src/components/__tests__/components.test.tsx`
Expected: FAIL — 79 + 3 = 82, not 80.

**Step 3: Fix DelegationBlock truncation**

In `web/src/components/DelegationBlock.tsx`, replace lines 17-18:

```typescript
const displayGoal =
	goal.length > 80 ? `${goal.slice(0, 77)}...` : goal;
```

**Step 4: Add `learn_signal` and `learn_end` to INVISIBLE_KINDS**

In `web/src/components/groupEvents.ts`, update the `INVISIBLE_KINDS` set (lines 14-21):

```typescript
const INVISIBLE_KINDS = new Set([
	"context_update",
	"exit_hint",
	"session_start",
	"session_end",
	"recall",
	"verify",
	"learn_signal",
	"learn_end",
]);
```

Note: `learn_start` and `learn_mutation` are NOT added — `EventLine` renders them as `SystemMessage` components.

**Step 5: Fix StatusBar.module.css tokens**

In `web/src/components/StatusBar.module.css`:

Line 4: `gap: 8px;` → `gap: var(--space-sm);`
Line 5: `padding: 0 12px;` → `padding: 0 var(--space-md);`
Line 20-21: `gap: 8px;` → `gap: var(--space-sm);` (in `.leftGroup, .rightGroup`)

**Step 6: Fix Breadcrumb.module.css tokens**

In `web/src/components/Breadcrumb.module.css`:

Line 4: `gap: 2px;` → `gap: var(--space-xs);`
Line 14: `margin: 0 4px;` → `margin: 0 var(--space-xs);`

**Step 7: Fix InputArea maxHeight**

In `web/src/components/InputArea.tsx`, update the `autoResize` callback. The CSS sets `line-height: 1.5` on `font-size: 15px` (= `--font-size-base`), so actual line height is ~22.5px. Round to 23px for the JS calculation:

```typescript
const autoResize = useCallback(() => {
	const el = textareaRef.current;
	if (!el) return;
	el.style.height = "auto";
	const maxHeight = 10 * 23; // 10 lines × ~23px (15px font × 1.5 line-height)
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
}, [textareaRef]);
```

Also update the CSS `max-height` in `InputArea.module.css` to match:

Line 24: `max-height: calc(20px * 10);` → `max-height: calc(23px * 10);`

**Step 8: Run tests**

Run: `bun test web/`
Expected: All tests pass.

**Step 9: Commit**

```bash
git add web/src/components/DelegationBlock.tsx web/src/components/groupEvents.ts web/src/components/StatusBar.module.css web/src/components/Breadcrumb.module.css web/src/components/InputArea.tsx web/src/components/InputArea.module.css web/src/components/__tests__/components.test.tsx
git commit -m "fix(web): fix truncation, add invisible kinds, tokenize spacing, fix maxHeight"
```

---

### Task 7: Add dark mode auto-detection

The dark theme CSS is defined but never activated. Add `prefers-color-scheme` detection.

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/App.tsx` (or create a small inline script in index.html)

**Step 1: Add theme detection script to index.html**

In `web/index.html`, add a `<script>` block in the `<head>` (before stylesheets load) that sets the initial theme:

```html
<script>
	(function() {
		var theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
		document.documentElement.setAttribute('data-theme', theme);
	})();
</script>
```

Also change the default `data-theme="light"` on the `<html>` element to just `data-theme="light"` (as a fallback for when JS is disabled — keeping it light by default is safe).

**Step 2: Add a listener in App.tsx for live theme switching**

In `web/src/App.tsx`, add a `useEffect` that listens for `prefers-color-scheme` changes:

```typescript
// Theme detection: follow OS dark/light preference
useEffect(() => {
	const mq = window.matchMedia("(prefers-color-scheme: dark)");
	const update = (e: MediaQueryListEvent | MediaQueryList) => {
		document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
	};
	update(mq);
	mq.addEventListener("change", update);
	return () => mq.removeEventListener("change", update);
}, []);
```

**Step 3: Run tests**

Run: `bun test web/`
Expected: All tests pass (theme detection is a DOM side effect; no unit test coverage needed).

**Step 4: Commit**

```bash
git add web/index.html web/src/App.tsx
git commit -m "feat(web): auto-detect dark mode from OS prefers-color-scheme"
```

---

### Task 8: Add AgentTree component tests

`AgentTree.tsx` has multiple untested branches: `truncateGoal`, `statusIcon`, recursive `TreeNode`, selection state, toggle button.

**Files:**
- Create: `web/src/components/__tests__/agent-tree.test.tsx`

**Step 1: Write tests**

Create `web/src/components/__tests__/agent-tree.test.tsx`:

```typescript
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAgentTree } from "../../hooks/useAgentTree.ts";
import { AgentTree } from "../AgentTree.tsx";

function makeEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown> = {}) {
	return {
		kind,
		agent_id: agentId,
		depth,
		timestamp: Date.now(),
		data,
	};
}

describe("AgentTree", () => {
	test("renders root node with agent name and goal", () => {
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Fix the bug" }),
		];
		const tree = buildAgentTree(events as any);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("root");
		expect(html).toContain("Fix the bug");
	});

	test("renders child nodes recursively", () => {
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Fix" }),
			makeEvent("act_start", "child-1", 1, { agent_name: "code-editor", goal: "Edit file" }),
		];
		const tree = buildAgentTree(events as any);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("code-editor");
		expect(html).toContain("Edit file");
	});

	test("truncates long goals to 60 characters", () => {
		const longGoal = "a".repeat(100);
		const events = [
			makeEvent("perceive", "root", 0, { goal: longGoal }),
		];
		const tree = buildAgentTree(events as any);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain("...");
		expect(html).not.toContain(longGoal);
	});

	test("shows completed status icon for completed agents", () => {
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Fix" }),
			makeEvent("act_start", "child-1", 1, { agent_name: "editor", goal: "Edit" }),
			makeEvent("act_end", "child-1", 1, { agent_name: "editor", success: true }),
		];
		const tree = buildAgentTree(events as any);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// ✓ for completed
		expect(html).toContain("\u2713");
	});

	test("shows failed status icon for failed agents", () => {
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Fix" }),
			makeEvent("act_start", "child-1", 1, { agent_name: "editor", goal: "Edit" }),
			makeEvent("act_end", "child-1", 1, { agent_name: "editor", success: false }),
		];
		const tree = buildAgentTree(events as any);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		// ✗ for failed
		expect(html).toContain("\u2717");
	});

	test("marks selected agent with data-selected attribute", () => {
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Fix" }),
			makeEvent("act_start", "child-1", 1, { agent_name: "editor", goal: "Edit" }),
		];
		const tree = buildAgentTree(events as any);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent="child-1" onSelectAgent={() => {}} />,
		);
		expect(html).toContain('data-selected="true"');
	});

	test("All agents button has data-selected when no agent selected", () => {
		const tree = buildAgentTree([]);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).toContain('data-agent-id="all"');
		expect(html).toContain('data-selected="true"');
	});

	test("renders toggle button when onToggle provided", () => {
		const tree = buildAgentTree([]);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} onToggle={() => {}} />,
		);
		expect(html).toContain('data-action="toggle"');
	});

	test("does not render toggle button when onToggle omitted", () => {
		const tree = buildAgentTree([]);
		const html = renderToStaticMarkup(
			<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
		);
		expect(html).not.toContain('data-action="toggle"');
	});
});
```

**Step 2: Run tests**

Run: `bun test web/src/components/__tests__/agent-tree.test.tsx`
Expected: All tests pass (these test existing behavior, not new behavior).

**Step 3: Commit**

```bash
git add web/src/components/__tests__/agent-tree.test.tsx
git commit -m "test(web): add AgentTree component test coverage"
```

---

### Task 9: Strengthen Breadcrumb tests

The existing test only checks for substring presence. Add tests for click behavior, null selectedAgent, missing path, and the root-click-clears-filter behavior.

**Files:**
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Add Breadcrumb tests**

Add to the existing Breadcrumb describe block in `components.test.tsx`:

```typescript
test("Breadcrumb returns null when selectedAgent is null", () => {
	const tree = buildAgentTree([]);
	const html = renderToStaticMarkup(
		<Breadcrumb tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
	);
	expect(html).toBe("");
});

test("Breadcrumb returns null when agent is not in tree", () => {
	const tree = buildAgentTree([]);
	const html = renderToStaticMarkup(
		<Breadcrumb tree={tree} selectedAgent="nonexistent" onSelectAgent={() => {}} />,
	);
	expect(html).toBe("");
});

test("Breadcrumb renders separator between segments", () => {
	const events = [
		makeEvent("act_start", { agent_name: "child", goal: "g" }, { agent_id: "child-1", depth: 1 }),
	];
	const tree = buildAgentTree(events);
	const html = renderToStaticMarkup(
		<Breadcrumb tree={tree} selectedAgent="child-1" onSelectAgent={() => {}} />,
	);
	// \u203A is the separator character
	expect(html).toContain("\u203A");
});
```

**Step 2: Run tests**

Run: `bun test web/src/components/__tests__/components.test.tsx`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add web/src/components/__tests__/components.test.tsx
git commit -m "test(web): strengthen Breadcrumb tests with edge cases"
```

---

### Task 10: Add groupEvents multi-agent and boundary tests, fix vacuous test

Three test coverage gaps: multi-agent `plan_delta` deduplication, 60-second grouping boundary, and vacuously-true `ConversationView` empty test.

**Files:**
- Modify: `web/src/components/__tests__/groupEvents.test.ts`
- Modify: `web/src/components/__tests__/components.test.tsx`

**Step 1: Add multi-agent plan_delta test**

Add to `groupEvents.test.ts`:

```typescript
test("plan_delta events from different agents are tracked independently", () => {
	const events = [
		makeEvent("plan_delta", "agent-a", 0, { text: "hello " }),
		makeEvent("plan_delta", "agent-b", 0, { text: "world " }),
		makeEvent("plan_delta", "agent-a", 0, { text: "from A" }),
		makeEvent("plan_delta", "agent-b", 0, { text: "from B" }),
	];
	const grouped = groupEvents(events as any);

	// Should have exactly 2 entries (one per agent, collapsed)
	expect(grouped).toHaveLength(2);

	const entryA = grouped.find((g) => g.event.agent_id === "agent-a");
	const entryB = grouped.find((g) => g.event.agent_id === "agent-b");
	expect(entryA).toBeTruthy();
	expect(entryB).toBeTruthy();
	expect(entryA!.streamingText).toBe("hello from A");
	expect(entryB!.streamingText).toBe("world from B");
});
```

**Step 2: Add 60-second boundary test**

Add to `groupEvents.test.ts`:

```typescript
test("exactly 60 seconds between events does NOT break the group", () => {
	const events = [
		{ kind: "plan_end", agent_id: "root", depth: 0, timestamp: 1000, data: { text: "a" } },
		{ kind: "plan_end", agent_id: "root", depth: 0, timestamp: 61000, data: { text: "b" } },
	];
	const grouped = groupEvents(events as any);
	expect(grouped).toHaveLength(2);
	// 61000 - 1000 = 60000ms exactly = not > 60_000, so they should be grouped
	expect(grouped[0]!.isLastInGroup).toBe(false);
	expect(grouped[1]!.isFirstInGroup).toBe(false);
});

test("61 seconds between events DOES break the group", () => {
	const events = [
		{ kind: "plan_end", agent_id: "root", depth: 0, timestamp: 1000, data: { text: "a" } },
		{ kind: "plan_end", agent_id: "root", depth: 0, timestamp: 62000, data: { text: "b" } },
	];
	const grouped = groupEvents(events as any);
	expect(grouped).toHaveLength(2);
	// 62000 - 1000 = 61000ms > 60_000, so group is broken
	expect(grouped[0]!.isLastInGroup).toBe(true);
	expect(grouped[1]!.isFirstInGroup).toBe(true);
});
```

**Step 3: Fix vacuous ConversationView empty test**

In `components.test.tsx`, replace the vacuous `toBeDefined()` assertion:

Find:
```typescript
test("renders empty state when no events", () => {
	const tree = buildAgentTree([]);
	const html = renderToStaticMarkup(<ConversationView events={[]} tree={tree} />);
	expect(html).toBeDefined();
});
```

Replace with:
```typescript
test("renders empty container when no events", () => {
	const tree = buildAgentTree([]);
	const html = renderToStaticMarkup(<ConversationView events={[]} tree={tree} />);
	// Should render the container div but with no event children or streaming banner
	expect(html).toContain("div");
	expect(html).not.toContain("is responding");
});
```

**Step 4: Run tests**

Run: `bun test web/`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add web/src/components/__tests__/groupEvents.test.ts web/src/components/__tests__/components.test.tsx
git commit -m "test(web): add multi-agent delta, boundary, and empty-state test coverage"
```

---

## Task Dependency Summary

```
[Task 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] — all independent, can run in parallel
```

No ordering dependencies exist between any tasks.
