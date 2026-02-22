# Phase 8: Integration Testing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the end-to-end integration tests from spec Section 14.9 that exercise the full agent system — bootstrap, multi-step tasks, stumble-and-learn, genome growth, and cross-session persistence.

**Architecture:** A single integration test file with 5 ordered test cases that share a genome directory (simulating a real user's experience across sessions). Each test builds on the previous — the genome grows over the course of the test suite.

**Tech Stack:** TypeScript/Bun, real API calls (Anthropic), `bun test`

---

## Context

**What already exists:**
- Full agent system (Phases 1-7): types, primitives, LLM client, core loop, genome, recall, learn, events, host interface
- `test/agents/agent.integration.test.ts` — existing integration tests (2 tests: fresh genome file creation, memory recall)
- `test/learn/learn.integration.test.ts` — existing Learn integration test (1 test: failure signal → genome mutation)
- `createAgent()` factory at `src/agents/factory.ts`
- `submitGoal()` at `src/host/session.ts`
- Bootstrap agents at `bootstrap/` (root, code-reader, code-editor, command-runner)

**What's missing:**
- The 5 E2E tests from spec Section 14.9 that validate the complete system

**Key file to create:**
- `test/integration/e2e.test.ts`

---

### Task 1: E2E Integration Test Suite

**Files:**
- Create: `test/integration/e2e.test.ts`

Create the 5 ordered integration tests. They share a single genome directory so genome growth is cumulative across tests. Each test uses real API calls (Anthropic via dotenv).

**Test 1: Bootstrap — Fresh genome, simple file creation**
```
agent = createAgent(genome = fresh_genome())
agent.submit("Create a file hello.py that prints 'Hello World'")
ASSERT file_exists("hello.py")
```
- Create a fresh genome with bootstrap agents
- Create a temp working directory
- Run the agent with the goal
- Verify hello.py was created in the working directory
- Timeout: 120s

**Test 2: Multi-step — Requires decomposition**
```
agent.submit("Add a command-line argument to hello.py that takes a name,
              then write a test for it")
ASSERT file_exists("hello.py") AND contains("argparse" OR "sys.argv")
ASSERT file_exists test file
```
- Re-use the same genome and working directory from test 1
- Run a more complex goal requiring multiple steps
- Verify the file was modified and a test file created
- Timeout: 180s

**Test 3: Stumble and learn — Force an error pattern**
```
agent.submit("Run the tests")  -- may stumble on test runner detection
```
- Push 3 stumble signals to the learn process to simulate repeated failures (mimicking what would happen if the agent tried `pytest` 3 times)
- Then drain the learn queue
- Verify a genome mutation occurred (memory, agent, or routing rule)
- Timeout: 120s

Note: Running the actual agent and waiting for real stumbles would be unreliable in tests. Instead, we simulate the repeated stumble pattern by pushing signals directly to the LearnProcess and then draining. This tests the full Learn pipeline (filtering + LLM reasoning + mutation) without the fragility of hoping the agent actually stumbles in a specific way.

**Test 4: Genome growth — Verify new content**
```
ASSERT genome.agent_count() > bootstrap_agent_count OR genome.memories.all().length > 0
```
- After tests 1-3, verify the genome has grown (new memories, routing rules, or agents beyond the bootstrap 4)
- This is a cumulative check on the shared genome

**Test 5: Cross-session persistence — New session, same genome**
```
agent2 = createAgent(genome = load_genome())
-- Should find learned content from previous session
```
- Create a new agent from the same genome directory (simulating a new session)
- Verify the genome loads successfully with learned content
- Optionally run a simple task to verify recall works with the enriched genome
- Timeout: 120s

**Implementation notes:**
- Use `beforeAll` to create the shared genome directory and temp working directory
- Use `afterAll` to clean up
- Tests run in order (Bun respects test declaration order within a describe block)
- Use `config({ path: ... })` for dotenv to load API keys
- Set generous timeouts since real API calls are involved

**Step 1: Write the test file**

**Step 2: Run tests**

Run: `bun test test/integration/e2e.test.ts`
Expected: All 5 tests PASS

**Step 3: Run full suite**

Run: `bun test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add test/integration/e2e.test.ts
git commit -m "test: add end-to-end integration tests per spec Section 14.9"
```

---

### Task 2: Update Memory File

Update the project memory file with Phase 6-8 completion status.

---

## Summary

After Phase 8, all 8 build phases are complete. The Definition of Done checklist from spec Section 14 should be substantially covered:

- [x] Core Loop (14.1)
- [x] Agents and Primitives (14.2)
- [x] Genome (14.3)
- [x] Recall (14.4)
- [x] Learn (14.5) — except periodic pruning
- [x] Multi-Provider (14.6)
- [x] Immutable Kernel (14.7) — enforced by design
- [x] Bootstrap (14.8)
- [x] Integration Test (14.9)
