# Sprout Root Path Resolution Design

## Problem

Quartermaster self-inspection agents refer to `root/agents/**` with relative paths.
Filesystem primitives resolve relative paths against the target project working directory, so a
Sprout session targeting FMPL probes `fmpl/root/agents/**` instead of Sprout's runtime root.

## Design

- Use `{{SPROUT_ROOT}}/agents/**` for Sprout-owned agent paths in `qm-indexer` and
  `qm-reconciler`.
- Keep target-project paths relative to the session working directory.
- Extend prompt regression coverage so every quartermaster self-inspection agent uses the
  runtime-root template and does not advertise relative `root/agents/**` paths.
- Regenerate the embedded-root bundle so compiled installations receive the corrected prompts.

## Load-Bearing MCP Tool

The MCP agent currently exposes both `exec` and the structured `sprout-mcp` workspace tool, while
its prompt directs the model to execute `sprout-mcp` as a PATH command. Agent startup adds raw
workspace-tool source directories to PATH, so Bash interprets YAML frontmatter as commands.

- Remove `exec` from the MCP agent and instruct it to call the structured `sprout-mcp` tool with an
  `args` string.
- Stop adding raw workspace-tool directories to agent PATH. Workspace tools remain registered as
  structured primitives and receive `SPROUT_TOOL_DIR` when executed.
- Update shared workspace-tool prompt rendering so it describes structured primitive calls and no
  longer claims tools are available through PATH or `exec`.
- Retain `read_file` for MCP configuration inspection.
- Parse each shell-style workspace tool's `args` string into argv using whitespace, quoting, and
  backslash escaping only. Shell operators have no special meaning; quote every parsed argv element
  before constructing the interpreter command and reject unterminated quoting before invocation.
- Verify the real MCP agent runtime exposes `sprout-mcp` with its string `args` contract but not
  `exec`, and that agent startup does not publish metadata-bearing tool directories through PATH.

## Verification

- First add a regression test that fails against the current relative paths.
- Add failing regressions for MCP tool selection and raw PATH exposure.
- Update the prompts and agent runtime, then regenerate embedded root.
- Run the focused loader tests, typecheck, formatting/lint checks, and pre-commit suite.
