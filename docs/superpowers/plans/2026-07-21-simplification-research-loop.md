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
4b. DECOMPOSITION mandate (Jesse, 2026-07-21): each cycle also targets maintainability —
   files over ~500 lines get their natural seams identified (cohesive units that move to
   their own modules with imports fixed up — mechanical moves, never rewrites), and
   functions over ~80 lines get cohesive blocks extracted into named helpers. Implement
   the top 1-2 extractions per cycle (behavior-identical, suite green); record the rest.
   Size inventory at adoption: agent.ts 3693, genome.ts 1890, spawner.ts 1512,
   control-plane.ts 1359, primitives.ts 1046, session-controller.ts 1029, store.ts 989,
   learn-process.ts 875, agent-process.ts 866, cell-host.ts 850, memory-index.ts 831.
5. Log findings + actions below. Architectural/risky proposals are RECORDED for Jesse,
   never implemented unilaterally.
6. Reschedule the next wakeup (~1500s); at ≥4h elapsed, finish the current cycle, write
   the summary section, and stop the loop.

## Rotation

- [x] src/store (cycle 1)
- [x] src/bus (cycle 2)
- [x] src/host (cycle 3)
- [x] src/kernel (cycle 4)
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

### Cycle 2 — src/bus (two reviewers, heavy convergence + decomposition map)

SAFE, implementing now (batch A/B) or queued:
1. done — parseTopic + 3 types + commandsTopic dead (only self-tests); topics.ts → builders only.
2. done — every child event published TWICE; per-handle agentEvents topic has zero readers
   (the "spawner result tracking" comment is wrong — results ride agentResult). Halves
   event traffic; 2 tests repointed to the session topic.
3. done — learn-forwarder startBackground/stopBackground dead (LearnSink is push+recordAction).
4. done — tautological types tests (typed literals asserting their own fields).
5. done — server WSData.id assigned, never read.
6. done — minors: agentIdOf dead fallback; idleLoop dead signal guards; redundant settle
   status args; no-op resolve cast.
7. done — waitForBlockingSpawn = waitAgent(handleId, undefined, {untimed:true}); delegated.
8. queued — clearHandles/shutdown teardown dup → stopAllHandles(reason).
9. queued — spawnAgent/respawn launch-sequence dup → launchHandleProcess (protects the
   token-inheritance invariant on BOTH paths).
10. queued — shared ackAgentMessage module fn; handle-log-dir expression ×5 → helper.
11. queued — BusClient.waitForMessage rebuilt on subscribe (placeholder hack dies).
12. queued — composeAbortSignal → AbortSignal.any (agent.ts already relies on it).
13. queued — FeatherweightExecInput: 6 fields plumbed, never read.
14. queued — AgentHandle literal built 3x → buildHandle helper.

DECOMPOSITION (mandate 4b) — seams verified by both reviewers:
- done (cycle 2 target 1) — createAgentProcessClient + deps → src/bus/agent-process-client.ts
  (~130 lines, zero bus coupling; agent-process.ts sheds a third of its imports).
- queued (target 2) — featherweight unit → src/bus/featherweight.ts (~200 lines;
  logEvent/publishSessionEvent/exec types move; deps context {sessionId, bus, storeAccess}).
- queued — message-loop free fns → module (~220); lifecycle utils → module; runAgentProcess
  355-line body → named blocks (loadAgentSpecOrPublishError, buildAgentFromStart);
  messageAgent 190-line branch split; constructor options object (RISKY churn).

### Cycle 3 — src/host (both reviewers; BROKEN WINDOW found and fixed)

HEADLINE: scripts/check-host-session-controller-boundaries.sh (check:ci, not the commit
hook) was RED at HEAD since the Phase-5 mutation-gate commit. Fixed by the factory
extraction both reviewers independently mapped: session-agent-factory.ts (311 lines) out
of session-controller.ts (1029→740). Guardrail + check:architecture green.

Done: ObserverDispatcher shim + METACOGNITIVE_OBSERVER + config option (spec-confirmed
superseded; test PORTED to ObserverRegistry); dispatchSessionCommand (tests rewritten to
createSessionCommandHandlers); handleSigint; resolveResumeSelection;
formatSessionSelectionSnapshot; relationshipModel dead field (preflight call kept);
shouldCollapseRun unused param.

Queued: control-plane helpers C1 (~144) + wire-types C2 (~156 — also fixes kernel→host
implementation import inversion at kernel/types.ts:648); credential service C3 (RISKY);
terminal-setup out of cli-shared E1 (~193); codex-oauth ops out of cli-bootstrap E2
(~112); web-server construction dedup; control-plane internal dedups (4x failure
response, 8x findProvider, secret-store catch x2); compaction duplicate tests;
bootstrap deps-defaults extraction; EventBus test-only surface.

RISKY for Jesse: deprecated submitGoal generator + session.ts wholesale delete (public
entry API; e2e VCR harness rewrite); auth-channel push/onPush speculative channel (spec
says manifests are pulled — hold pending sap phases); pricing fetch blocks TUI startup
~5s offline (defer to web start?); bootstrapSessionRuntime all-unknown return forces
downstream cast shims.

RISKY/BUGS — recorded for Jesse:
- LIKELY BUG: featherweight silently DROPS env/hints/payload (spawnAgent returns into
  spawnFeatherweight before registerEnvGrants; runFeatherweight passes the bare goal) —
  spec §5 equivalence + §6 no-silent-stripping violated. Also featherweight/model
  spawnInfo fields on registerCompletedHandle are read but never written by production
  resume (cold-resumed featherweights respawn as subprocesses; model override lost).
  Delete-vs-complete needs a call.
- Bus SteerMessage has ZERO producers (host steer is in-process); spec §1 says the bus
  "keeps steer" — code or spec must change.
- Micro race: continue arriving between result publish and idleLoop subscribe is dropped
  (window = a few microtasks; parent only continues after the result — noted, not urgent).

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

### Cycle 4 — src/kernel (both reviewers; REAL BUG found and fixed first)

HEADLINE (reviewer B, proof test adopted): every primitive-registry rebuild —
start of every root run, every continue, every steering drain — silently
DISARMED capture-all: rebuildPrimitiveRegistryForCurrentAgent never re-applied
the withCapture wraps nor setCaptureStore, so genome-carrying agents ran with
the spec's whole capture path off. Root cause was registry assembly duplicated
between the constructor and the rebuild; fixed with one shared
armCaptureOnRegistry() + the reviewer's proof test as a regression pin.

Also fixed (C1, TDD): a stderr-companion bind failure voided the whole capture
with a false "content not captured" banner; the companion now fails alone.

Done (SAFE batch): unexported the five vestigial "shared with the capture
wrapper" symbols + parseGrepOutput + buildWorkspacePrimitives and fixed the
lying comments (sharing died in 47f7f32; captureSource is the mechanism now);
dead sk-ant regex alternation (provably subsumed, byte-identical); typed
PreviewBudgets rows required → deleted the four scattered hardcoded fallback
copies (result-gate, agent, cell-host, primitives); captureSource STRIPPED at
the gate (raw unredacted content no longer rides out on results — TDD);
saveAgent dynamic yaml/types imports → static + 5× repeated string → local;
buildPrimitives unused env param; truncateToolOutputDetailed().text →
truncateToolOutput.

DECOMPOSITION (mandate 4b) — primitives.ts 1046 → 599:
- done — apply-patch.ts (219): v4a parser/applier, self-contained; duplicated
  workdir-resolution ternary → one helper.
- done — workspace-primitives.ts (239): GenomeContext + save_* builders +
  memory tools behind buildGenomePrimitives(ctx, evalMode); primitives.ts
  sheds all ../genome/ imports.
- queued — seam 3: registry gate closure (~107 lines) → named function/module;
  types.ts memory-family split; exec_command (~112) and saveAgent.execute
  (~105) helper extractions.

Queued (SAFE, smaller): truncateOutput/truncateLines/PassResult test-only
wrappers (nominal library API — Jesse's call); TruncationOverrides machinery
(no production caller); FakeStore dup across capture/registry-gate tests +
the duplicated value_* bypass test; SUMMARY_BUDGET_CHARS fold into the
delegate row (spec-named — Jesse's call); setCaptureStore optionality.

RISKY — recorded for Jesse, not touched:
- ExecOptions.env_vars + file_exists: production-dead exec surface (env
  injection write-path into child shells with zero callers). A says strip,
  B says report — needs a call.
- edit_file/apply_patch resolve paths WITHOUT ~-expansion but write through
  env.write_file WHICH EXPANDS ~ — a literal "~" dir under the workdir reads
  one file and writes another. Aligning on env.resolvePath changes behavior.
- value_get passes its 50k-char budget as maxBytes (multi-byte values refuse
  early). Cosmetic mislabel; already in the decision queue as C3.
- types.ts:646-659 host re-exports: A called dead, B proved it's the
  sanctioned web-boundary bridge (useEvents via @kernel/types + architecture
  test). MUST STAY — reconcile with cycle-3's C2 claim before any C2 work.
- test/kernel/types.test.ts construction-tests assert compile-time facts at
  runtime (coverage-rule judgment call).

## Decision-queue from Jesse's Q&A (2026-07-21)

- KILL store-side reservedNames (option + env plumbing + self-test) + amend spec §1
  Naming #4 to scope reservation to agent names.
- CUT grep abort-signal option (+ two abort checks + tests) + amend the spec sentence to
  the implemented timeout-or-restart contract.
- Lever-2 guard + credential redaction pattern: REVERTED (done) — see memory
  no-specialized-credential-machinery.
- QuickJS cutover proceeds AFTER the loop rotation, ending with live canaries.
- Branch stays unmerged; index fsync-off ratified; API spend = lean judgment.

## Constraints carried from the session

- The test-perf subagent works in a separate worktree on suite runtime — do not touch
  test sharding/infra here to avoid collisions; code simplifications only.
- Levers 1+2 (description trim, delegation secret guard) landed earlier today — their
  files are fair game for review but not re-litigation.
- QuickJS cutover remains parked (Jesse's call).
