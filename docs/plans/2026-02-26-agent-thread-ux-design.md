# Agent Thread UX Design

**Goal:** Replace the flat event log with a threaded conversation model that collapses child agent activity into delegation cards, supports drill-down via stacking side panels, and provides a collapsible sidebar tree for navigation.

**Architecture:** Kernel emits unique child IDs (ULIDs) per delegation. The web UI groups child events into collapsed cards with live-peek summaries. Side panels stack Obsidian-style for deep delegation chains. A sidebar tree provides structural overview.

---

## Section 1: Kernel — Unique Child IDs

**Problem:** Child agents use `this.spec.name` as their `agent_id`, so multiple delegations to the same agent type produce duplicate IDs. The current `#N` disambiguation in the web UI is fragile and breaks tree lookups.

**Fix:**

1. In `agent.ts`, when building a child `AgentSpec` for delegation, generate a ULID and assign it as `childId`.
2. Emit `data.child_id` in both `act_start` and `act_end` events.
3. Pass `childId` to the child agent; child uses it as its `agent_id` for all events it emits.
4. `buildAgentTree` keys nodes on `child_id` instead of `agent_name`. The `#N` disambiguation logic is removed.

**Result:** Every delegation gets a globally unique ID. Tree building becomes a simple map lookup. No ambiguity.

---

## Section 2: Main Thread — Collapsed Delegation Cards

**Problem:** Child agent events (tool calls, plan deltas, sub-delegations) are interleaved into the parent thread, making it hard to follow the parent's conversation.

**Fix:**

1. `groupEvents` filters out events from child agents in the parent view (already partially works via `agentFilter`).
2. Each delegation appears as a single `DelegationBlock` card that merges `act_start` and `act_end` state:
   - While running: shows agent name, goal, spinner, and a 1-2 line live peek of latest child activity (most recent tool call or plan text).
   - When done: shows agent name, goal, status badge (completed/failed), turns count, duration.
3. The live peek updates via the streaming event pipeline — no polling.
4. "View thread" button on each card opens the side panel.

**Card states:**
- Running: `[spinner] code-editor — "Edit file.ts"` + peek: `Running: write_file config.ts`
- Completed: `[check] code-editor — "Edit file.ts" — 3 turns, 2.1s`
- Failed: `[x] code-editor — "Edit file.ts" — failed after 1 turn`

---

## Section 3: Side Panel Thread View

**Problem:** When drilling into a child agent, the user loses context of the parent conversation and can't navigate back easily.

**Fix:**

1. "View thread" opens a side panel on the right showing that agent's full event timeline.
2. Panels stack to the right, Obsidian-style: clicking "View thread" on a sub-delegation within a panel opens another panel further right.
3. Each panel has a header showing agent name, goal, and a close button.
4. Closing a panel reveals the one beneath it.
5. The main thread remains visible (though narrowed) when panels are open.

**Panel anatomy:**
- Header: agent name, goal, status badge, close (X)
- Body: full event timeline for that agent (same `ConversationView` component, filtered to that agent and descendants)
- Sub-delegations within the panel render as collapsed cards, same as the main thread

---

## Section 4: Sidebar Tree

**Problem:** With collapsed cards, users need a way to see the full agent hierarchy at a glance and jump to any agent.

**Fix:**

1. Replace the current flat `AgentTree` component with a proper collapsible tree using disclosure triangles.
2. Each node shows: agent name, status indicator (spinner/check/x), and goal text (truncated).
3. Nodes auto-expand when they become active (new child spawned or activity detected).
4. Clicking a node opens its thread in the side panel.
5. The currently-viewed agent is highlighted in the tree.
6. Tree is always visible in the sidebar (not just while running).
