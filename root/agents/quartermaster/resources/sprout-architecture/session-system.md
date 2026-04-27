# Session System

Sessions are stored per project data directory, not directly in the genome root.
The data directory contains session metadata, event logs, project memory files,
and per-session subprocess logs.

## Storage Layout

Common paths:
- `sessions/{sessionId}.meta.json`
- `logs/{sessionId}.jsonl`
- `logs/{sessionId}/...` for child handle or process logs
- `memory/*.md` for project-memory documents

Source of truth:
- `src/util/project-id.ts`
- `src/host/session-metadata.ts`
- `src/host/logger.ts`

## Metadata

Metadata stores session id, root agent, status, turn/context counts, model
selection, resolved model, timestamps, and cached root memory surfacing data.
If a previous run crashed while status was `running`, resume marks it
`interrupted` before starting new work.

Source of truth:
- `src/host/session-metadata.ts`
- `src/host/session-metadata-updater.ts`
- `test/host/session-metadata.test.ts`

## Event Logs

Agents emit structured events such as session start/end, perceive, recall,
plan start/end, act start/end, verify, warnings, errors, and learn events.
The current event taxonomy lives in source, not this document.

Source of truth:
- `src/kernel/types.ts:EventKind`
- `src/agents/events.ts`
- `src/host/event-bus.ts`

## Replay And Resume

Resume reconstructs message history from the JSONL event log, loads metadata
for model selection and cached memory surface, extracts child handles, and loads
session plus child event logs for the UI.

Source of truth:
- `src/host/resume.ts`
- `src/kernel/event-replay.ts`
- `src/host/cli-resume.ts`
- `src/host/session-state.ts`

## Compaction

There are two compaction concepts:
- Conversation compaction summarizes message history during a live session.
- Memory-log compaction removes archived/superseded long-term memory rows after
  git history contains their audit trail.

Source of truth:
- `src/host/compaction.ts`
- `src/host/session-controller.ts`
- `src/genome/genome.ts:compactMemoryLog()`

## Memory Collapse

After a completed root run, session events can be summarized into a segment and
extracted memories. This uses configured memory summary/extraction models and
records project activity.

Source of truth:
- `src/core/session-collapse.ts`
- `src/genome/segments.ts`
- `src/genome/projects.ts`
- `src/host/session-controller.ts:collapseMemoryAfterRun()`

## Safe Inspection

Session JSONL can contain large prompts, tool calls, and full LLM messages.
Prefer metadata-first filtering and command-runner extraction over loading raw
logs directly into an agent context.
