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

- [ ] src/store (SapStore, journal, CAS, access, worker)
- [ ] src/bus (spawner, agent-process, resume, result-gate, types)
- [ ] src/host (cli-*, session-controller, settings, channels)
- [ ] src/kernel (primitives, truncation, capture, redaction, cell-primitive)
- [ ] src/agents (agent.ts — the giant, plan, loader, delegation)
- [ ] src/cell (cell-host, engines, worker, bootstrap)
- [ ] src/learn + src/llm (eval harnesses, adapters, client)
- [ ] src/genome + src/web (memory tools, recall, server)

## Cycle log

(appended per cycle)

## Constraints carried from the session

- The test-perf subagent works in a separate worktree on suite runtime — do not touch
  test sharding/infra here to avoid collisions; code simplifications only.
- Levers 1+2 (description trim, delegation secret guard) landed earlier today — their
  files are fair game for review but not re-litigation.
- QuickJS cutover remains parked (Jesse's call).
