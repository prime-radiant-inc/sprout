# Runtime Delegation Refresh Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve genome-created root delegates across agent reconstruction and record capability updates as runtime—not human—context.

**Architecture:** `Agent` will use one helper to merge genome agents into its shared runtime tree both during construction and live refresh. Live additions will be queued into a dedicated system-prompt block and emitted as `delegation_update`; they will never enter message history or replay as user input.

**Tech Stack:** TypeScript, Bun test runner, Sprout session events and agent runtime.

---

## Chunk 1: Restart-Safe Delegation

### Task 1: Reconstruct persisted dynamic delegates

**Files:**
- Modify: `test/agents/dynamic-delegation.test.ts`
- Modify: `src/agents/agent.ts`

- [ ] **Step 1: Write the failing regression test**

Create a genome containing a root, a nested static specialist, and `persisted-agent`; create a static
tree that represents the nested specialist but omits `persisted-agent`; construct a fresh root
`Agent`; assert its `delegate` tool schema contains `persisted-agent` but not the nested specialist.
Exercise a live refresh from the same fixture and assert the live and newly reconstructed delegate
name sets are identical.

- [ ] **Step 2: Verify RED**

Run: `bun test test/agents/dynamic-delegation.test.ts`

Expected: FAIL because constructor-time `getDelegatableAgents()` consults only the static tree.

- [ ] **Step 3: Implement one tree merge helper**

Add a private helper that:

```ts
private mergeGenomeAgentsIntoRuntimeTree(): void {
	if (!this.genome || !this.agentTree) return;
	const representedNames = new Set([...this.agentTree.values()].map((entry) => entry.spec.name));
	for (const spec of this.genome.allAgents()) {
		if (spec.name === this.spec.name || representedNames.has(spec.name)) continue;
		this.agentTree.set(spec.name, {
			spec,
			path: spec.name,
			children: [],
			diskPath: "",
		});
		representedNames.add(spec.name);
		if (
			this.agentTreeSelfPath === "" &&
			this.agentTreeChildren &&
			!this.agentTreeChildren.includes(spec.name)
		) {
			this.agentTreeChildren.push(spec.name);
		}
	}
}
```

Call it before constructor delegate resolution and from `refreshDelegationList()` before re-resolving.
Remove the duplicate inline merge loop.

- [ ] **Step 4: Verify GREEN**

Run: `bun test test/agents/dynamic-delegation.test.ts`

Expected: PASS.

- [ ] **Step 5: Run strict focused verification**

Run: `bun test test/agents/dynamic-delegation.test.ts && bun run typecheck`

Expected: PASS with identical live and reconstructed delegate sets and no type errors.

## Chunk 2: Correct Provenance

### Task 2: Represent capability changes as runtime context

**Files:**
- Modify: `test/agents/dynamic-delegation.test.ts`
- Modify: `test/host/resume.test.ts`
- Modify: `test/kernel/types.test.ts`
- Modify: `test/tui/render-event.test.ts`
- Modify: `test/tui/event-components.test.tsx`
- Modify: `src/agents/agent.ts`
- Modify: `src/kernel/types.ts`
- Modify: `src/tui/render-event.ts`
- Modify: `src/tui/event-components.tsx`

- [ ] **Step 1: Write failing provenance tests**

Assert a live genome change:

```ts
expect(events.collected().filter((event) => event.kind === "steering")).toHaveLength(0);
expect(events.collected().filter((event) => event.kind === "delegation_update")).toHaveLength(1);
expect(messageText(capturedRequests[1]!.messages[0]!)).toContain(
	"<sprout:delegation-update>",
);
expect(capturedRequests[1]!.messages.some((message) =>
	message.role === "user" && messageText(message).includes("New agents"),
)).toBe(false);
expect(messageText(capturedRequests[2]!.messages[0]!)).not.toContain(
	"<sprout:delegation-update>",
);
```

Capture `Request` objects through the fake client's `complete(request)` callback. Run once, add the
agent, continue twice, and assert the update appears only in the first post-refresh request. Also
assert `replayEventLog()` ignores `delegation_update`; both text and Ink renderers must label it as a
system delegation update rather than a user prompt.

- [ ] **Step 2: Verify RED**

Run: `bun test test/agents/dynamic-delegation.test.ts test/host/resume.test.ts test/kernel/types.test.ts test/tui/render-event.test.ts test/tui/event-components.test.tsx`

Expected: FAIL because `delegation_update` is unknown and refresh emits `steering` plus `Msg.user`.

- [ ] **Step 3: Implement minimal runtime update queue**

Add `delegation_update` to `EVENT_KINDS`. Store pending descriptions in a private queue. Render that
queue inside `<sprout:delegation-update>` from `renderCurrentSystemPrompt()`, mark entries rendered,
and clear them alongside rendered agent messages after the run. In `runLoop()`, replace
`history.push(Msg.user(text))` and `emitAndLog("steering", ...)` with queueing plus:

```ts
this.emitAndLog("delegation_update", agentId, this.depth, { agents: newAgents });
```

Render the event as a system-status line in both renderers. Do not add a replay conversion case;
omission is the required behavior.

- [ ] **Step 4: Verify GREEN**

Run the five focused test files from Step 2.

Expected: PASS with no warnings.

## Chunk 3: Integration and History

### Task 3: Verify and consolidate

**Files:** None; verification and Git history only.

- [ ] **Step 1: Run the canonical precommit gate**

Run: `bun run precommit`

Expected: formatting, typecheck, and unit tests pass.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`

Expected: all tests pass; existing intentional skips remain unchanged.

- [ ] **Step 3: Verify the precise pending-file set**

Run: `git status --short && git diff --stat`

Expected: only the two delegation design/plan docs plus the listed agent, kernel, host-resume, and
TUI implementation/test files are pending.

- [ ] **Step 4: Fold the design and plan into the documentation intent**

Run: `git add docs/superpowers/specs/2026-08-01-runtime-delegation-refresh-design.md docs/superpowers/plans/2026-08-01-runtime-delegation-refresh.md && git commit --amend -m "fixup! docs: design reliable runtime agent tooling"`

Expected: the current commit contains both docs and has a fixup subject targeting the existing docs
intent.

- [ ] **Step 5: Commit implementation and tests to the runtime intent**

Run: `git add src/agents/agent.ts src/kernel/types.ts src/tui/render-event.ts src/tui/event-components.tsx test/agents/dynamic-delegation.test.ts test/host/resume.test.ts test/kernel/types.test.ts test/tui/render-event.test.ts test/tui/event-components.test.tsx && git commit --fixup=e63e1f70`

Expected: a new `fixup! fix: make runtime agent tooling reliable` commit and a clean worktree.

- [ ] **Step 6: Preserve a recovery ref**

Run: `git branch backup/root-path-tools-pr-pre-delegation-curation HEAD`

Expected: backup ref points to the verified pre-autosquash head.

- [ ] **Step 7: Autosquash onto upstream**

Run: `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash origin/main`

Expected: four commits remain in order: fixture isolation, eval setup, docs, runtime tooling.

- [ ] **Step 8: Verify rewritten tree and commits**

Run: `git log --oneline --reverse origin/main..HEAD && git status --short`

Expected: exactly four intent commits and a clean worktree.

- [ ] **Step 9: Update PR #3 with an exact lease**

Run: `git push --force-with-lease=refs/heads/fix/root-path-tools-pr:e63e1f7070e9518ceb1dc0d6f32b4cc26155bb2e fork HEAD:fix/root-path-tools-pr`

Expected: fork branch advances from `e63e1f70` to the rewritten four-commit head.

- [ ] **Step 10: Verify remote PR state**

Run: `gh pr view 3 --repo prime-radiant-inc/sprout --json url,headRefOid,commits`

Expected: PR #3 reports the pushed head and exactly four commits.
