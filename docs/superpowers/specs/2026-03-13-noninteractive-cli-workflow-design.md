# Non-Interactive CLI Workflow Design

**Date:** 2026-03-13

## Goal

Add a fully non-interactive Sprout workflow that can start or continue a session from the command line with an explicit prompt, run to completion, and print the final response without starting the TUI or web UI.

This work also cleans up the current CLI architecture. The current `cli.ts` mixes parsing, command dispatch, interactive concerns, and the old env-based one-shot runner. That split is already wrong for settings-backed providers and resumed sessions.

## User-Facing CLI Contract

Sprout will support these command forms:

- `sprout`
  - Start interactive mode.
- `sprout -p "do the thing"`
- `sprout --prompt "do the thing"`
  - Start a new non-interactive run.
- `sprout --resume`
  - Open the session picker.
- `sprout --resume <session-id>`
  - Resume that session interactively.
- `sprout --resume <session-id> -p "continue the work"`
- `sprout --resume <session-id> --prompt "continue the work"`
  - Continue that session non-interactively.

Removed behavior:

- Bare positional goals like `sprout "do the thing"` are invalid.
- `--resume-last` is removed.

Headless runs print:

- final assistant response to `stdout`
- operational lines such as `Session: <id>` and fatal errors to `stderr`

Headless runs do not start the TUI or web server and do not stream normal event output by default.

## Architecture

The CLI should be split into three responsibilities:

- parsing argv into a typed command model
- dispatching typed commands to the correct runner
- running a session in either interactive or headless mode

The new parser should be a small dedicated internal module, not a new third-party dependency. Sprout's grammar is narrow and opinionated, and a small typed parser is simpler and easier to test than introducing Commander or another generic command framework.

The most important architectural rule is that interactive and headless session execution must share the same runtime bootstrap. There should be one session runtime path that:

- loads settings and secrets
- builds the provider registry and model catalog
- wires the event bus, logger, spawner, and controller
- optionally loads prior session state for resume

The current env-based CLI one-shot runtime should be removed. That execution path is architecturally wrong because it bypasses the settings-backed runtime used by interactive mode and resume.

`Client.fromEnv()` may remain as a lower-level constructor if it still has legitimate non-CLI uses. This project removes the split CLI execution path, not the constructor by itself.

## Internal Module Shape

The refactor should move toward this structure:

- `src/host/cli.ts`
  - thin entrypoint only
- `src/host/cli-parse.ts`
  - typed parser and usage text
- `src/host/cli-run.ts`
  - top-level command execution
- `src/host/cli-headless.ts`
  - non-interactive session runner
- `src/host/cli-resume.ts`
  - session-state loading for explicit resume ids only

The current `cli.ts` helpers that genuinely belong to interactive operation, such as slash-command handling and terminal setup, may stay where they are if they are not part of the parsing and dispatch tangles being fixed here. This project is a cleanup, not a wholesale CLI rewrite.

## Session Runtime Contract

Headless callers need a structured result from the session runtime. The controller layer should expose a run method that returns:

- `sessionId`
- `output`
- `success`
- `stumbles`
- `turns`
- `timedOut`

Headless mode will use that result to:

- print `output` to `stdout`
- choose process exit behavior
- print the session id to `stderr`

Interactive mode does not need to consume that result, but it should share the same underlying run machinery.

## Parsing Rules

The parser should be explicit and deterministic:

- `-p` and `--prompt` are synonyms
- `--prompt` requires a value
- `--resume` accepts an optional session id
- `--resume` with no id means picker
- `--resume <id>` with no prompt means interactive resume
- `--resume <id>` with a prompt means headless continuation
- `--help` always wins
- unknown flags return help
- positional arguments are invalid except where already required by genome subcommands

Web and logging flags stay part of the interactive command surface. They are not meaningful in headless mode and should not be carried into the new headless commands.

## Error Handling

Headless mode should fail clearly:

- missing prompt value -> help
- `--resume <id>` with no matching session -> explicit error on `stderr`, non-zero exit
- invalid prompt command combinations -> help
- runtime failure before final output -> error on `stderr`, non-zero exit
- completed run with `success: false` -> print final output if present, exit non-zero

The parser should reject ambiguous or partial commands rather than guessing.

## Cleanup Scope

This project should remove vestigial CLI behavior instead of layering over it:

- delete the old env-based `cli-oneshot` execution path
- remove `resume-last`
- remove bare-goal parsing
- remove special parser pre-scans that only exist to support those legacy cases

The result should be fewer command kinds, fewer parser exceptions, and one real session execution path.

## Testing

Tests should cover:

- parser behavior for all supported command forms
- parser rejection of bare positional goals
- parser rejection of `resume-last`
- headless new-session execution
- headless resumed-session execution
- interactive resume still using prior session state
- controller structured result contract
- headless output routing to `stdout` and `stderr`
- shared runtime behavior using settings-backed providers rather than env-only CLI behavior

The implementation should prefer targeted unit tests for the parser and headless runner, plus a few integration-level CLI tests for the new command flow.
