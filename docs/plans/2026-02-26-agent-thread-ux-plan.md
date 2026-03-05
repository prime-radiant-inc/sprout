# Agent Thread UX Implementation Plan

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

**Goal:** Replace the flat event log with a threaded conversation model using unique child IDs, collapsed delegation cards with live peek, Obsidian-style stacking side panels, and a collapsible sidebar tree.

**Architecture:** Kernel generates a ULID per delegation and emits it as `data.child_id` in `act_start`/`act_end` events. Child agents use this ID for all their events. The web UI groups child events behind collapsed cards in the parent thread, with "View thread" opening stacking side panels. The sidebar tree becomes a collapsible disclosure-triangle tree visible at all times.

**Tech Stack:** TypeScript, React (Vite), CSS Modules, Bun test runner, custom ULID (`src/util/ulid.ts`)

---

## Task 1: Kernel — Emit `child_id` in Delegation Events

Add a ULID-based `child_id` to `act_start`/`act_end` events so every delegation gets a globally unique identifier. Pass it to child agents so they use it as their `agent_id`.

**Files:**
- Modify: `src/agents/agent.ts:260-370` (executeDelegation)
- Modify: `src/agents/agent.ts:378-487` (executeSpawnerDelegation)
- Modify: `src/agents/agent.ts:55-77` (AgentOptions — add optional `agentId` override)
- Modify: `src/agents/agent.ts:556-558` (run — use `agentId` override if provided)
- Test: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

In `test/agents/agent.test.ts`, add a test that verifies `act_start` and `act_end` events contain a `child_id` field, and that the child agent's own events (like `session_start`, `perceive`) use that same ID as their `agent_id`.

```typescript
test("delegation emits child_id in act_start/act_end and child uses it as agent_id", async () => {
	// Root delegates to leaf. We check:
	// 1. act_start.data.child_id is a 26-char ULID
	// 2. act_end.data.child_id matches act_start.data.child_id
	// 3. Leaf's own events (perceive, session_start) have agent_id === child_id

	const delegateMsg: Message = {
		role: "assistant",
		content: [
			{
				kind: ContentKind.TOOL_CALL,
				tool_call: {
					id: "call-child-id-1",
					name: "delegate",
					arguments: JSON.stringify({ agent_name: "leaf", goal: "do it" }),
				},
			},
		],
	};
	const subDoneMsg: Message = {
		role: "assistant",
		content: [{ kind: ContentKind.TEXT, text: "Done." }],
	};
	const rootDoneMsg: Message = {
		role: "assistant",
		content: [{ kind: ContentKind.TEXT, text: "All done." }],
	};

	let callCount = 0;
	const mockClient = {
		providers: () => ["anthropic"],
		complete: async (): Promise<Response> => {
			callCount++;
			const msg = callCount === 1 ? delegateMsg : callCount === 2 ? subDoneMsg : rootDoneMsg;
			return {
				id: `mock-cid-${callCount}`,
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: msg,
				finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			};
		},
		stream: async function* () {},
	} as unknown as Client;

	const events = new AgentEventEmitter();
	const env = new LocalExecutionEnvironment(tmpdir());
	const registry = createPrimitiveRegistry(env);
	const agent = new Agent({
		spec: rootSpec,
		env,
		client: mockClient,
		primitiveRegistry: registry,
		availableAgents: [rootSpec, leafSpec],
		depth: 0,
		events,
	});

	await agent.run("delegate something");
	const collected = events.collected();

	// act_start must have child_id
	const actStart = collected.find(
		(e) => e.kind === "act_start" && e.data.agent_name === "leaf",
	);
	expect(actStart).toBeDefined();
	const childId = actStart!.data.child_id as string;
	expect(childId).toBeDefined();
	expect(childId).toHaveLength(26); // ULID length

	// act_end must have same child_id
	const actEnd = collected.find(
		(e) => e.kind === "act_end" && e.data.agent_name === "leaf" && e.data.success === true,
	);
	expect(actEnd).toBeDefined();
	expect(actEnd!.data.child_id).toBe(childId);

	// Child's own events use child_id as agent_id
	const childPerceive = collected.find(
		(e) => e.kind === "perceive" && e.depth === 1,
	);
	expect(childPerceive).toBeDefined();
	expect(childPerceive!.agent_id).toBe(childId);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test test/agents/agent.test.ts --filter "child_id"`
Expected: FAIL — `child_id` is undefined, child `agent_id` is `"leaf"` not a ULID.

**Step 3: Implement**

3a. Add `agentId` override to `AgentOptions` (`src/agents/agent.ts:55-77`):

```typescript
// Add to AgentOptions interface after `genomePath?: string;` (line 76):
/** Override the agent_id used for event emission (used by parent to assign unique child IDs). */
agentId?: string;
```

3b. Use it in `run()` (`src/agents/agent.ts:556-558`):

Change:
```typescript
const agentId = this.spec.name;
```
To:
```typescript
const agentId = this.agentId ?? this.spec.name;
```

And store it in the constructor (`src/agents/agent.ts:116`), add a new field:

```typescript
// Add field after line 113 (private compactionRequested):
private readonly agentId?: string;

// In constructor, after line 132 (this.initialHistory):
this.agentId = options.agentId;
```

3c. Generate `childId` in `executeDelegation()` (`src/agents/agent.ts:260-310`):

After line 263, before `this.emitAndLog("act_start", ...)`:
```typescript
const childId = ulid();
```

Add `child_id` to `act_start` data (line 264-267):
```typescript
this.emitAndLog("act_start", agentId, this.depth, {
	agent_name: delegation.agent_name,
	goal: delegation.goal,
	child_id: childId,
});
```

Pass `agentId` to subagent constructor (line 294-308). Add `agentId: childId` to the options:
```typescript
const subagent = new Agent({
	spec: subagentSpec,
	env: this.env,
	client: this.client,
	primitiveRegistry: this.primitiveRegistry,
	availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,
	genome: this.genome,
	depth: this.depth + 1,
	events: this.events,
	sessionId: this.sessionId,
	learnProcess: this.learnProcess,
	logBasePath: subLogBasePath,
	preambles: this.preambles,
	genomePostscripts: this.genomePostscripts,
	agentId: childId,
});
```

Add `child_id` to all `act_end` emissions in `executeDelegation()` — there are three sites:
- Error path (line 276): add `child_id: childId`
- Success path (line 342): add `child_id: childId`
- Catch path (line 362): add `child_id: childId`

3d. Same pattern for `executeSpawnerDelegation()` (`src/agents/agent.ts:378-487`):

After line 382 (`const handleId = ulid();`), add:
```typescript
const childId = ulid();
```

Add `child_id: childId` to `act_start` (line 384-388) and all `act_end` emissions (lines 414, 462, 479).

Note: For spawner delegations, the child runs in a separate process — we can't pass `agentId`. The `child_id` on the events is still useful for the web UI to correlate `act_start`/`act_end` pairs. The spawner child's own events will still use `spec.name`, which is acceptable since the spawner path already has `handle_id` for unique correlation.

**Step 4: Run test to verify it passes**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test test/agents/agent.test.ts --filter "child_id"`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test $(find test -name '*.test.ts' -o -name '*.test.tsx' | grep -v integration | grep -v 'anthropic.test' | grep -v 'gemini.test' | grep -v 'openai.test' | grep -v 'client.test')`
Expected: All pass. Existing tests don't check for absence of `child_id`, so they should be unaffected.

**Step 6: Commit**

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: emit child_id (ULID) in act_start/act_end delegation events"
```

---

## Task 2: Web UI — Use `child_id` for Tree Building

Update `buildAgentTree` to use `data.child_id` from `act_start`/`act_end` events instead of the `#N` disambiguation hack. Update `EventLine` and `groupEvents` to use `child_id` for agent correlation.

**Files:**
- Modify: `web/src/hooks/useAgentTree.ts:23-119` (buildAgentTree)
- Modify: `web/src/components/EventLine.tsx:74-94` (act_start/act_end handlers)
- Modify: `web/src/components/groupEvents.ts:32-47` (durationKey for act events)
- Test: `web/src/hooks/useAgentTree.test.ts`

**Step 1: Write the failing test**

In `web/src/hooks/useAgentTree.test.ts`, add a test that uses `child_id` in events:

```typescript
describe("child_id based tree building", () => {
	test("uses child_id from act_start for node agentId", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, {
				agent_name: "editor",
				goal: "Edit file",
				child_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			}),
			makeEvent("act_end", "root", 0, {
				agent_name: "editor",
				goal: "Edit file",
				child_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				success: true,
				turns: 2,
			}),
		];
		const tree = buildAgentTree(events);

		expect(tree.children).toHaveLength(1);
		const child = tree.children[0]!;
		expect(child.agentId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		expect(child.agentName).toBe("editor");
	});

	test("same agent_name with different child_ids produces distinct nodes", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Retry" }),
			makeEvent("act_start", "root", 0, {
				agent_name: "editor",
				goal: "First",
				child_id: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
			}),
			makeEvent("act_end", "root", 0, {
				agent_name: "editor",
				child_id: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
				success: false,
			}),
			makeEvent("act_start", "root", 0, {
				agent_name: "editor",
				goal: "Second",
				child_id: "BBBBBBBBBBBBBBBBBBBBBBBBBB",
			}),
			makeEvent("act_end", "root", 0, {
				agent_name: "editor",
				child_id: "BBBBBBBBBBBBBBBBBBBBBBBBBB",
				success: true,
			}),
		];
		const tree = buildAgentTree(events);

		expect(tree.children).toHaveLength(2);
		expect(tree.children[0]!.agentId).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAA");
		expect(tree.children[1]!.agentId).toBe("BBBBBBBBBBBBBBBBBBBBBBBBBB");
		// Both display as "editor"
		expect(tree.children[0]!.agentName).toBe("editor");
		expect(tree.children[1]!.agentName).toBe("editor");
	});

	test("falls back to name disambiguation when child_id absent", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Legacy" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "First" }),
			makeEvent("act_end", "root", 0, { agent_name: "editor", success: false }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Second" }),
			makeEvent("act_end", "root", 0, { agent_name: "editor", success: true }),
		];
		const tree = buildAgentTree(events);

		expect(tree.children).toHaveLength(2);
		expect(tree.children[0]!.agentId).toBe("editor");
		expect(tree.children[1]!.agentId).toBe("editor#2");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src/hooks/useAgentTree.test.ts --filter "child_id"`
Expected: FAIL — `agentId` is `"editor"` not the ULID because `buildAgentTree` doesn't look at `child_id`.

**Step 3: Implement**

3a. Update `buildAgentTree` in `web/src/hooks/useAgentTree.ts` (lines 65-94, `act_start` case):

Replace the current `act_start` handler:

```typescript
case "act_start": {
	const childName = (event.data.agent_name as string) ?? event.agent_id;
	// Prefer child_id (ULID) if available; fall back to name-based disambiguation
	let childId: string;
	if (typeof event.data.child_id === "string") {
		childId = event.data.child_id;
	} else {
		const count = (nameCounters.get(childName) ?? 0) + 1;
		nameCounters.set(childName, count);
		childId = count === 1 ? childName : `${childName}#${count}`;
	}

	const childDepth = event.depth + 1;
	const node: AgentTreeNode = {
		agentId: childId,
		agentName: childName,
		depth: childDepth,
		status: "running",
		goal: (event.data.goal as string) ?? "",
		children: [],
	};
	startTimestamps.set(node, event.timestamp);

	const parent = path[event.depth];
	if (parent) {
		parent.children.push(node);
	}

	// Also index by childId for act_end lookup
	nodeById.set(childId, node);

	path[childDepth] = node;
	path.length = childDepth + 1;
	break;
}
```

3b. Update `act_end` handler (lines 97-114) to look up by `child_id`:

```typescript
case "act_end": {
	// Find node by child_id if available, otherwise fall back to path lookup
	let node: AgentTreeNode | undefined;
	if (typeof event.data.child_id === "string") {
		node = nodeById.get(event.data.child_id);
	} else {
		const childDepth = event.depth + 1;
		node = path[childDepth];
	}
	if (node && node !== root) {
		node.status = (event.data.success as boolean) ? "completed" : "failed";
		const turns = event.data.turns as number | undefined;
		if (turns !== undefined) {
			node.turns = turns;
		}
		const startTs = startTimestamps.get(node);
		if (startTs !== undefined) {
			node.durationMs = event.timestamp - startTs;
		}
	}
	break;
}
```

3c. Add the `nodeById` map declaration near line 38 (after `startTimestamps`):

```typescript
const nodeById = new Map<string, AgentTreeNode>();
```

3d. Update `EventLine.tsx` lines 74-94: Change `onSelectAgent` callbacks to use `child_id` when available:

```typescript
case "act_start":
	return (
		<DelegationBlock
			agentName={data.agent_name as string}
			goal={data.goal as string}
			status="running"
			onOpenThread={onSelectAgent ? () => onSelectAgent(
				(data.child_id as string) ?? (data.agent_name as string)
			) : undefined}
		/>
	);

case "act_end":
	return (
		<DelegationBlock
			agentName={data.agent_name as string}
			goal={typeof data.goal === "string" ? data.goal : ""}
			status={data.success ? "completed" : "failed"}
			turns={typeof data.turns === "number" ? data.turns : undefined}
			durationMs={durationMs}
			onOpenThread={onSelectAgent ? () => onSelectAgent(
				(data.child_id as string) ?? (data.agent_name as string)
			) : undefined}
		/>
	);
```

3e. Update `groupEvents.ts` `durationKey` function (line 41-43) to use `child_id` for unique matching:

```typescript
case "act_start":
case "act_end":
	return `${agent_id}:act:${data.child_id ?? data.agent_name}`;
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src/hooks/useAgentTree.test.ts`
Expected: All pass.

**Step 5: Run full web test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src`
Expected: All pass. Existing tests that don't include `child_id` should fall back to the `#N` disambiguation.

**Step 6: Commit**

```bash
git add web/src/hooks/useAgentTree.ts web/src/hooks/useAgentTree.test.ts web/src/components/EventLine.tsx web/src/components/groupEvents.ts
git commit -m "feat(web): use child_id for agent tree building with fallback disambiguation"
```

---

## Task 3: Collapsible Sidebar Tree

Replace the flat tree with a proper collapsible tree using disclosure triangles. Show the tree at all times (not just while running). Auto-expand nodes when they become active.

**Files:**
- Modify: `web/src/components/AgentTree.tsx` (complete rewrite of TreeNode)
- Modify: `web/src/components/AgentTree.module.css` (add disclosure triangle styles)
- Modify: `web/src/components/Sidebar.tsx:26` (show tree always, not just when running)
- Test: `web/src/components/__tests__/agent-tree.test.tsx`

**Step 1: Write the failing test**

In `web/src/components/__tests__/agent-tree.test.tsx`, add tests for collapsible behavior:

```typescript
test("renders disclosure triangles for nodes with children", () => {
	const tree = buildAgentTree([
		makeEvent("perceive", "root", 0, { goal: "Go" }),
		makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "CID1" }),
		makeEvent("act_end", "root", 0, { agent_name: "editor", child_id: "CID1", success: true }),
	]);
	const html = renderToStaticMarkup(
		<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
	);
	// Root has children, so it should have a disclosure triangle
	expect(html).toContain("data-disclosure");
});

test("leaf nodes do not render disclosure triangles", () => {
	const tree = buildAgentTree([
		makeEvent("perceive", "root", 0, { goal: "Go" }),
		makeEvent("act_start", "root", 0, { agent_name: "leaf", goal: "Do", child_id: "CID1" }),
		makeEvent("act_end", "root", 0, { agent_name: "leaf", child_id: "CID1", success: true }),
	]);
	const html = renderToStaticMarkup(
		<AgentTree tree={tree} selectedAgent={null} onSelectAgent={() => {}} />,
	);
	// The leaf node's button should not have a disclosure attribute
	// Only root should have disclosure
	const leafMatch = html.match(/data-agent-id="CID1"[^>]*/);
	expect(leafMatch?.[0]).not.toContain("data-disclosure");
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src/components/__tests__/agent-tree.test.tsx --filter "disclosure"`
Expected: FAIL — current tree doesn't render `data-disclosure`.

**Step 3: Implement**

3a. Rewrite `TreeNode` in `web/src/components/AgentTree.tsx`:

```typescript
function TreeNode({
	node,
	selectedAgent,
	onSelectAgent,
	defaultExpanded,
}: {
	node: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	defaultExpanded?: boolean;
}) {
	const hasChildren = node.children.length > 0;
	const isSelected = selectedAgent === node.agentId;
	const [expanded, setExpanded] = useState(defaultExpanded ?? true);

	// Auto-expand when a running child appears
	useEffect(() => {
		if (node.children.some((c) => c.status === "running")) {
			setExpanded(true);
		}
	}, [node.children]);

	return (
		<li>
			<div className={styles.nodeRow}>
				{hasChildren ? (
					<button
						type="button"
						className={styles.disclosure}
						data-disclosure={expanded ? "open" : "closed"}
						onClick={() => setExpanded((prev) => !prev)}
						aria-label={expanded ? "Collapse" : "Expand"}
					>
						{expanded ? "\u25BE" : "\u25B8"}
					</button>
				) : (
					<span className={styles.disclosureSpacer} />
				)}
				<button
					type="button"
					className={`${styles.node} ${isSelected ? styles.selected : ""}`}
					data-agent-id={node.agentId}
					data-selected={isSelected ? "true" : undefined}
					data-status={node.status}
					onClick={() => onSelectAgent(node.agentId)}
				>
					<span className={statusClasses[node.status]}>
						{statusIcon(node.status)}
					</span>
					<span className={styles.agentName}>{node.agentName}</span>
					<span className={styles.goal}>{truncateGoal(node.goal)}</span>
				</button>
			</div>
			{hasChildren && expanded && (
				<ul className={styles.children}>
					{node.children.map((child, idx) => (
						<TreeNode
							key={`${child.agentId}-${idx}`}
							node={child}
							selectedAgent={selectedAgent}
							onSelectAgent={onSelectAgent}
						/>
					))}
				</ul>
			)}
		</li>
	);
}
```

Add `useState` and `useEffect` to imports at top of `AgentTree.tsx`:
```typescript
import { useEffect, useState } from "react";
```

3b. Update CSS in `web/src/components/AgentTree.module.css`:

Add after line 62 (`.children`):

```css
.nodeRow {
	display: flex;
	align-items: baseline;
}

.disclosure {
	all: unset;
	cursor: pointer;
	width: var(--space-md);
	text-align: center;
	color: var(--color-text-tertiary);
	font-size: var(--font-size-xs);
	flex-shrink: 0;
}

.disclosure:hover {
	color: var(--color-text-primary);
}

.disclosureSpacer {
	width: var(--space-md);
	flex-shrink: 0;
}
```

3c. Update `Sidebar.tsx` (line 26) to show tree always:

Change:
```typescript
const showTree = status.status === "running" || status.status === "interrupted";
```
To:
```typescript
const showTree = tree.children.length > 0 || status.status === "running" || status.status === "interrupted";
```

This shows the tree whenever there are agents to display, not just during a run.

**Step 4: Run tests**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src`
Expected: All pass.

**Step 5: Commit**

```bash
git add web/src/components/AgentTree.tsx web/src/components/AgentTree.module.css web/src/components/Sidebar.tsx web/src/components/__tests__/agent-tree.test.tsx
git commit -m "feat(web): collapsible sidebar tree with disclosure triangles"
```

---

## Task 4: Collapsed Delegation Cards with Live Peek

In the parent thread, merge `act_start` and `act_end` into a single delegation card per child. While the child is running, show a live peek of the most recent child activity (latest tool call or plan text). Filter out raw child events from the parent thread.

**Files:**
- Modify: `web/src/components/groupEvents.ts` (merge act_start/act_end, add live peek, filter child events)
- Modify: `web/src/components/groupEvents.ts:4-11` (GroupedEvent — add `livePeek` field)
- Modify: `web/src/components/DelegationBlock.tsx` (add live peek display)
- Modify: `web/src/components/DelegationBlock.module.css` (peek styling)
- Modify: `web/src/components/EventLine.tsx:59-94` (render merged delegation)
- Test: `web/src/components/__tests__/groupEvents.test.ts`

**Step 1: Write the failing test**

In `web/src/components/__tests__/groupEvents.test.ts`, add tests for merged delegation and live peek:

```typescript
describe("delegation merging", () => {
	test("act_start followed by act_end produces single grouped event with act_end data", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", "root", 0, { goal: "Go" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "CID1" }),
			// Child events at depth 1 with agent_id = CID1
			makeEvent("perceive", "CID1", 1, { goal: "Edit" }),
			makeEvent("primitive_end", "CID1", 1, { name: "write_file", success: true, args: { path: "foo.ts" } }),
			makeEvent("act_end", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "CID1", success: true, turns: 3 }),
		];
		const result = groupEvents(events, null, buildTree(events));
		// Only perceive + one merged delegation card should appear for root view
		const delegations = result.filter((g) => g.event.kind === "act_end" || g.event.kind === "act_start");
		// Should be exactly 1 merged entry (act_end with merged data)
		expect(delegations).toHaveLength(1);
		expect(delegations[0]!.event.kind).toBe("act_end");
	});

	test("running delegation (act_start without act_end) appears as running card", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", "root", 0, { goal: "Go" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "CID1" }),
			makeEvent("primitive_end", "CID1", 1, { name: "read_file", success: true, args: { path: "bar.ts" } }),
		];
		const result = groupEvents(events, null, buildTree(events));
		const delegations = result.filter((g) => g.event.kind === "act_start");
		expect(delegations).toHaveLength(1);
		expect(delegations[0]!.livePeek).toBe("read_file bar.ts");
	});

	test("child events are filtered from parent view", () => {
		const events: SessionEvent[] = [
			makeEvent("perceive", "root", 0, { goal: "Go" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "CID1" }),
			makeEvent("perceive", "CID1", 1, { goal: "Edit" }),
			makeEvent("plan_end", "CID1", 1, { text: "I will edit the file" }),
			makeEvent("primitive_end", "CID1", 1, { name: "write_file", success: true }),
			makeEvent("act_end", "root", 0, { agent_name: "editor", child_id: "CID1", success: true, turns: 1 }),
		];
		const result = groupEvents(events, null, buildTree(events));
		// None of the child events (CID1) should appear
		const childEvents = result.filter((g) => g.event.agent_id === "CID1");
		expect(childEvents).toHaveLength(0);
	});
});
```

You'll need a helper `buildTree` at the top of the test file:

```typescript
import { buildAgentTree } from "../../hooks/useAgentTree.ts";
function buildTree(events: SessionEvent[]) {
	return buildAgentTree(events);
}
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src/components/__tests__/groupEvents.test.ts --filter "delegation merging"`
Expected: FAIL — current code doesn't merge, doesn't filter child events, `livePeek` property doesn't exist.

**Step 3: Implement**

3a. Add `livePeek` to `GroupedEvent` interface in `groupEvents.ts` (line 4-11):

```typescript
export interface GroupedEvent {
	event: SessionEvent;
	isFirstInGroup: boolean;
	isLastInGroup: boolean;
	durationMs: number | null;
	streamingText?: string;
	agentName?: string;
	/** Live peek summary for running delegations. */
	livePeek?: string;
}
```

3b. Add delegation merging and child filtering logic to `groupEvents()`:

After the `allowedIds` computation (line 70-71), add logic to build a set of "direct child" agent IDs:

```typescript
// Build set of child_ids that are direct children of the viewed agent.
// Events from these children should be hidden in the parent view (collapsed into cards).
const directChildIds = new Set<string>();
const childPeek = new Map<string, string>(); // child_id → latest activity summary
const pendingActStarts = new Map<string, number>(); // child_id → index in result array
```

In the event loop, before the agent filter check:

```typescript
// Track child_ids from act_start events
if (event.kind === "act_start" && typeof event.data.child_id === "string") {
	directChildIds.add(event.data.child_id);
}

// When not filtering to a specific agent, hide events from direct children
if (!agentFilter && directChildIds.has(event.agent_id)) {
	// But track latest activity for live peek
	if (event.kind === "primitive_end") {
		const name = event.data.name as string;
		const path = (event.data.args as Record<string, unknown>)?.path;
		childPeek.set(event.agent_id, path ? `${name} ${path}` : name);
	} else if (event.kind === "plan_end" && event.data.text) {
		const text = String(event.data.text);
		childPeek.set(event.agent_id, text.length > 60 ? `${text.slice(0, 57)}...` : text);
	}
	continue;
}
```

For `act_start` events, track their position for later merging:

```typescript
if (event.kind === "act_start" && typeof event.data.child_id === "string") {
	const idx = result.length;
	result.push({
		event,
		durationMs,
		isFirstInGroup: true,
		isLastInGroup: true,
		agentName: nameMap.get(event.agent_id),
		livePeek: childPeek.get(event.data.child_id as string),
	});
	pendingActStarts.set(event.data.child_id as string, idx);
	continue;
}
```

For `act_end` events, replace the pending `act_start`:

```typescript
if (event.kind === "act_end" && typeof event.data.child_id === "string") {
	const startIdx = pendingActStarts.get(event.data.child_id as string);
	if (startIdx !== undefined) {
		// Replace the act_start entry with the act_end (merged card)
		result[startIdx] = {
			event,
			durationMs,
			isFirstInGroup: true,
			isLastInGroup: true,
			agentName: nameMap.get(event.agent_id),
		};
		pendingActStarts.delete(event.data.child_id as string);
		continue;
	}
}
```

After the main loop, update live peek for still-pending act_starts:

```typescript
// Update live peek for still-running delegations
for (const [childId, idx] of pendingActStarts) {
	const peek = childPeek.get(childId);
	if (peek && result[idx]) {
		result[idx]!.livePeek = peek;
	}
}
```

3c. Update `DelegationBlock.tsx` to accept and render `livePeek`:

```typescript
interface DelegationBlockProps {
	agentName: string;
	goal: string;
	status: "running" | "completed" | "failed";
	turns?: number;
	durationMs?: number | null;
	livePeek?: string;
	onOpenThread?: () => void;
}

// In the component, after the meta div (line 41):
{livePeek && status === "running" && (
	<div className={styles.peek}>
		{livePeek}
	</div>
)}
```

3d. Add peek styles to `DelegationBlock.module.css`:

```css
.peek {
	font-size: var(--font-size-xs);
	font-family: var(--font-mono);
	color: var(--color-text-tertiary);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
```

3e. Update `EventLine.tsx` to pass `livePeek` through:

Add `livePeek` to `EventLineProps`:
```typescript
interface EventLineProps {
	event: SessionEvent;
	durationMs: number | null;
	streamingText?: string;
	isFirstInGroup?: boolean;
	agentName?: string;
	livePeek?: string;
	onSelectAgent?: (agentId: string) => void;
}
```

Pass `livePeek` to `DelegationBlock` in the `act_start` case (line 74-82):
```typescript
<DelegationBlock
	agentName={data.agent_name as string}
	goal={data.goal as string}
	status="running"
	livePeek={livePeek}
	onOpenThread={...}
/>
```

Update `ConversationView.tsx` to pass `livePeek` from `GroupedEvent`:
```typescript
<EventLine
	key={...}
	event={event}
	durationMs={durationMs}
	streamingText={streamingText}
	isFirstInGroup={isFirstInGroup}
	agentName={agentName}
	livePeek={livePeek}
	onSelectAgent={onSelectAgent}
/>
```

And destructure `livePeek` from the grouped event in the map callback (ConversationView.tsx line 40):
```typescript
{grouped.map(({ event, durationMs, streamingText, isFirstInGroup, agentName, livePeek }, i) => (
```

**Step 4: Run tests**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src`
Expected: All pass.

**Step 5: Commit**

```bash
git add web/src/components/groupEvents.ts web/src/components/__tests__/groupEvents.test.ts web/src/components/DelegationBlock.tsx web/src/components/DelegationBlock.module.css web/src/components/EventLine.tsx web/src/components/ConversationView.tsx
git commit -m "feat(web): collapsed delegation cards with live peek in parent thread"
```

---

## Task 5: Stacking Side Panels (Thread View)

Replace the current "filter whole page" agent navigation with stacking side panels that open when clicking "View thread". Panels stack right like Obsidian. Each panel shows the full event timeline for that agent.

**Files:**
- Create: `web/src/components/ThreadPanel.tsx`
- Create: `web/src/components/ThreadPanel.module.css`
- Modify: `web/src/App.tsx` (add panel state, render panels)
- Modify: `web/src/App.module.css` (layout for panels)
- Modify: `web/src/hooks/useAgentTree.ts:149-166` (replace selectedAgent with panel stack)
- Test: `web/src/components/__tests__/components.test.tsx`

**Step 1: Write the failing test**

In `web/src/components/__tests__/components.test.tsx`:

```typescript
describe("ThreadPanel", () => {
	test("renders header with agent name and close button", () => {
		const tree = buildAgentTree([
			makeEvent("perceive", "root", 0, { goal: "Go" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit file", child_id: "CID1" }),
		]);
		const html = renderToStaticMarkup(
			<ThreadPanel
				agentId="CID1"
				tree={tree}
				events={[]}
				onClose={() => {}}
				onSelectAgent={() => {}}
			/>,
		);
		expect(html).toContain("editor");
		expect(html).toContain("Edit file");
		expect(html).toContain("data-action=\"close\"");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src/components/__tests__/components.test.tsx --filter "ThreadPanel"`
Expected: FAIL — `ThreadPanel` doesn't exist.

**Step 3: Implement**

3a. Create `web/src/components/ThreadPanel.tsx`:

```typescript
import type { SessionEvent } from "../../../src/kernel/types.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import { ConversationView } from "./ConversationView.tsx";
import styles from "./ThreadPanel.module.css";

interface ThreadPanelProps {
	agentId: string;
	tree: AgentTreeNode;
	events: SessionEvent[];
	onClose: () => void;
	onSelectAgent: (agentId: string) => void;
}

function findNode(node: AgentTreeNode, agentId: string): AgentTreeNode | null {
	if (node.agentId === agentId) return node;
	for (const child of node.children) {
		const found = findNode(child, agentId);
		if (found) return found;
	}
	return null;
}

export function ThreadPanel({ agentId, tree, events, onClose, onSelectAgent }: ThreadPanelProps) {
	const node = findNode(tree, agentId);
	const agentName = node?.agentName ?? agentId;
	const goal = node?.goal ?? "";

	return (
		<div className={styles.panel} data-region="thread-panel">
			<div className={styles.header}>
				<div className={styles.headerInfo}>
					<span className={styles.agentName}>{agentName}</span>
					<span className={styles.goal}>{goal}</span>
				</div>
				<button
					type="button"
					className={styles.close}
					data-action="close"
					onClick={onClose}
					aria-label="Close thread"
				>
					{"\u2715"}
				</button>
			</div>
			<div className={styles.body}>
				<ConversationView
					events={events}
					agentFilter={agentId}
					tree={tree}
					onSelectAgent={onSelectAgent}
				/>
			</div>
		</div>
	);
}
```

3b. Create `web/src/components/ThreadPanel.module.css`:

```css
.panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-width: 400px;
	max-width: 600px;
	border-left: 1px solid var(--color-border);
	background: var(--color-canvas);
}

.header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: var(--space-sm) var(--space-md);
	border-bottom: 1px solid var(--color-border);
	gap: var(--space-sm);
}

.headerInfo {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.agentName {
	font-family: var(--font-mono);
	font-size: var(--font-size-sm);
	font-weight: 600;
	color: var(--color-text-primary);
}

.goal {
	font-size: var(--font-size-xs);
	color: var(--color-text-secondary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.close {
	all: unset;
	cursor: pointer;
	color: var(--color-text-tertiary);
	font-size: var(--font-size-base);
	padding: var(--space-xs);
	border-radius: var(--radius-sm);
	flex-shrink: 0;
}

.close:hover {
	color: var(--color-text-primary);
	background: var(--color-surface);
}

.body {
	flex: 1;
	overflow-y: auto;
}
```

3c. Update `App.tsx` to manage panel stack and render panels:

Replace `selectedAgent` with a panel stack. In `App.tsx`:

Replace `useAgentTree` usage:
```typescript
const { tree } = useAgentTree(events);
const [panelStack, setPanelStack] = useState<string[]>([]);
```

Remove `selectedAgent` and `setSelectedAgent` from `useAgentTree` destructuring.

Add panel management callbacks:
```typescript
const openPanel = useCallback((agentId: string) => {
	setPanelStack((prev) => {
		// If already in stack, close everything above it
		const idx = prev.indexOf(agentId);
		if (idx >= 0) return prev.slice(0, idx + 1);
		return [...prev, agentId];
	});
}, []);

const closePanel = useCallback((agentId: string) => {
	setPanelStack((prev) => {
		const idx = prev.indexOf(agentId);
		if (idx >= 0) return prev.slice(0, idx);
		return prev;
	});
}, []);
```

Update the body section to render panels:
```typescript
<main
	ref={conversationRef}
	className={styles.conversation}
	data-region="conversation"
	onScroll={handleScroll}
>
	<ConversationView
		events={events}
		tree={tree}
		onSelectAgent={openPanel}
	/>
	{userScrolledUp && (
		<button type="button" className={styles.jumpToBottom} onClick={jumpToBottom}>
			Jump to bottom
		</button>
	)}
</main>
{panelStack.map((agentId) => (
	<ThreadPanel
		key={agentId}
		agentId={agentId}
		tree={tree}
		events={events}
		onClose={() => closePanel(agentId)}
		onSelectAgent={openPanel}
	/>
))}
```

Remove the `Breadcrumb` component — panels replace it. Remove the import.

Update `Sidebar` — pass `panelStack` and `openPanel` instead of `selectedAgent`/`setSelectedAgent`:
```typescript
<Sidebar
	status={status}
	tree={tree}
	selectedAgent={panelStack[panelStack.length - 1] ?? null}
	onSelectAgent={openPanel}
	onToggle={toggleSidebar}
	events={events}
/>
```

Update `clearFilter` keyboard shortcut:
```typescript
clearFilter: () => setPanelStack([]),
```

3d. Update `App.module.css` to support panels in the layout:

Change `.body` grid to accommodate panels:
```css
.body {
	display: flex;
	overflow: hidden;
	border-top: 1px solid var(--color-border);
}

.body[data-sidebar-open="false"] .sidebar {
	display: none;
}

.sidebar {
	width: var(--sidebar-width);
	flex-shrink: 0;
	overflow-y: auto;
	border-right: 1px solid var(--color-border);
}

.conversation {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	position: relative;
	flex: 1;
	min-width: 300px;
}
```

Remove the old grid-based layout rules and replace with flex.

3e. Simplify `useAgentTree` hook — remove `selectedAgent` state since panels now manage this in `App.tsx`:

In `web/src/hooks/useAgentTree.ts`, simplify the hook:

```typescript
interface UseAgentTreeResult {
	tree: AgentTreeNode;
}

export function useAgentTree(events: SessionEvent[]): UseAgentTreeResult {
	const tree = useMemo(() => buildAgentTree(events), [events]);
	return { tree };
}
```

Update all call sites to not destructure `selectedAgent`/`setSelectedAgent`.

**Step 4: Run tests**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src`
Expected: Some existing tests may need updating to reflect the removed `selectedAgent` from `useAgentTree`. Fix any test references.

**Step 5: Commit**

```bash
git add web/src/components/ThreadPanel.tsx web/src/components/ThreadPanel.module.css web/src/App.tsx web/src/App.module.css web/src/hooks/useAgentTree.ts web/src/components/__tests__/components.test.tsx
git commit -m "feat(web): stacking thread panels for agent drill-down"
```

---

## Task 6: Remove Breadcrumb Component (Cleanup)

The Breadcrumb component is replaced by the panel stack navigation. Remove it and its tests.

**Files:**
- Delete: `web/src/components/Breadcrumb.tsx`
- Delete: `web/src/components/Breadcrumb.module.css`
- Modify: `web/src/components/__tests__/components.test.tsx` (remove Breadcrumb tests)
- Modify: `web/src/App.tsx` (remove Breadcrumb import — should already be done in Task 5)

**Step 1: Remove Breadcrumb test block**

In `web/src/components/__tests__/components.test.tsx`, delete the entire `describe("Breadcrumb", ...)` block and remove the `Breadcrumb` import.

**Step 2: Delete Breadcrumb files**

```bash
rm web/src/components/Breadcrumb.tsx web/src/components/Breadcrumb.module.css
```

**Step 3: Run tests to verify nothing breaks**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src`
Expected: All pass.

**Step 4: Commit**

```bash
git add -u web/src/components/Breadcrumb.tsx web/src/components/Breadcrumb.module.css web/src/components/__tests__/components.test.tsx web/src/App.tsx
git commit -m "refactor(web): remove Breadcrumb component, replaced by thread panels"
```

---

## Task 7: End-to-End Verification

Run the full test suite (backend + frontend) and verify everything passes. Do a manual check of the overall architecture.

**Files:**
- No new files.

**Step 1: Run full backend test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test $(find test -name '*.test.ts' -o -name '*.test.tsx' | grep -v integration | grep -v 'anthropic.test' | grep -v 'gemini.test' | grep -v 'openai.test' | grep -v 'client.test')`
Expected: All pass.

**Step 2: Run full web test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test web/src`
Expected: All pass.

**Step 3: Run TypeScript type check**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && npx tsc --noEmit`
Expected: No errors.

**Step 4: Verify TUI rendering still works**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/web-interface && bun test test/tui`
Expected: All pass. TUI tests use `renderEvent` which reads from `event.data` directly, so adding `child_id` to the data should not affect existing TUI formatting.

**Step 5: Commit (if any fixes were needed)**

```bash
git commit -m "fix: address integration issues from thread UX implementation"
```
