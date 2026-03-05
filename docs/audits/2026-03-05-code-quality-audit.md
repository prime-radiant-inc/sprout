<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Audits Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Refactor Backlog Plan](../plans/2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Plans Index](../plans/README.md)
<!-- DOCS_NAV:END -->

## 1) Overall grade + confidence
**Grade: C+**  
**Confidence: Medium-High** (lint/typecheck/architecture lanes ran cleanly; full test/build verification was constrained by read-only FS behavior, but core findings are code-evidenced).

## 2) Health snapshot (lint/typecheck/test lanes/build lanes you ran)
- `bun run lint` -> pass, `Checked 259 files`, `real 0.11s`
- `bun run typecheck` -> pass, `real 1.89s`
- `bun run check:architecture` -> pass, boundary script + 2 architecture tests, `real 0.04s`
- `bun test test/smoke.test.ts` -> pass, `1/1`
- `bun run test:unit:parallel` -> fail immediately (`mktemp/mkdtemp EPERM` in sandbox)
- `bun run test:unit` -> helper script failed, then Bun ran broad suite (`Ran 2407 tests across 129 files`; many EPERM-derived failures)
- `bun run test:integration` -> helper script failed, then Bun ran broad suite (`Ran 2407 tests across 129 files`; many EPERM-derived failures)
- `bun run web:build` -> fail (`vite` temp-file write EPERM in read-only sandbox)

## 3) Findings ordered by severity with file:line evidence
- **High: test lane scoping is unsafe; helper-script failure can silently run the wrong suite (hidden cost + false signal).**  
  Evidence: [`package.json:19`]( /Users/jesse/git/prime-radiant-inc/sprout/package.json:19 ), [`package.json:21`]( /Users/jesse/git/prime-radiant-inc/sprout/package.json:21 ), [`scripts/test-unit-files.sh:4`]( /Users/jesse/git/prime-radiant-inc/sprout/scripts/test-unit-files.sh:4 ), [`scripts/test-integration-files.sh:4`]( /Users/jesse/git/prime-radiant-inc/sprout/scripts/test-integration-files.sh:4 ).  
  Root cause: `bun test $(...)` command substitution drops arguments when helper fails; Bun then runs default/global scope.

- **High: `BusClient` leaves stale local subscription state when subscribe-ack fails, breaking retry semantics.**  
  Evidence: callback/placeholder are added before ack at [`src/bus/client.ts:98`]( /Users/jesse/git/prime-radiant-inc/sprout/src/bus/client.ts:98 ) and [`src/bus/client.ts:141`]( /Users/jesse/git/prime-radiant-inc/sprout/src/bus/client.ts:141 ); ack timeout rejects at [`src/bus/client.ts:231`]( /Users/jesse/git/prime-radiant-inc/sprout/src/bus/client.ts:231 ) with no rollback of `callbacks`.  
  Coverage gap: timeout is tested, but retry-after-timeout behavior is not asserted ([`test/bus/client.test.ts:185`]( /Users/jesse/git/prime-radiant-inc/sprout/test/bus/client.test.ts:185 )).

- **Medium-High: pending evaluations can accumulate indefinitely for non-agent mutations.**  
  Evidence: default target agent is `"learn"` for `create_memory`/`create_routing_rule` at [`src/learn/learn-process.ts:500`]( /Users/jesse/git/prime-radiant-inc/sprout/src/learn/learn-process.ts:500 ) and queued at [`src/learn/learn-process.ts:514`]( /Users/jesse/git/prime-radiant-inc/sprout/src/learn/learn-process.ts:514 ); evaluation requires >=5 actions for that agent at [`src/learn/learn-process.ts:158`]( /Users/jesse/git/prime-radiant-inc/sprout/src/learn/learn-process.ts:158 ). Actions are recorded for runtime agent IDs, not `"learn"` ([`src/agents/agent.ts:603`]( /Users/jesse/git/prime-radiant-inc/sprout/src/agents/agent.ts:603 )).  
  Impact: stale `pending-evaluations` entries never clear.

- **Medium: metrics reads mask non-ENOENT read failures as “0 data”, biasing learning decisions.**  
  Evidence: broad catch-and-return-0 in [`src/learn/metrics-store.ts:104`]( /Users/jesse/git/prime-radiant-inc/sprout/src/learn/metrics-store.ts:104 ) and [`src/learn/metrics-store.ts:125`]( /Users/jesse/git/prime-radiant-inc/sprout/src/learn/metrics-store.ts:125 ).  
  Root cause: read errors (permissions/IO) are treated as empty metrics instead of surfaced failures.

- **Medium: test teardown robustness is weak; setup failures produce secondary noise and hide first failure.**  
  Evidence: unguarded cleanup in [`test/learn/agent-learn-wiring.test.ts:40`]( /Users/jesse/git/prime-radiant-inc/sprout/test/learn/agent-learn-wiring.test.ts:40 ) and [`test/util/project-id.test.ts:43`]( /Users/jesse/git/prime-radiant-inc/sprout/test/util/project-id.test.ts:43 ) after `mkdtemp` in before hooks.  
  Observed behavior: EPERM in setup followed by `TypeError: path must be a string` in teardown.

- **Medium: flaky/slow test patterns from fixed sleeps and polling loops.**  
  Evidence: timing-coupled sleeps/polls in [`test/learn/learn-process.test.ts:55`]( /Users/jesse/git/prime-radiant-inc/sprout/test/learn/learn-process.test.ts:55 ), [`test/learn/learn-process.test.ts:854`]( /Users/jesse/git/prime-radiant-inc/sprout/test/learn/learn-process.test.ts:854 ), [`test/learn/learn-process.test.ts:1011`]( /Users/jesse/git/prime-radiant-inc/sprout/test/learn/learn-process.test.ts:1011 ), plus bus delay-based assertions in [`test/bus/client.test.ts:6`]( /Users/jesse/git/prime-radiant-inc/sprout/test/bus/client.test.ts:6 ) and [`test/bus/server.test.ts:60`]( /Users/jesse/git/prime-radiant-inc/sprout/test/bus/server.test.ts:60 ).  
  Hidden cost: CI jitter can flip outcomes and inflate runtime.

## 4) Easy high-leverage fixes (small safe)
- Replace `bun test $(bash ... )` with explicit file-list handling that fails closed when helper exits non-zero.
- In `BusClient.subscribe`/`waitForMessage`, wrap `awaitAck` in `try/catch` and remove callback/placeholder on failure.
- Guard teardown `rm(tempDir, ...)` with `if (tempDir)` in suites using `mkdtemp` in setup.
- Add cleanup to `should-learn` tests (`afterEach` removes temp dir).
- Narrow `MetricsStore` catches to `ENOENT` only; surface other read errors.

## 5) Larger refactors worth doing next (minimal/YAGNI)
- Make learn-evaluation tracking mutation-aware: only queue evaluable mutations (`update_agent`/`create_agent`) or map non-agent mutations to a real target metric key.
- Introduce deterministic test timing helpers (event-driven waits or fake clock) for learn/bus tests to eliminate fixed `sleep` delays.
- Consolidate test selection into a single authoritative manifest/generated list so lane scope cannot silently drift.

## 6) Verification gaps
- Could not run write-requiring lanes in this sandbox (`mktemp`, `mkdtemp`, Vite temp writes), so full green/red status of unit/integration/build in normal dev/CI environment is unverified here.
- Could not perform repeated-run flake detection (no multi-run statistical pass).
- Live integration behavior (`VCR_MODE=off` provider calls) was not exercised.