# Sprout Root Path Resolution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Sprout-owned agent paths out of the target project and make `sprout-mcp` a reliable structured runtime capability.

**Architecture:** Keep filesystem primitive semantics unchanged: relative paths continue to target the project working directory. Mark Sprout-owned paths explicitly with the existing `{{SPROUT_ROOT}}` prompt template. Treat workspace tools as structured primitives rather than raw PATH executables, remove MCP's ambiguous `exec` route, then regenerate the embedded root bundle used by compiled installations.

**Tech Stack:** TypeScript, Bun test runner, Markdown agent specifications, generated embedded-root TypeScript.

---

## Chunk 1: Root-path regression and prompt correction

### Task 1: Require absolute runtime-root references

**Files:**
- Modify: `test/agents/loader.test.ts`
- Modify: `root/agents/quartermaster/agents/qm-indexer.md`
- Modify: `root/agents/quartermaster/agents/qm-reconciler.md`
- Generate: `src/generated/embedded-root.ts`

- [ ] **Step 1: Write the failing regression test**

Extend `QM self-awareness agents use {{SPROUT_ROOT}} template for resource paths` to include
`qm-indexer` and `qm-reconciler`. For each named agent, assert that its prompt contains
`{{SPROUT_ROOT}}` and does not contain a relative `root/agents/` reference.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test test/agents/loader.test.ts`

Expected: FAIL because `qm-indexer` and `qm-reconciler` still contain relative
`root/agents/**` paths.

- [ ] **Step 3: Apply the minimal prompt fix**

Replace every Sprout-owned `root/agents/**/*.md` reference in those two prompts with
`{{SPROUT_ROOT}}/agents/**/*.md`. Do not change target-project path semantics or filesystem
primitive behavior.

- [ ] **Step 4: Regenerate the embedded root bundle**

Run: `bun run scripts/generate-embedded-root.ts`

Expected: `src/generated/embedded-root.ts` updates with the corrected prompts and bundle hash.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `bun test test/agents/loader.test.ts`

Expected: PASS.

- [ ] **Step 6: Run repository verification**

Run: `bunx biome check test/agents/loader.test.ts root/agents/quartermaster/agents/qm-indexer.md root/agents/quartermaster/agents/qm-reconciler.md src/generated/embedded-root.ts`

Run: `bun run typecheck`

Run: `bun run check:ci`

Expected: all commands pass with no new failures. Do not run the write-enabled `bun run check` or
`bun run precommit` while unrelated working-tree edits are present.

- [ ] **Step 7: Commit only the root-path fix**

Stage the two prompts, regression test, and generated bundle without staging unrelated working-tree edits.

Commit: `fix: resolve Sprout agent paths from runtime root`

### Task 2: Make sprout-mcp structured-only

**Files:**
- Modify: `test/agents/loader.test.ts`
- Modify: `test/agents/workspace-wiring.test.ts`
- Modify: `test/agents/workspace-prompt.test.ts`
- Modify: `root/agents/utility/agents/mcp.md`
- Modify: `src/agents/agent.ts`
- Modify: `src/agents/plan.ts`
- Generate: `src/generated/embedded-root.ts`

- [ ] **Step 1: Write failing MCP contract tests**

Assert that the loaded MCP spec does not request `exec`, retains `read_file`, describes
`sprout-mcp` as a structured tool accepting an `args` string, and does not claim the tool is on
PATH. Update workspace-prompt tests to require structured-primitive wording and reject PATH/exec
claims. Add a workspace-wiring regression that instantiates the real MCP spec with Sprout's real
root directory and an environment recording `addToPath`: capture the LLM request tools and assert
`sprout-mcp` is present with an `args` property of type string, `read_file` is present, `exec` is
absent, and no raw tool directory was added. Create a temporary `mcp.json` containing
`{"mcpServers": {}}`. Have the recording environment inject `SPROUT_SELF_EXECUTABLE` as Bun and
`SPROUT_SELF_ENTRYPOINT` as the repository's `src/host/cli.ts` when it delegates to the real local
execution environment. Have the mock model invoke `sprout-mcp` with
`args: "list-servers --config <temporary-mcp.json>"`; assert the structured primitive succeeds
without YAML-frontmatter errors.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test test/agents/loader.test.ts test/agents/workspace-wiring.test.ts test/agents/workspace-prompt.test.ts`

Expected: FAIL because MCP still exposes `exec`/PATH instructions, shared prompt rendering still
advertises PATH/exec, and agent startup still adds raw tool directories to PATH.

- [ ] **Step 3: Apply the minimal runtime and prompt fix**

Remove `exec` from `root/agents/utility/agents/mcp.md`, retain `read_file`, and rewrite its workflow
to call the `sprout-mcp` tool with CLI-style text in `args`. Remove the two workspace-tool
`addToPath` calls from agent startup. Update `renderWorkspaceTools()` and
`renderWorkspaceEncouragement()` to describe structured tool calls without PATH/exec claims. Do not
change structured tool loading or `SPROUT_TOOL_DIR`.

- [ ] **Step 4: Regenerate the embedded root bundle**

Run: `bun run scripts/generate-embedded-root.ts`

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `bun test test/agents/loader.test.ts test/agents/workspace-wiring.test.ts test/agents/workspace-prompt.test.ts`

Expected: PASS.

- [ ] **Step 6: Verify changed files and repository behavior**

Run: `bunx biome check test/agents/loader.test.ts test/agents/workspace-wiring.test.ts test/agents/workspace-prompt.test.ts root/agents/utility/agents/mcp.md src/agents/agent.ts src/agents/plan.ts src/generated/embedded-root.ts`

Run: `bun run typecheck`

Run: `bun run check:ci`

Expected: all pass without modifying unrelated working-tree files.

- [ ] **Step 7: Commit only the MCP reliability fix**

Commit: `fix: invoke sprout-mcp as a structured tool`
