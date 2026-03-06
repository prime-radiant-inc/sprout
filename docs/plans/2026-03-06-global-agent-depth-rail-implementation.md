# Global Agent Depth Rail Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove spec-level `max_depth` from agent constraints and replace it with a single global agent-tree depth rail of `8`.

**Architecture:** Agent specs keep `can_spawn` as the only delegation permission bit. The runtime enforces one absolute depth cap from root (`depth <= 8`) and rejects any attempt to create an agent deeper than that cap. Markdown parsing and `save_agent` reject `constraints.max_depth` so the old model is removed cleanly instead of lingering as accidental compatibility.

**Tech Stack:** Bun, TypeScript, YAML-fronted Markdown agent specs

---

### Task 1: Write the failing tests for the new constraint contract

**Files:**
- Modify: `test/agents/agent-construction.test.ts`
- Modify: `test/agents/markdown-loader.test.ts`
- Modify: `test/kernel/save-agent.test.ts`
- Modify: `test/kernel/types.test.ts`

**Step 1: Write the failing tests**

- Replace tests that expect `constraints.max_depth`.
- Add a loader test that rejects unknown constraint keys such as `max_depth`.
- Add an agent construction test that allows depth `8` and rejects depth `9`.
- Add a `save_agent` test that rejects `constraints.max_depth`.

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/agent-construction.test.ts test/agents/markdown-loader.test.ts test/kernel/save-agent.test.ts test/kernel/types.test.ts`

Expected: FAIL because the code still accepts `max_depth` and still uses the old depth check.

### Task 2: Implement the minimal runtime and schema change

**Files:**
- Modify: `src/kernel/types.ts`
- Modify: `src/agents/agent.ts`
- Modify: `src/agents/markdown-loader.ts`
- Modify: `src/kernel/primitives.ts`
- Modify: `test/agents/fixtures.ts`

**Step 1: Remove `max_depth` from the constraint type**

- Delete `max_depth` from `AgentConstraints` and `DEFAULT_CONSTRAINTS`.
- Add a shared global depth constant set to `8`.

**Step 2: Enforce the global rail in the agent runtime**

- Reject construction when `depth > 8`.
- Keep delegation permission tied to `can_spawn`; depth overflow is rejected when a child would be created too deep.

**Step 3: Reject `constraints.max_depth` in parsing and save_agent**

- Validate allowed constraint keys.
- Return a clear error when `max_depth` appears.

**Step 4: Run tests to verify they pass**

Run: `bun test test/agents/agent-construction.test.ts test/agents/markdown-loader.test.ts test/kernel/save-agent.test.ts test/kernel/types.test.ts`

Expected: PASS

### Task 3: Remove `max_depth` from checked-in agent specs and tests

**Files:**
- Modify: `root/root.md`
- Modify: `root/agents/**/*.md`
- Modify: `test/agents/*.test.ts`
- Modify: `test/bus/*.test.ts`

**Step 1: Remove spec-level `max_depth` from root agent markdown**

- Delete the `max_depth` line from every checked-in agent spec.

**Step 2: Update fixtures and tests to the new constraint shape**

- Remove `max_depth` from agent fixtures and inline specs.
- Update any test assertions that still expect it to exist.

**Step 3: Run targeted tests**

Run: `bun test test/agents/loader.test.ts test/agents/agent.test.ts test/bus/agent-process.test.ts test/bus/spawner.test.ts`

Expected: PASS

### Task 4: Update docs and prompts that still teach the old model

**Files:**
- Modify: `root/agents/quartermaster/agents/qm-fabricator.md`
- Modify: `root/agents/quartermaster/resources/agent-tree-spec.md`
- Modify: `docs/ROOT_AGENT_DELEGATION_ARCHITECTURE.md`

**Step 1: Remove `max_depth` guidance**

- Replace spec guidance with `can_spawn` plus the global depth rail.

**Step 2: Run a quick grep for stale references**

Run: `rg -n "max_depth" src test root docs`

Expected: Only historical plan/archive docs remain, or intentionally retained references are obvious.

### Task 5: Verify and commit

**Files:**
- Modify: none

**Step 1: Run final verification**

Run: `bun test test/agents/agent-construction.test.ts test/agents/markdown-loader.test.ts test/kernel/save-agent.test.ts test/kernel/types.test.ts test/agents/loader.test.ts`

Expected: PASS

**Step 2: Commit**

```bash
git add docs/plans/2026-03-06-global-agent-depth-rail-implementation.md src/kernel/types.ts src/agents/agent.ts src/agents/markdown-loader.ts src/kernel/primitives.ts test/agents/fixtures.ts test/agents/agent-construction.test.ts test/agents/markdown-loader.test.ts test/kernel/save-agent.test.ts test/kernel/types.test.ts root/root.md root/agents
git commit -m "refactor: replace per-agent depth with global depth rail"
```
