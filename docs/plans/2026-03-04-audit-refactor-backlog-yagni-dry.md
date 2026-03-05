# Audit Refactor Backlog (YAGNI + DRY)

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

Date: 2026-03-04
Owner: Bot + Jesse
Status: Active

## Scope Guardrails (Explicit Non-Goals)

These were proposed in audits and are intentionally excluded for now:

1. No runtime caching layer for agent startup/bootstrap context.
2. No worker pool replacing process-per-delegation.
3. No static-only delegation model (dynamic tree discovery stays).
4. No transactional batching redesign in genome persistence.

Rationale:
- YAGNI: none are required to fix current correctness/maintainability pain.
- Risk control: each introduces high behavioral and operational complexity.
- We prioritize smaller, test-locked structural improvements first.

## Current Finding Status (After Sprint Work)

Done:
1. Web command boundary hardening for non-localhost binds (token + strict origin checks).
2. Replay parsing deduplicated in shared `src/kernel/event-replay.ts`.
3. Logger write failures observable.
4. Major `runCli` decomposition completed.
5. Easy-fix reliability and speed findings from audits.
6. Agent run-loop decomposition (Track A).
7. `SessionController` decomposition (Track B).
8. Learning pipeline contract unification (Track C).
9. Shared WebSocket test fixtures (D1).
10. Delegation observability utility + deterministic tests (Track E).
11. Shared agent test fixtures/builders and duplicate setup reduction (D2).
12. Oversized spec split by behavior area (D3).

In progress:
1. None.

Not started:
1. Event payload/snapshot scaling work.

## Execution Backlog (Small Safe Chunks)

## Track A: Agent Run-Loop Decomposition

### A1 (Completed)
- Extract run-loop outcome and compaction decision seams.
- Files:
  - `src/agents/run-loop-outcome.ts`
  - `src/agents/run-loop-compaction.ts`
  - `src/agents/agent.ts`
  - `test/agents/run-loop-outcome.test.ts`
  - `test/agents/run-loop-compaction.test.ts`

### A2 (Completed)
- Extract planning phase orchestration from `runLoop`:
  - request creation
  - llm_start/llm_end emission
  - assistant message/history write
  - plan_end emission
- Target file: `src/agents/run-loop-planning.ts`.
- Implemented in:
  - `src/agents/run-loop-planning.ts`
  - `src/agents/agent.ts`
  - `test/agents/run-loop-planning.test.ts`
- Keep existing events and payload fields unchanged.

### A3 (Completed)
- Extract session finalization:
  - retry-signal accounting
  - session_end payload emission
  - return-shape assembly
- Target file: `src/agents/run-loop-finalize.ts`.
- Implemented in:
  - `src/agents/run-loop-finalize.ts`
  - `src/agents/agent.ts`
  - `test/agents/run-loop-finalize.test.ts`

Acceptance for A2/A3:
1. `test/agents/agent.test.ts` unchanged and green.
2. New unit tests for extracted functions.
3. No event contract changes.

## Track B: SessionController Decomposition

### B1 (Completed)
- Extract command dispatch map from `SessionController`:
  - `submit_goal`, `steer`, `interrupt`, `quit`, `clear`, `compact`, `switch_model`.
- Target: `src/host/session-controller-commands.ts`.
- Implemented in:
  - `src/host/session-controller-commands.ts`
  - `src/host/session-controller.ts`
  - `test/host/session-controller-commands.test.ts`

### B2 (Completed)
- Extract history/session state transitions:
  - append/replay/clear/history shadow updates
  - hasRun/sessionId transitions.
- Target: `src/host/session-state.ts`.
- Implemented in:
  - `src/host/session-state.ts`
  - `src/host/session-controller.ts`
  - `test/host/session-state.test.ts`

### B3 (Completed)
- Extract metadata side effects:
  - running/idle/interrupted persistence
  - turn/context updates.
- Target: `src/host/session-metadata-updater.ts`.
- Implemented in:
  - `src/host/session-metadata-updater.ts`
  - `src/host/session-controller.ts`
  - `test/host/session-metadata-updater.test.ts`

Acceptance for B1-B3:
1. `test/host/session-controller.test.ts` green without behavior edits.
2. Maintain current public constructor and command semantics.

## Track C: Learning Contract Unification

### C1 (Completed)
- Define one canonical bus message contract for learning requests.
- Add type + parser tests for this contract.
- Implemented in:
  - `src/bus/learn-contract.ts`
  - `test/bus/learn-contract.test.ts`

### C2 (Completed)
- Make `BusLearnForwarder` and `GenomeMutationService` use the same contract path.
- Add integration test for producer-to-consumer compatibility.
- Implemented in:
  - `src/bus/learn-forwarder.ts`
  - `src/bus/genome-service.ts`
  - `test/bus/learn-forwarder.test.ts`
  - `test/bus/genome-service.test.ts`

Acceptance for C1/C2:
1. No ambiguous split between `learn_signal` and mutation request shapes.
2. Existing learn integration tests remain green.

## Track D: Test DRY / Maintainability

### D1 (Completed)
- Add shared websocket test fixture module.
- Refactor `test/web/server.test.ts` and `test/web/e2e.test.ts` to consume it.
- Implemented in:
  - `test/web/fixtures.ts`
  - `test/web/server.test.ts`
  - `test/web/e2e.test.ts`

### D2 (Completed)
- Add shared agent test fixtures/builders.
- Reduce duplication in `test/agents/agent.test.ts` and related files.
- Implemented in:
  - `test/agents/fixtures.ts`
  - `test/agents/agent.test.ts`
  - `test/agents/llm-events.test.ts`

### D3 (Completed)
- Split oversized spec files by behavior area where safe.
- Implemented in:
  - `test/agents/agent-construction.test.ts`
  - `test/agents/agent.test.ts`

Acceptance for D1-D3:
1. No assertion coverage loss.
2. Full suite remains stable.

## Track E: Delegation Observability (Without Removing Dynamic Discovery)

### E1 (Completed)
- Add introspection utility that explains delegatable agents and source:
  - tree child
  - explicit ref
  - resolved path fallback.
- Target: `src/agents/delegation-inspect.ts`.
- Implemented in:
  - `src/agents/delegation-inspect.ts`

### E2 (Completed)
- Add tests that lock deterministic output for these explanations.
- Implemented in:
  - `test/agents/delegation-inspect.test.ts`

Acceptance for E1/E2:
1. No change to actual delegation behavior.
2. Better debuggability of "why this agent can delegate there."

## Verification Gate Per Chunk

Run after each chunk:
1. `bun test <targeted files>`
2. `bun run typecheck`
3. `bun run lint`

Run periodically:
1. `bun test`

## Notes

- This plan intentionally avoids speculative architecture shifts.
- Every chunk should preserve runtime behavior and reduce local complexity.
