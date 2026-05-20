# Active Subagent Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which subagent is currently working in both the web UI and terminal UI instead of showing only a generic running state.

**Architecture:** Add one shared display/derivation module that understands Sprout's agent identity fields (`mnemonic_name`, `target_agent_name`, `agent_name`, `handle_id`, `child_id`). Web and TUI status bars consume that shared module, and terminal event renderers use the same identity formatter for delegation lines. The helper infers active child work from delegation lifecycle events, child session events, and pending `wait_agent`/`message_agent` tool calls; it also distinguishes post-run memory work as "Saving memory" when controller status is still running after a root `session_end`.

**Tech Stack:** TypeScript, Bun tests, React, Ink, existing `SessionEvent` records.

---

## File Structure

- Create `src/shared/agent-display.ts`
  - Owns reusable agent identity formatting and active-work derivation.
  - Exports `AgentDisplayRef`, `ActiveAgentWork`, `formatAgentDisplayName`, `formatActiveAgentWork`, and `deriveActiveAgentWork`.

- Create `test/shared/agent-display.test.ts`
  - Unit tests for mnemonic/role formatting, active child detection, shared-child reactivation, pending agent commands, and post-run memory saving.

- Modify `web/src/App.tsx`
  - Calls `deriveActiveAgentWork(events, status.status)` and passes the result to `StatusBar`.

- Modify `web/src/components/StatusBar.tsx`
  - Accepts optional `activeWork?: ActiveAgentWork | null`.
  - Renders compact active work text next to the run status.

- Modify `web/src/components/StatusBar.module.css`
  - Adds styles for the active work label/value.

- Modify `web/src/components/__tests__/status-bar.test.tsx`
  - Tests direct rendering of `Waiting on Brunelleschi · architect` and `Saving memory`.

- Modify `src/tui/app.tsx`
  - Keeps a small event history for status derivation and passes `activeWork` to the TUI status bar.

- Modify `src/tui/status-bar.tsx`
  - Accepts optional `activeWork?: ActiveAgentWork | null`.
  - Renders active work in the left side while running.

- Modify `test/tui/status-bar.test.tsx`
  - Tests direct TUI status bar rendering for active child and memory saving.

- Modify `test/tui/app.test.tsx`
  - Tests that live child events update the TUI status bar.

- Modify `src/tui/render-event.ts`
  - Uses `formatAgentDisplayName` for `act_start` and `act_end` output.

- Modify `src/tui/event-components.tsx`
  - Uses `formatAgentDisplayName` for interactive TUI delegation start/end lines.

- Modify `test/tui/render-event.test.ts`
  - Tests mnemonic plus role in one-shot terminal output.

- Modify `test/tui/conversation-view.test.tsx`
  - Tests mnemonic plus role in interactive TUI delegation lines.

---

### Task 1: Shared Agent Display And Active Work Derivation

**Files:**
- Create: `src/shared/agent-display.ts`
- Create: `test/shared/agent-display.test.ts`

- [ ] **Step 1: Write the failing formatter tests**

Add `test/shared/agent-display.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/kernel/types.ts";
import {
	deriveActiveAgentWork,
	formatActiveAgentWork,
	formatAgentDisplayName,
} from "../../src/shared/agent-display.ts";

function event(
	kind: SessionEvent["kind"],
	data: Record<string, unknown>,
	overrides: Partial<SessionEvent> = {},
): SessionEvent {
	return {
		kind,
		timestamp: overrides.timestamp ?? Date.now(),
		agent_id: overrides.agent_id ?? "root",
		depth: overrides.depth ?? 0,
		data,
	};
}

describe("formatAgentDisplayName", () => {
	test("uses mnemonic as the primary name and role as secondary text", () => {
		expect(formatAgentDisplayName({ agentName: "architect", mnemonicName: "Brunelleschi" }))
			.toBe("Brunelleschi · architect");
	});

	test("falls back to agent name when there is no mnemonic", () => {
		expect(formatAgentDisplayName({ agentName: "architect" })).toBe("architect");
	});

	test("uses target agent name for agent-command events", () => {
		expect(
			formatAgentDisplayName({
				agentName: "message_agent",
				targetAgentName: "architect",
				mnemonicName: "Brunelleschi",
			}),
		).toBe("Brunelleschi · architect");
	});
});
```

- [ ] **Step 2: Verify formatter tests fail**

Run:

```bash
bun test test/shared/agent-display.test.ts
```

Expected: FAIL with `Cannot find module '../../src/shared/agent-display.ts'`.

- [ ] **Step 3: Add the minimal formatter implementation**

Create `src/shared/agent-display.ts`:

```ts
import { ContentKind, type ToolCallData } from "../llm/types.ts";
import type { SessionEvent } from "../kernel/types.ts";

export interface AgentDisplayRef {
	agentName?: string;
	targetAgentName?: string;
	mnemonicName?: string;
	childId?: string;
	handleId?: string;
}

export type ActiveAgentWork =
	| {
			kind: "agent";
			agent: AgentDisplayRef;
		}
	| {
			kind: "memory";
		};

export function formatAgentDisplayName(ref: AgentDisplayRef): string {
	const role = cleanString(ref.targetAgentName) ?? cleanString(ref.agentName) ?? "agent";
	const mnemonic = cleanString(ref.mnemonicName);
	if (!mnemonic || mnemonic === role) return role;
	return `${mnemonic} · ${role}`;
}

export function formatActiveAgentWork(work: ActiveAgentWork): string {
	if (work.kind === "memory") return "Saving memory";
	return `Waiting on ${formatAgentDisplayName(work.agent)}`;
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
```

- [ ] **Step 4: Run formatter tests to verify green**

Run:

```bash
bun test test/shared/agent-display.test.ts
```

Expected: PASS for the three formatter tests.

- [ ] **Step 5: Write failing active-work tests**

Extend `test/shared/agent-display.test.ts`:

```ts
describe("deriveActiveAgentWork", () => {
	test("reports an in-flight delegation by mnemonic and role", () => {
		const work = deriveActiveAgentWork([
			event("session_start", { goal: "audit" }, { timestamp: 1 }),
			event("act_start", {
				agent_name: "architect",
				goal: "audit design",
				description: "Audit design",
				handle_id: "H1",
				child_id: "C1",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 2 }),
		], "running");

		expect(work).toEqual({
			kind: "agent",
			agent: {
				agentName: "architect",
				mnemonicName: "Brunelleschi",
				childId: "C1",
				handleId: "H1",
			},
		});
		expect(work ? formatActiveAgentWork(work) : null).toBe("Waiting on Brunelleschi · architect");
	});

	test("reports a shared child that starts a later session after its original delegation ended", () => {
		const work = deriveActiveAgentWork([
			event("session_start", { goal: "audit" }, { timestamp: 1 }),
			event("act_start", {
				agent_name: "architect",
				goal: "audit design",
				handle_id: "H1",
				child_id: "C1",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 2 }),
			event("act_end", {
				agent_name: "architect",
				success: true,
				handle_id: "H1",
				child_id: "C1",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 3 }),
			event("session_start", { goal: "follow up" }, {
				timestamp: 4,
				agent_id: "C1",
				depth: 1,
			}),
		], "running");

		expect(work ? formatActiveAgentWork(work) : null).toBe("Waiting on Brunelleschi · architect");
	});

	test("reports a pending blocking message_agent command before the child emits session_start", () => {
		const work = deriveActiveAgentWork([
			event("session_start", { goal: "audit" }, { timestamp: 1 }),
			event("act_start", {
				agent_name: "architect",
				goal: "audit design",
				handle_id: "H1",
				child_id: "C1",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 2 }),
			event("act_end", {
				agent_name: "architect",
				success: true,
				handle_id: "H1",
				child_id: "C1",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 3 }),
			event("plan_end", {
				assistant_message: {
					role: "assistant",
					content: [
						{
							kind: "tool_call",
							tool_call: {
								id: "call-1",
								name: "message_agent",
								arguments: { handle: "H1", message: "continue", blocking: true },
							},
						},
					],
				},
			}, { timestamp: 4 }),
		], "running");

		expect(work ? formatActiveAgentWork(work) : null).toBe("Waiting on Brunelleschi · architect");
	});

	test("clears a pending agent command when its act_end arrives", () => {
		const work = deriveActiveAgentWork([
			event("session_start", { goal: "audit" }, { timestamp: 1 }),
			event("act_start", {
				agent_name: "architect",
				goal: "audit design",
				handle_id: "H1",
				child_id: "C1",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 2 }),
			event("act_end", {
				agent_name: "architect",
				success: true,
				handle_id: "H1",
				child_id: "C1",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 3 }),
			event("plan_end", {
				assistant_message: {
					role: "assistant",
					content: [
						{
							kind: "tool_call",
							tool_call: {
								id: "call-1",
								name: "message_agent",
								arguments: { handle: "H1", message: "continue" },
							},
						},
					],
				},
			}, { timestamp: 4 }),
			event("act_end", {
				agent_name: "message_agent",
				success: true,
				child_id: "C1",
				target_agent_name: "architect",
				mnemonic_name: "Brunelleschi",
			}, { timestamp: 5 }),
		], "running");

		expect(work).toBeNull();
	});

	test("reports memory saving after root session_end when controller status is still running", () => {
		const work = deriveActiveAgentWork([
			event("session_start", { goal: "audit" }, { timestamp: 1 }),
			event("session_end", { turns: 1, stumbles: 0 }, { timestamp: 2 }),
		], "running");

		expect(work ? formatActiveAgentWork(work) : null).toBe("Saving memory");
	});

	test("does not report memory saving after session_end when status is idle", () => {
		const work = deriveActiveAgentWork([
			event("session_start", { goal: "audit" }, { timestamp: 1 }),
			event("session_end", { turns: 1, stumbles: 0 }, { timestamp: 2 }),
		], "idle");

		expect(work).toBeNull();
	});
});
```

- [ ] **Step 6: Verify active-work tests fail**

Run:

```bash
bun test test/shared/agent-display.test.ts
```

Expected: FAIL with `deriveActiveAgentWork is not a function`.

- [ ] **Step 7: Implement active-work derivation**

Update `src/shared/agent-display.ts`:

```ts
interface ActiveChildRecord extends AgentDisplayRef {
	startedAt: number;
	depth: number;
}

export function deriveActiveAgentWork(
	events: SessionEvent[],
	runStatus: "idle" | "running" | "interrupted",
): ActiveAgentWork | null {
	if (runStatus !== "running") return null;

	const handles = new Map<string, AgentDisplayRef>();
	const children = new Map<string, AgentDisplayRef>();
	const activeChildren = new Map<string, ActiveChildRecord>();
	const pendingCommands = new Map<string, ActiveChildRecord>();
	let rootRunning = false;
	let rootEnded = false;

	for (const event of events) {
		if (event.depth === 0 && event.kind === "session_start") {
			rootRunning = true;
			rootEnded = false;
			activeChildren.clear();
			pendingCommands.clear();
		}

		if (event.depth === 0 && (event.kind === "session_end" || event.kind === "interrupted")) {
			rootEnded = event.kind === "session_end";
			rootRunning = false;
			activeChildren.clear();
			pendingCommands.clear();
		}

		if (event.kind === "act_start") {
			const ref = refFromEventData(event.data);
			if (ref.handleId) handles.set(ref.handleId, ref);
			if (ref.childId) {
				children.set(ref.childId, ref);
				activeChildren.set(ref.childId, {
					...ref,
					startedAt: event.timestamp,
					depth: event.depth + 1,
				});
			}
		}

		if (event.kind === "act_end") {
			const ref = refFromEventData(event.data);
			if (ref.handleId) handles.set(ref.handleId, ref);
			if (ref.childId) {
				children.set(ref.childId, { ...children.get(ref.childId), ...ref });
				activeChildren.delete(ref.childId);
				removePendingCommandForChild(pendingCommands, ref.childId);
			}
			if (ref.agentName === "wait_agent" || ref.agentName === "message_agent") {
				removePendingCommandForChild(pendingCommands, ref.childId);
			}
		}

		if (event.kind === "plan_end") {
			for (const call of extractAgentCommandToolCalls(event.data.assistant_message)) {
				if (call.name === "message_agent" && call.blocking === false) continue;
				const ref = handles.get(call.handle) ?? { handleId: call.handle, agentName: call.name };
				const childKey = ref.childId ?? call.handle;
				pendingCommands.set(`${event.agent_id}:${call.id}`, {
					...ref,
					startedAt: event.timestamp,
					depth: event.depth + 1,
					childId: childKey,
				});
			}
		}

		if (event.kind === "session_start" && event.depth > 0) {
			const ref = children.get(event.agent_id) ?? { childId: event.agent_id, agentName: event.agent_id };
			activeChildren.set(event.agent_id, {
				...ref,
				startedAt: event.timestamp,
				depth: event.depth,
			});
			removePendingCommandForChild(pendingCommands, event.agent_id);
		}

		if (event.kind === "session_end" && event.depth > 0) {
			activeChildren.delete(event.agent_id);
		}
	}

	const activeChild = latestByDepthAndStart([...activeChildren.values()]);
	if (activeChild) return { kind: "agent", agent: activeChild };

	const pending = latestByDepthAndStart([...pendingCommands.values()]);
	if (pending) return { kind: "agent", agent: pending };

	if (rootEnded && !rootRunning) return { kind: "memory" };
	return null;
}

function refFromEventData(data: Record<string, unknown>): AgentDisplayRef {
	return {
		agentName: cleanString(data.agent_name),
		targetAgentName: cleanString(data.target_agent_name),
		mnemonicName: cleanString(data.mnemonic_name),
		childId: cleanString(data.child_id),
		handleId: cleanString(data.handle_id),
	};
}

function latestByDepthAndStart(records: ActiveChildRecord[]): ActiveChildRecord | null {
	return records.toSorted((a, b) => b.depth - a.depth || b.startedAt - a.startedAt)[0] ?? null;
}

function removePendingCommandForChild(
	pendingCommands: Map<string, ActiveChildRecord>,
	childId: string | undefined,
): void {
	if (!childId) return;
	for (const [key, value] of pendingCommands) {
		if (value.childId === childId) pendingCommands.delete(key);
	}
}

function extractAgentCommandToolCalls(value: unknown): Array<{
	id: string;
	name: "wait_agent" | "message_agent";
	handle: string;
	blocking?: boolean;
}> {
	if (!value || typeof value !== "object") return [];
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];

	const calls: Array<{
		id: string;
		name: "wait_agent" | "message_agent";
		handle: string;
		blocking?: boolean;
	}> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const toolCall = (part as { tool_call?: ToolCallData }).tool_call;
		if (!toolCall) continue;
		if (toolCall.name !== "wait_agent" && toolCall.name !== "message_agent") continue;
		const args = typeof toolCall.arguments === "string"
			? safeParseArgs(toolCall.arguments)
			: toolCall.arguments;
		const handle = cleanString(args?.handle);
		if (!handle) continue;
		calls.push({
			id: toolCall.id,
			name: toolCall.name,
			handle,
			blocking: typeof args.blocking === "boolean" ? args.blocking : undefined,
		});
	}
	return calls;
}

function safeParseArgs(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
```

Remove the unused `ContentKind` import from the snippet if Biome reports it.

- [ ] **Step 8: Run shared tests**

Run:

```bash
bun test test/shared/agent-display.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit shared helper**

Run:

```bash
git add src/shared/agent-display.ts test/shared/agent-display.test.ts
git commit -m "feat: derive active subagent status"
```

---

### Task 2: Web Status Bar Integration

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/StatusBar.tsx`
- Modify: `web/src/components/StatusBar.module.css`
- Test: `web/src/components/__tests__/status-bar.test.tsx`

- [ ] **Step 1: Write the failing web status bar tests**

Add to `describe("StatusBar", ...)` in `web/src/components/__tests__/status-bar.test.tsx`:

```ts
	test("renders active subagent work while running", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "running" })}
				connected={true}
				activeWork={{
					kind: "agent",
					agent: {
						agentName: "architect",
						mnemonicName: "Brunelleschi",
					},
				}}
			/>,
		);

		expect(html).toContain("Waiting on");
		expect(html).toContain("Brunelleschi");
		expect(html).toContain("architect");
	});

	test("renders memory saving work while controller is still running", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "running" })}
				connected={true}
				activeWork={{ kind: "memory" }}
			/>,
		);

		expect(html).toContain("Saving memory");
	});
```

- [ ] **Step 2: Verify web tests fail**

Run:

```bash
bun test web/src/components/__tests__/status-bar.test.tsx
```

Expected: FAIL because `activeWork` is not a `StatusBar` prop and/or text is missing.

- [ ] **Step 3: Add StatusBar rendering**

Update `web/src/components/StatusBar.tsx`:

```ts
import type { ActiveAgentWork } from "@shared/agent-display.ts";
import { formatActiveAgentWork } from "@shared/agent-display.ts";
```

Add to `StatusBarProps`:

```ts
	activeWork?: ActiveAgentWork | null;
```

Include `activeWork` in the component destructuring and render it after the status label:

```tsx
				{activeWork && (
					<span className={styles.activeWork} data-active-work={activeWork.kind}>
						{formatActiveAgentWork(activeWork)}
					</span>
				)}
```

- [ ] **Step 4: Add compact styles**

Add to `web/src/components/StatusBar.module.css`:

```css
.activeWork {
	color: var(--color-text-secondary);
	max-width: 280px;
	overflow: hidden;
	text-overflow: ellipsis;
}

.activeWork[data-active-work="agent"] {
	color: var(--color-running);
}
```

- [ ] **Step 5: Wire App to derive active work from events**

Update `web/src/App.tsx`:

```ts
import { deriveActiveAgentWork } from "@shared/agent-display.ts";
```

Inside `App`, after `tasks`:

```ts
	const activeWork = deriveActiveAgentWork(events, status.status);
```

Pass it to `StatusBar`:

```tsx
				activeWork={activeWork}
```

- [ ] **Step 6: Run web tests**

Run:

```bash
bun test test/shared/agent-display.test.ts web/src/components/__tests__/status-bar.test.tsx web/src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit web integration**

Run:

```bash
git add web/src/App.tsx web/src/components/StatusBar.tsx web/src/components/StatusBar.module.css web/src/components/__tests__/status-bar.test.tsx
git commit -m "feat: show active subagent in web status"
```

---

### Task 3: TUI Status Bar Integration

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/status-bar.tsx`
- Test: `test/tui/status-bar.test.tsx`
- Test: `test/tui/app.test.tsx`

- [ ] **Step 1: Write failing TUI status bar tests**

Add to `describe("StatusBar", ...)` in `test/tui/status-bar.test.tsx`:

```ts
	test("renders active subagent work when running", () => {
		const { lastFrame } = render(
			<StatusBar
				{...makeProps({
					status: "running",
					activeWork: {
						kind: "agent",
						agent: {
							agentName: "architect",
							mnemonicName: "Brunelleschi",
						},
					},
				})}
			/>,
		);

		expect(lastFrame()).toContain("Waiting on Brunelleschi · architect");
	});

	test("renders saving memory when post-run work is active", () => {
		const { lastFrame } = render(
			<StatusBar
				{...makeProps({
					status: "running",
					activeWork: { kind: "memory" },
				})}
			/>,
		);

		expect(lastFrame()).toContain("Saving memory");
	});
```

Add to `test/tui/app.test.tsx`:

```ts
	test("shows the active child agent in the status bar", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, { goal: "audit" });
		bus.emitEvent("act_start", "root", 0, {
			agent_name: "architect",
			goal: "audit design",
			handle_id: "H1",
			child_id: "C1",
			mnemonic_name: "Brunelleschi",
		});

		await flush();

		expect(lastFrame()).toContain("Waiting on Brunelleschi · architect");
	});
```

- [ ] **Step 2: Verify TUI tests fail**

Run:

```bash
bun test test/tui/status-bar.test.tsx test/tui/app.test.tsx
```

Expected: FAIL because TUI status bar does not accept or render `activeWork`.

- [ ] **Step 3: Add activeWork to TUI StatusBar**

Update `src/tui/status-bar.tsx`:

```ts
import type { ActiveAgentWork } from "../shared/agent-display.ts";
import { formatActiveAgentWork } from "../shared/agent-display.ts";
```

Add to `StatusBarProps`:

```ts
	activeWork?: ActiveAgentWork | null;
```

Include `activeWork` in prop destructuring and append it to the left side when present:

```ts
	if (activeWork) {
		left += ` │ ${formatActiveAgentWork(activeWork)}`;
	}
```

- [ ] **Step 4: Track event history in TUI App and derive active work**

Update `src/tui/app.tsx` imports:

```ts
import { deriveActiveAgentWork } from "../shared/agent-display.ts";
```

Add state near `statusState`:

```ts
	const [statusEvents, setStatusEvents] = useState<SessionEvent[]>(initialEvents ?? []);
	const activeWork = deriveActiveAgentWork(statusEvents, statusState.status);
```

Inside the existing `bus.onEvent` callback, before the `switch`:

```ts
			setStatusEvents((prev) => {
				if (event.kind === "session_clear") return [event];
				const next = [...prev, event];
				return next.length > 500 ? next.slice(-500) : next;
			});
```

Pass `activeWork` to `StatusBar`:

```tsx
				activeWork={activeWork}
```

- [ ] **Step 5: Run TUI status tests**

Run:

```bash
bun test test/shared/agent-display.test.ts test/tui/status-bar.test.tsx test/tui/app.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit TUI status integration**

Run:

```bash
git add src/tui/app.tsx src/tui/status-bar.tsx test/tui/status-bar.test.tsx test/tui/app.test.tsx
git commit -m "feat: show active subagent in terminal status"
```

---

### Task 4: Terminal Delegation Identity Formatting

**Files:**
- Modify: `src/tui/render-event.ts`
- Modify: `src/tui/event-components.tsx`
- Test: `test/tui/render-event.test.ts`
- Test: `test/tui/conversation-view.test.tsx`

- [ ] **Step 1: Write failing one-shot terminal renderer tests**

Update the existing `act_start` and `act_end` tests in `test/tui/render-event.test.ts`, and add mnemonic-specific tests:

```ts
	test("act_start shows mnemonic and role when present", () => {
		const result = renderEvent(
			makeEvent("act_start", {
				agent_name: "architect",
				mnemonic_name: "Brunelleschi",
				goal: "Audit design",
			}),
		);
		expect(result).toBe("\u2192 Brunelleschi · architect: Audit design");
	});

	test("act_end shows mnemonic and target role for agent commands", () => {
		const result = renderEvent(
			makeEvent("act_end", {
				agent_name: "message_agent",
				target_agent_name: "architect",
				mnemonic_name: "Brunelleschi",
				success: true,
				turns: 2,
			}),
		);
		expect(result).toBe("\u2190 Brunelleschi · architect \u2713 (2 turns)");
	});
```

Update the existing `act_end shows return arrow with check on success` expectation to:

```ts
expect(result).toBe("\u2190 code-editor \u2713 (2 turns)");
```

Update the existing failure expectation to:

```ts
expect(result).toBe("\u2190 code-editor \u2717 failed");
```

- [ ] **Step 2: Write failing interactive TUI test**

Add to `test/tui/conversation-view.test.tsx`:

```ts
	test("renders delegation mnemonic with role in interactive lines", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("act_start", "root", 0, {
			agent_name: "architect",
			mnemonic_name: "Brunelleschi",
			goal: "Audit design",
		});
		await flush();

		expect(lastFrame()).toContain("Brunelleschi · architect");
	});
```

- [ ] **Step 3: Verify terminal renderer tests fail**

Run:

```bash
bun test test/tui/render-event.test.ts test/tui/conversation-view.test.tsx
```

Expected: FAIL because current renderers use `agent_name` only and `act_end` omits the agent label.

- [ ] **Step 4: Use shared formatter in one-shot render-event**

Update `src/tui/render-event.ts` imports:

```ts
import { formatAgentDisplayName } from "../shared/agent-display.ts";
```

Add helper:

```ts
function agentDisplayFromData(data: Record<string, unknown>): string {
	return formatAgentDisplayName({
		agentName: typeof data.agent_name === "string" ? data.agent_name : undefined,
		targetAgentName: typeof data.target_agent_name === "string" ? data.target_agent_name : undefined,
		mnemonicName: typeof data.mnemonic_name === "string" ? data.mnemonic_name : undefined,
		childId: typeof data.child_id === "string" ? data.child_id : undefined,
		handleId: typeof data.handle_id === "string" ? data.handle_id : undefined,
	});
}
```

Update cases:

```ts
		case "act_start":
			return `${ind}\u2192 ${agentDisplayFromData(data)}: ${truncate(String(data.goal), 80)}`;

		case "act_end": {
			const turns = data.turns != null ? ` (${data.turns} turns)` : "";
			const agent = agentDisplayFromData(data);
			if (!data.success) {
				return `${ind}\u2190 ${agent} \u2717 failed${turns}`;
			}
			return `${ind}\u2190 ${agent} \u2713${turns}`;
		}
```

- [ ] **Step 5: Use shared formatter in interactive event components**

Update `src/tui/event-components.tsx` imports:

```ts
import { formatAgentDisplayName } from "../shared/agent-display.ts";
```

Add optional props to `DelegationStartProps` and `DelegationEndProps`:

```ts
	mnemonicName?: string;
	targetAgentName?: string;
```

In both components, compute:

```ts
	const displayName = formatAgentDisplayName({ agentName, targetAgentName, mnemonicName });
```

Render `displayName` instead of `agentName`.

Pass the fields from `renderEventComponent`:

```tsx
					mnemonicName={typeof data.mnemonic_name === "string" ? data.mnemonic_name : undefined}
					targetAgentName={typeof data.target_agent_name === "string" ? data.target_agent_name : undefined}
```

- [ ] **Step 6: Run terminal renderer tests**

Run:

```bash
bun test test/tui/render-event.test.ts test/tui/conversation-view.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit terminal identity formatting**

Run:

```bash
git add src/tui/render-event.ts src/tui/event-components.tsx test/tui/render-event.test.ts test/tui/conversation-view.test.tsx
git commit -m "feat: format subagent identity in terminal events"
```

---

### Task 5: Final Verification

**Files:**
- No production files expected beyond previous tasks.

- [ ] **Step 1: Run focused verification**

Run:

```bash
bun test test/shared/agent-display.test.ts web/src/components/__tests__/status-bar.test.tsx web/src/App.test.tsx test/tui/status-bar.test.tsx test/tui/app.test.tsx test/tui/render-event.test.ts test/tui/conversation-view.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run formatting, linting, and typecheck**

Run:

```bash
bun run check
bun run typecheck
```

Expected: both commands pass.

- [ ] **Step 3: Run full test suite with explicit dummy provider keys**

The first baseline run without keys failed two pre-existing `Client.fromEnv` tests that require provider env vars. Use explicit dummy keys for the final full-suite command:

```bash
ANTHROPIC_API_KEY=test-anthropic OPENAI_API_KEY=test-openai GEMINI_API_KEY=test-gemini bun test
```

Expected: PASS with only the existing skipped tests.

- [ ] **Step 4: Check git status**

Run:

```bash
git status --short
```

Expected: only intended files are modified, or clean after commits.

---

## Self-Review

- **Spec coverage:** The plan covers shared subagent naming, web status bar display, TUI status bar display, and terminal event identity formatting. It also covers the observed memory-collapse confusion by deriving "Saving memory" when controller status is still running after root `session_end`.
- **Placeholder scan:** No task uses `TODO`, `TBD`, "similar to", or unspecified tests. Each task names files, commands, expected failures, and expected passes.
- **Type consistency:** `ActiveAgentWork`, `AgentDisplayRef`, `formatAgentDisplayName`, `formatActiveAgentWork`, and `deriveActiveAgentWork` are introduced in Task 1 and reused with the same names in later tasks.
