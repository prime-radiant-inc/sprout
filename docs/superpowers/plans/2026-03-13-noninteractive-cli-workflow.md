# Non-Interactive CLI Workflow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fully non-interactive CLI workflow that starts or resumes sessions with `-p/--prompt`, prints the final response, and shares the same settings-backed session runtime as interactive mode.

**Architecture:** Split CLI parsing and command execution into focused modules, remove the legacy env-based one-shot runtime, and add a dedicated headless runner that uses the same session bootstrap and resume state as interactive mode. Expose a structured session run result so headless callers can print output and choose exit status without scraping events.

**Tech Stack:** TypeScript, Bun, Bun test, Biome, existing Sprout host/session runtime.

---

## File Map

- Create: `src/host/cli-parse.ts`
  - Dedicated typed parser and usage text for the supported CLI grammar.
- Create: `src/host/cli-run.ts`
  - Top-level CLI dispatch for interactive, picker, genome, and headless commands.
- Create: `src/host/cli-headless.ts`
  - Non-interactive session runner built on the shared session bootstrap.
- Modify: `src/host/cli.ts`
  - Reduce to a thin entrypoint plus shared helpers that still belong there.
- Modify: `src/host/cli-bootstrap.ts`
  - Rename or generalize bootstrap export so both interactive and headless modes use it.
- Modify: `src/host/cli-resume.ts`
  - Remove `resume-last` behavior and keep explicit resume-state loading only.
- Modify: `src/host/session-controller.ts`
  - Add a structured run result path for headless callers.
- Delete: `src/host/cli-oneshot.ts`
  - Remove the legacy env-based one-shot runtime path.
- Modify: `test/host/cli.test.ts`
  - Parser and dispatch coverage for the new command grammar.
- Modify: `test/host/cli-resume.test.ts`
  - Remove `resume-last` expectations.
- Modify: `test/host/session-controller.test.ts`
  - Structured session run result coverage.
- Delete or replace: `test/host/cli-oneshot.test.ts`
  - Replace with headless-runner tests.
- Create: `test/host/cli-headless.test.ts`
  - Headless new-run and resumed-run coverage.

## Chunk 1: Parser Cleanup

### Task 1: Replace the current pre-scan parser with a dedicated parser module

**Files:**
- Create: `src/host/cli-parse.ts`
- Modify: `src/host/cli.ts`
- Test: `test/host/cli.test.ts`

- [ ] **Step 1: Write the failing parser tests for the new grammar**

Add or update parser tests in `test/host/cli.test.ts` for:
- `sprout -p "Fix the bug"` -> headless new-session command
- `sprout --prompt "Fix the bug"` -> same
- `sprout --resume 01ABC -p "continue"` -> headless resumed-session command
- `sprout --resume 01ABC` -> interactive resume command
- `sprout --resume` -> picker command
- bare positional goal -> help
- `--resume-last` -> help

- [ ] **Step 2: Run the parser tests and watch them fail**

Run: `bun test test/host/cli.test.ts`

Expected: parser expectations fail because `parseArgs` still returns `oneshot`, still accepts bare goals, and still accepts `resume-last`.

- [ ] **Step 3: Implement the dedicated parser**

Create `src/host/cli-parse.ts` with:
- `CliCommand` types
- `parseArgs(argv)`
- `USAGE`

Implement a small linear parser instead of adding a third-party dependency. Support:
- `-p` / `--prompt`
- `--resume` with optional session id
- interactive web/log flags
- explicit genome commands

Reject:
- bare positional goals
- `--resume-last`
- malformed flag/value combinations

- [ ] **Step 4: Re-export the new parser through `cli.ts` if tests or callers still import from there**

Keep the external module surface stable only where needed for in-repo callers. Remove the old parser logic from `cli.ts`.

- [ ] **Step 5: Run the parser tests and make them pass**

Run: `bun test test/host/cli.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the parser refactor**

```bash
git add src/host/cli-parse.ts src/host/cli.ts test/host/cli.test.ts
git commit -m "refactor: split cli parsing from entrypoint"
```

## Chunk 2: Shared Headless Runtime

### Task 2: Replace the legacy one-shot runner with a headless session runner

**Files:**
- Create: `src/host/cli-headless.ts`
- Delete: `src/host/cli-oneshot.ts`
- Modify: `src/host/cli-run.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Test: `test/host/cli-headless.test.ts`

- [ ] **Step 1: Write failing tests for headless new-session execution**

Add tests in `test/host/cli-headless.test.ts` that assert a headless runner:
- starts a session with a generated session id
- uses the shared bootstrap result instead of `Client.fromEnv()`
- writes final output to stdout writer
- writes session id to stderr writer
- cleans up infrastructure

- [ ] **Step 2: Run the headless tests and watch them fail**

Run: `bun test test/host/cli-headless.test.ts`

Expected: FAIL because `cli-headless.ts` does not exist.

- [ ] **Step 3: Implement `cli-headless.ts` on top of the shared session bootstrap**

Create a runner that:
- starts bus infrastructure
- optionally loads resume state
- calls the shared bootstrap from `cli-bootstrap.ts`
- invokes the controller run method
- prints output/result lines
- always cleans up infra

Do not render events or create the TUI/web server.

- [ ] **Step 4: Remove the legacy env-based one-shot path**

Delete `src/host/cli-oneshot.ts` and stop calling it from the CLI runner.

- [ ] **Step 5: Run the new headless tests and make them pass**

Run: `bun test test/host/cli-headless.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the headless runner refactor**

```bash
git add src/host/cli-headless.ts src/host/cli-bootstrap.ts src/host/cli-run.ts test/host/cli-headless.test.ts
git rm src/host/cli-oneshot.ts
git commit -m "feat: add shared headless cli runner"
```

## Chunk 3: Session Result Contract

### Task 3: Expose a structured session run result

**Files:**
- Modify: `src/host/session-controller.ts`
- Test: `test/host/session-controller.test.ts`

- [ ] **Step 1: Write failing tests for the structured run result**

Add tests in `test/host/session-controller.test.ts` for a controller run method that returns:
- `sessionId`
- `output`
- `success`
- `stumbles`
- `turns`
- `timedOut`

Also assert that the existing interactive submit path still works when callers ignore the result.

- [ ] **Step 2: Run the controller tests and watch them fail**

Run: `bun test test/host/session-controller.test.ts`

Expected: FAIL because the controller only exposes `submitGoal(): Promise<void>`.

- [ ] **Step 3: Implement the structured run result**

Add a dedicated controller method for headless callers, or update the current run path cleanly, without adding duplicate runtime logic. Keep steering and command-handler behavior intact for interactive mode.

- [ ] **Step 4: Run the controller tests and make them pass**

Run: `bun test test/host/session-controller.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the controller contract change**

```bash
git add src/host/session-controller.ts test/host/session-controller.test.ts
git commit -m "feat: return structured session run results"
```

## Chunk 4: CLI Dispatch Refactor

### Task 4: Move command execution into a dedicated runner module

**Files:**
- Create: `src/host/cli-run.ts`
- Modify: `src/host/cli.ts`
- Modify: `src/host/cli-resume.ts`
- Test: `test/host/cli.test.ts`
- Test: `test/host/cli-resume.test.ts`

- [ ] **Step 1: Write failing tests for command dispatch**

Add or update tests that assert:
- headless commands call the headless runner
- `--resume <id>` with no prompt still reaches interactive resume
- bare `--resume` still reaches picker mode
- `resume-last` is no longer supported

- [ ] **Step 2: Run the CLI and resume tests and watch them fail**

Run: `bun test test/host/cli.test.ts test/host/cli-resume.test.ts`

Expected: FAIL because command kinds and dispatch still assume `oneshot` and `resume-last`.

- [ ] **Step 3: Implement the dedicated runner**

Create `src/host/cli-run.ts` and move top-level dispatch there. Keep `cli.ts` as:
- shared exports still needed elsewhere
- `if (import.meta.main)` entrypoint only

Update `cli-resume.ts` to remove `resume-last` support.

- [ ] **Step 4: Run the CLI and resume tests and make them pass**

Run: `bun test test/host/cli.test.ts test/host/cli-resume.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the runner refactor**

```bash
git add src/host/cli-run.ts src/host/cli.ts src/host/cli-resume.ts test/host/cli.test.ts test/host/cli-resume.test.ts
git commit -m "refactor: split cli command execution from entrypoint"
```

## Chunk 5: Final Integration Verification

### Task 5: Run the focused and full verification suite

**Files:**
- Modify only if a failing test reveals a real bug

- [ ] **Step 1: Run focused host tests**

Run:

```bash
bun test test/host/cli.test.ts
bun test test/host/cli-headless.test.ts
bun test test/host/cli-resume.test.ts
bun test test/host/session-controller.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run formatting and typecheck**

Run:

```bash
bun run check
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the full pre-commit suite**

Run:

```bash
bun run precommit
```

Expected: PASS.

- [ ] **Step 4: Commit any final integration fix**

If verification required a real code fix:

```bash
git add <files>
git commit -m "fix: complete non-interactive cli workflow"
```
