# LLM Replay Logging And Workshop Design

**Date:** 2026-03-15

## Goal

Add exact, versioned replay logging for every Sprout planning turn and a tiny workshop harness that can replay one captured turn for prompt iteration.

The immediate goal is to debug and improve delegated-agent prompting without having to reconstruct requests from indirect logs after a bad field run. When a subagent behaves badly in a real session, we should already have the exact canonical request and response that Sprout sent and received at the LLM boundary.

This is not a general prompt lab and not a provider-wire debug system. It is a stable Sprout-level replay artifact plus a minimal CLI for inspecting and replaying one captured turn.

## Problem

Sprout's current logs are rich enough to explain what happened, but not rich enough to replay the exact planning turn honestly.

Today we can usually recover:

- which agent ran
- the delegated goal
- the model/provider
- token counts
- the assistant message and tool calls

But we do not persist the exact normalized request that was sent to the model:

- the built system prompt after preambles and agent context
- the full message history for that turn
- the exact tool definitions available to that agent

That means prompt debugging after a real run requires partial reconstruction from current code and current prompts. That is close enough for some analysis, but it is the wrong foundation for reliable prompt workshoping.

## Product Requirements

Sprout should capture, by default, an exact replay artifact for every planning turn.

The replay artifact must:

- be written automatically for normal runs
- be versioned
- reflect the canonical Sprout request/response boundary, not provider-native HTTP payloads
- be easy to locate from existing session logs
- be easy for a workshop harness to consume

The workshop harness should:

- start from an existing Sprout-generated log location
- list available replay turns
- show a specific recorded turn
- replay a specific recorded turn live with optional prompt overrides

This first pass is intentionally single-turn only. Full conversation replay is out of scope.

## Canonical Boundary

The replay log should store the exact normalized request and response as Sprout sees them immediately around planning execution.

That means:

- request:
  - `system_prompt`
  - `messages`
  - `tools`
  - `model`
  - `provider`
- response:
  - normalized assistant message
  - usage
  - finish reason

This should not store provider-native wire payloads or raw HTTP responses. Those are a lower-level transport concern and a worse stability boundary for workshop tooling.

The stable contract here is the request object built by Sprout's planner and the normalized response object consumed by Sprout's agent loop.

## Replay Log Format

Replay capture should be append-only JSONL.

Each agent session log directory should gain a sibling file:

- `replay.log.jsonl`

This should live alongside the existing `session.log.jsonl` for that agent session so that existing artifact collection naturally picks it up.

Each line in `replay.log.jsonl` should represent one planning turn and include:

- `schema_version`
- `timestamp`
- `session_id`
- `agent_id`
- `depth`
- `turn`
- `request`
- `response`

Recommended request fields:

- `system_prompt`
- `messages`
- `tools`
- `model`
- `provider`

Recommended response fields:

- `message`
- `usage`
- `finish_reason`

Recommended metadata fields:

- `work_dir`
- `agent_name` when cheaply available

The schema should be deliberately versioned so the workshop harness can reject unsupported versions cleanly.

## Logging Behavior

Replay logging should default to on for now.

That is the right default because current Sprout usage is still development and experimentation, and replay artifacts are valuable for investigating field behavior that would otherwise be difficult to reproduce.

Later, production-facing configurations may disable this by default. That future switch is not part of this project. This project should establish the artifact and the harness first.

Replay logging should be independent of ATIF logging. Both should coexist:

- ATIF remains the session/event artifact for Harbor and evaluation systems.
- replay JSONL becomes the exact prompt-workshop artifact.

## Workshop Harness

Add a small CLI that consumes replay JSONL directly.

The first version should support three operations:

- `list`
  - enumerate recorded turns from a replay log
  - show turn number, model/provider, finish reason, and token counts
- `show`
  - print one recorded turn's request/response
- `replay`
  - rerun one recorded turn live against the model using the captured request
  - optionally apply prompt overrides

The replay harness should accept input by:

- explicit path to `replay.log.jsonl`
- explicit agent log directory containing `replay.log.jsonl`

Session-id-based lookup can come later if it is cheap. The important part is that the harness starts from existing Sprout output, not from a separate export step.

## Replay Overrides

The workshop harness should allow small targeted changes so we can test prompt edits without rebuilding full sessions.

The initial override surface should stay small:

- prepend text to the system prompt
- append text to the system prompt
- override model

This is enough to test the kind of improvements we care about right now:

- delegation/reporting guidance
- concise upward-report rules
- leaf-agent behavioral shaping

The harness does not need to support arbitrary message rewriting or tool-schema mutation in the first pass.

## Scope Limits

This project does not build:

- full multi-turn replay
- fake tool execution
- provider-native transport capture
- a browser UI for prompt workshoping
- generalized prompt experimentation infrastructure

It also does not replace existing session logs or ATIF.

The correct first step is a small exact replay artifact plus a tiny single-turn replay CLI.

## Error Handling

The replay logger must never break the main run if capture fails. Logging failures should degrade the same way other session logging does: record what we can, warn, and continue.

The workshop harness should fail clearly for:

- missing replay log
- malformed JSONL
- unsupported `schema_version`
- missing required request/response fields
- unknown model/provider when replaying live

If a replay record is structurally valid but cannot be replayed because the referenced provider or model is unavailable in the current environment, the harness should say so explicitly instead of attempting silent substitution.

## Testing

Tests should cover:

- replay records are written for planning turns
- replay records contain the exact normalized request/response shape used by the planner
- replay JSONL is written in the expected agent log location
- `list` reads and summarizes replay turns
- `show` extracts a specific turn
- `replay` can load a recorded turn and build the live request from it
- unsupported schema versions fail clearly

The first replay tests should be isolated and deterministic. They do not need a real model call unless that is already easy to do in the harness test shape.

## Success Criteria

This work is successful when:

- a real Sprout subagent run produces replay JSONL automatically
- a developer can point the workshop harness at that log and inspect one leaf turn directly
- a developer can replay that exact turn with a small system-prompt override
- no reconstruction from indirect logs is required for normal prompt workshoping
