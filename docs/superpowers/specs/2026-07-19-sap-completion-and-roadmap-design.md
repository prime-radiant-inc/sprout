# Sap completion & roadmap — design

**Date:** 2026-07-19
**Status:** design → build
**Predecessor spec:** `2026-07-16-sap-data-plane-and-repl-design.md` (the sap data plane, Phases 0–7, shipped)
**Build tracker:** `../plans/2026-07-19-sap-completion-and-roadmap-plan.md`

## Purpose

The sap data plane shipped through Phase 7 (store, capture, `$ref` splice, publish, code-mode
cells, genome programs, metrics, and the two self-improvement-integrity modules). Everything in
this spec is what was **deferred, TODO-marked, or roadmapped** during that build, gathered into
one design so it can be finished spec-driven. It covers three roadmap substrate items, the live
wiring of the self-improvement loop, the measurement that produces a real capability number, and
a set of recorded cross-phase deferrals and security-hardening items.

The immutability line is unchanged and non-negotiable throughout: **store / capture / `$ref`
splice / publish / scope / cell semantics / the ambient API / the `$ref` allowlist are KERNEL.**
The Learn loop can propose and adopt *genome* (agents, memories, routing, programs); it can never
touch the kernel. Every new adoption path in this spec is gated by the multi-run A/B test AND the
hidden canary suite before anything reaches the genome.

## Sequencing decision (2026-07-19)

Jesse chose **roadmap substrate first, then the integrity loop, then measurement** — later work
that would otherwise be re-touched sits on the substrate, so we build the substrate once. The
QuickJS-WASM engine swap (originally roadmap) is **out of scope**, tracked as GitHub issue #1;
this spec commits to `node:vm` and documents its ceiling. The known tradeoff: the measured
capability number lands late in the plan (Phase 5), after the substrate work — accepted.

## Goals

1. Byte-exact persistence of opaque provider state across journal/resume.
2. Futures + `$ref` promise pipelining on the existing wait graph.
3. Agent-Skills-compatible program metadata.
4. The N-run pinned-snapshot eval harness — the linchpin the integrity loop blocks on.
5. Live wiring of multi-run A/B, quartermaster fabrication/repair/curation, and the canary suite
   into the Learn loop, each behind the gates.
6. Curator generalized to agents and memories.
7. Program parameterization; programs root→genome sync plumbing.
8. Security hardening: per-session sub-call/token budget, script-tool shell-exposure tightening,
   documented `node:vm` ceiling.
9. The recorded cross-phase deferrals (deadlock detection, observer store reads, shared-handle
   wait-graph, scope announcements, `value_lines`/`value_publish`, manifest-pull relaxation).
10. A multi-task, multi-model eval producing a real capability/stumble number vs baseline.

## Non-goals

- The QuickJS-WASM engine swap (issue #1).
- Any backward-compatibility shim without Jesse's explicit approval.
- Changing kernel value/capture/splice/publish semantics.

---

## Phase 1 — Opaque provider-state persistence (roadmap substrate)

**Problem.** Providers now return opaque state that must round-trip byte-exact or the model's
context silently corrupts on resume: Anthropic thinking/compaction blocks, OpenAI encrypted
reasoning items, Gemini thought signatures. The journal/resume path today does not persist these
byte-for-byte.

**Design.** Extend the journal record and the resume reader so every provider payload's opaque
blocks are captured as **opaque bytes** — never parsed, never re-rendered, never redacted (they
are not transcript content; they are provider state). On resume, they are replayed into the
provider request in original position and encoding. This rides the existing journal append path;
it adds an `opaque_state` field to the per-turn record keyed by provider + block type.

**Invariants.** Opaque state is provider-owned bytes: the redaction gate must **exclude** it (it
is not model-authored transcript), and the store/capture path must not touch it. A resumed session
must produce byte-identical provider requests for the persisted turns.

**Acceptance.** A record→resume round-trip for each provider yields byte-identical opaque blocks;
a resumed multi-turn session with thinking blocks continues without a provider-side context error;
redaction leaves opaque state untouched.

## Phase 2 — Futures + `$ref` promise pipelining (roadmap substrate)

**Problem.** A `$ref` today resolves to a settled store value. A cell that spawns work and needs
its result must await it before binding — no pipelining. The value model was built to *admit*
futures (recorded in the prior plan); this phase realizes them.

**Design.** A **future** is a first-class value whose body is not yet settled, carried on the
existing wait graph (the same graph cells/waits already use). `$ref` to a future **pipelines**:
the splice is registered as a dependent on the wait node, and the downstream consumer resolves
when the future settles — no busy await in the cell. A future settles to a normal immutable store
value (ULID identity preserved), so everything downstream of settlement is unchanged.

**Invariants.** Futures ride the existing wait graph — no new deadlock surface beyond what the
graph already models (Phase 9 closes the remaining host-side detection). A future that never
settles is bounded by the parent budget clock, exactly as a cell is. Cross-process shared futures
stay unsupported/error (structurally cycle-free) until the shared-handle wait-graph work (Phase 9).

**Acceptance.** A cell binds a `$ref` to a not-yet-settled future, continues, and the downstream
splice resolves on settlement with the byte-identical settled value; a future abandoned past
budget is reclaimed; the wait graph reports the dependency truthfully in replay.

## Phase 3 — Agent-Skills-compatible program metadata (roadmap substrate)

**Problem.** Programs (the Phase-7 genome artifact) carry sap-native frontmatter. To interoperate
with the Agent-Skills ecosystem, program metadata should be expressible in the Agent-Skills schema
without losing sap's typed params / `spawns` / provenance.

**Design.** Extend `parseProgramMarkdown`/`serializeProgramMarkdown` (`src/genome/program.ts`) to
read and emit Agent-Skills-compatible metadata fields alongside the sap-native ones — a superset,
not a replacement. Validation (`validateProgram`) accepts either shape; the same lexical
import/require scan still runs at validate AND load. The `<programs>` render block gains the
Agent-Skills-visible fields.

**Invariants.** The lexical scan is unchanged (kernel-adjacent safety). Metadata is genome
(evolvable); the program *body* semantics are unchanged.

**Acceptance.** A program authored in Agent-Skills metadata round-trips through
parse→serialize→parse byte-stable in its fields; validation still rejects an import-bearing body;
an Agent-Skills-shaped program loads and injects as `programs.<name>` identically.

## Phase 4 — The N-run pinned-snapshot eval harness (linchpin)

**Problem.** The self-improvement loop's gates (multi-run A/B, canary suite) exist as tested
modules but consume nothing live, because there is no harness that runs a candidate genome N times
against a pinned task set in eval mode. This is the dependency every integrity item blocks on.

**Design.** A harness that, given a candidate genome snapshot and a pinned task set, runs each task
**N times** in **eval mode** (deterministic seeding where possible; same genome both arms for an
A/B), collecting per-run fitness samples (stumble rate) and the raw provider payloads needed by
canaries. It feeds `ArmResult` to `compareArms`/`shouldAcceptMutation` (already built, Phase 7B)
and supplies the real `CanaryHarness` adapter (Phase 7B's stub becomes a live adapter capturing
real payloads and the real code-mode-cannot-exec outcome).

**Invariants.** Eval-mode runs must not mutate the live genome or journal. The canary task set and
its outcomes stay hidden from the candidate (the Phase-7 hiding contract). N ≥ the A/B `minRuns`.

**Acceptance.** The harness runs a pinned task set N times against a fixed genome and returns
per-run samples; identical arms → A/B not-significant (no false accept); a real canary adapter runs
the keystone (captured content never in a provider payload) and the code-mode-cannot-exec check
against a live candidate and reports pass/fail from real bytes.

## Phase 5 — Live wiring of the integrity loop + the capability number

**Problem.** `learn-process.ts` still uses a single-delta stumble heuristic; the quartermaster's
fabrication/repair/curation and the canary suite are inert TODO-marked seams.

**Design.**
- Swap `evaluateImprovement` (learn-process.ts) to gate agent mutations on
  `shouldAcceptMutation` over the Phase-4 harness's N-run samples instead of a single delta.
- Wire the quartermaster: derive `CellObservation[]` from collected `cell_end` events, run
  `detectRecurringPatterns`/`proposeProgramFromCandidate`/`detectRepairCandidates`/`curatePrograms`,
  turn each into a `LearnMutation`, and gate EVERY one through `shouldAcceptMutation` **and**
  `mutationRegressesCanaries` (the hardened, fail-closed gate) before `applyMutation`.
- Wire the canary suite post-mutation: a mutation that regresses any canary rolls back regardless
  of visible fitness.
- **Measurement:** run the multi-task, multi-model eval and record a real capability/stumble
  number vs the data-plane-off baseline — the number Jesse asked for.

**Invariants.** No mutation reaches the genome without passing BOTH gates. The canary set stays
hidden. Fabricated bodies come from redaction-scrubbed `cell_end` code — the A/B gate is what keeps
a broken body out (already noted in code).

**Acceptance.** A fabricated program that genuinely lowers stumble rate is adopted only after a
significant N-run win AND a clean canary pass; a program that regresses a canary is rolled back
even with a better visible stumble rate; the recorded capability number is real (recorded provider
bytes, multiple tasks/models), not a single-run point estimate.

## Phase 6 — Curator generalization + program parameterization + root sync

**Design.**
- Generalize `curatePrograms` to a genome-view over **agents and memories** (retire never-used,
  consolidate near-duplicates) — the `quartermaster.ts:236` TODO — gated like any mutation.
- **Program parameterization:** fabrication infers typed params from the recurring cell code
  instead of always emitting empty params (the `quartermaster.ts:152` refinement).
- **Programs root→genome sync:** extend the bootstrap manifest + `syncRoot` with a `programs/`
  entry (the 7A YAGNI deferral) so root can ship starter programs, with the same overlay-or-copy
  decision agents use.

**Acceptance.** The curator proposes retirement/consolidation of agents and memories (gated);
a fabricated program with a clearly-typed recurring arg gets a typed param; a root-shipped starter
program syncs into the genome and loads.

## Phase 7 — Security hardening

**Design.**
- **Per-session sub-call/token budget** (variance cap): a hard per-session ceiling on sub-calls
  and tokens, enforced at the spawn/act boundary — currently open/bypassable.
- **Script-tool shell-exposure tightening:** any granted script tool is arbitrary shell today,
  independent of exec (see memory `sap-script-tool-shell-exposure`). Tighten the code-mode surface
  so a granted script tool cannot be a silent shell escape.
- **Document the `node:vm` ceiling:** record in-code and in-spec that the cell realm is a
  confused-deputy bar (fails open vs a determined same-UID attacker), not a hard sandbox; the hard
  sandbox is QuickJS-WASM (issue #1).

**Acceptance.** A session exceeding the sub-call/token budget is stopped at the boundary with a
typed error; a granted script tool cannot reach an unpermitted shell; the ceiling is documented
where an operator will find it.

## Phase 8 — Recorded cross-phase deferrals

The coherent, recorded deferrals from the sap build, finished here:
- **Host-side deadlock detection** (spec §4) on the wait graph — cross-process shared waits move
  from "error as unsupported" to detected/reported (pairs with Phase 2 futures + Phase 9).
- **Scoped observer store reads** — the observation surface for an observer to read scoped values.
- **Shared-handle host registry + wait-graph pairing** — the Phase-5-era pairing that
  cross-process shared waits need.
- **Scope announcements + post-compaction manifest event** — now that consumers exist.
- **`value_lines` / `value_publish` as separate primitives** — if a consumer now needs them beyond
  capture's `publish:`.
- **Manifest-pull relaxation** — revisit owner-only `STORE_MANIFEST_REQUEST` if a real
  cross-owner consumer exists (kept owner-only otherwise — YAGNI).

**Acceptance.** Each item either ships with a test or is explicitly re-deferred in the plan with a
recorded reason (YAGNI is a valid outcome; silent drop is not).

---

## Build methodology (SDD)

Same rhythm as the sap build: each phase is TDD (failing test first, smallest change,
root-cause fixes), committed frequently, and closed by an **adversarial Fable review** in fresh
context whose findings are fixed before the phase is marked done. The full suite
(`bun run test`) stays green at every commit; tsc (root + web) and biome stay clean. The plan file
is the living tracker — updated as each phase and slice lands, with decisions and deviations
recorded.

## Frozen non-negotiables (carried from the sap spec)

- **Multi-run A/B with significance** — no genome fitness decision on a single-run delta.
- **Hidden canary suite** — outcome-anchored, kernel-resident, never in the genome or any prompt;
  a regression rolls back regardless of visible fitness; the gate fails closed on incompleteness.
- **The immutability line** — kernel vs genome as above.
