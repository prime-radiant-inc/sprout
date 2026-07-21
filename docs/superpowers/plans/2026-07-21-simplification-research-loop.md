# Simplification research loop — whole system

**Directive (Jesse, 2026-07-21):** "set up an auto research loop to simplify the entire
system not just your recent changes. make sure that runs for at least four hours."

**Started:** 2026-07-21T15:38:34Z → runs until ≥ 2026-07-21T19:38Z, finishing the cycle in
flight at that point.

## Protocol (per cycle, ~25 min cadence)

1. Take the next subsystem from the rotation below (mark it in-progress).
2. Spawn TWO adversarial simplification reviewers on it (competition rules from /par:
   most legitimate significant findings wins; concrete deletion/merge with evidence and a
   steelman required; hand-waving disqualifies). Scope: that subsystem's src + tests;
   simplifications must preserve behavior/coverage (Jesse's rules: no coverage reduction,
   no mock-testing, smallest changes).
3. Personally verify the top findings against the code.
4. Implement the SAFE, high-value ones: TDD where behavior is touched, full pre-commit
   hook (`PATH="/home/jesse/.bun/bin:$PATH"`), one commit per coherent change.
5. Log findings + actions below. Architectural/risky proposals are RECORDED for Jesse,
   never implemented unilaterally.
6. Reschedule the next wakeup (~1500s); at ≥4h elapsed, finish the current cycle, write
   the summary section, and stop the loop.

## Rotation

- [x] src/store (cycle 1)
- [ ] src/bus (spawner, agent-process, resume, result-gate, types)
- [ ] src/host (cli-*, session-controller, settings, channels)
- [ ] src/kernel (primitives, truncation, capture, redaction, cell-primitive)
- [ ] src/agents (agent.ts — the giant, plan, loader, delegation)
- [ ] src/cell (cell-host, engines, worker, bootstrap)
- [ ] src/learn + src/llm (eval harnesses, adapters, client)
- [ ] src/genome + src/web (memory tools, recall, server)

## Cycle log

### Cycle 1 — src/store (two adversarial reviewers, high convergence)

Pre-loop lever results folded in: lever 1 (description trim) — no steering regression
(huge-log exact); lever 2 (delegation secret guard) — secret-relay 2/2 clean live.

SAFE findings, verified (implementing this cycle → "done", else "queued"):
1. done — slice per-call maxBytes: dead plumbing through 3 layers, only self-test uses it.
2. done — grep per-call deadlineMs: duplicates opBudgetMs; no production writer.
3. done — ContentStore.has(): dead public API (put uses private pathExists).
4. done — ValueMetadata.createdAt optional is a lie: every producer sets it; casts deleted.
5. done — NAME_MAX_LENGTH defined twice (value.ts private + store.ts copy): drift hazard.
6. done — publishSeqs map duplicates publishRecords tail; derived instead.
7. done — deliverManifest kept THREE parallel arrays in lockstep; grants+aliases are pure
   projections of delivered — collapsed to one array + a map.
8. queued — inline codec (store.ts) duplicates wire codec (store-worker.ts): move to
   value.ts, one type→utf8/base64 rule (import churn across 5 files).
9. queued — appendAndCharge helper: 7 call sites pair journal.append+chargeJournalBytes
   by convention; bind hand-rolls the byte formula.
10. queued — journal.replay badLine state machine reduces to "tolerate parse failure iff
    final complete line".
11. queued — cacheBody already-cached guard is unreachable under the op mutex and its
    comment asserts a race the mutex prevents.

RISKY — recorded for Jesse, not touched:
- grep signal option: spec-NAMED ("chunk-at-a-time with an abort signal") but unwireable
  over the worker protocol, and the spec's own review notes concede JS regex is
  uninterruptible (timeout-or-restart contract). Wire-it-or-cut-it call.
- reservedNames store option: carried but only ever the empty default; the kernel check
  covers primitives, but CELL binds (cell-host.ts:400,525,701) reach the store WITHOUT
  any reserved-name check — a real spec §1 Naming #4 enforcement gap. Wiring the store
  option would close it. Flagged as a likely bug, needs a decision.
- PublishRecord.ulids array with only single-element producers: scalarizing changes the
  durable journal format — not worth it.

## Constraints carried from the session

- The test-perf subagent works in a separate worktree on suite runtime — do not touch
  test sharding/infra here to avoid collisions; code simplifications only.
- Levers 1+2 (description trim, delegation secret guard) landed earlier today — their
  files are fair game for review but not re-litigation.
- QuickJS cutover remains parked (Jesse's call).
