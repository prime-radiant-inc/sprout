# Sap build plan (living)

**Date started:** 2026-07-18
**Spec:** `../specs/2026-07-16-sap-data-plane-and-repl-design.md`
**Review:** `../specs/2026-07-18-sap-state-of-the-art-review.md`
**Status:** in progress — Phase 0 complete; Phase 1 started

This is the working tracker for building sap. It records *what we're building, in what
order, and where we deliberately simplified away from the maximal spec*. Update it as
phases land.

## Guiding principle

**Simple, clean, self-improving.** The spec is the maximal, adversarially-hardened design;
it is the reference for *intent and invariants*, not a line-by-line build order. We implement
the simplest clean mechanism that satisfies each phase's intent and preserves the spec's
frozen invariants (the "one rule", the `$ref` allowlist, scope isolation, kernel-vs-genome
line). Where the spec hardens against a threat that isn't live yet, we defer that hardening
to the phase where it becomes load-bearing rather than landing it as dead code.

Two standing rules from the review that are *not* optional, because they protect the
self-improvement loop itself:
- **Multi-run A/B** for genome fitness (single-run stumble rate is noise — RLM-class variance
  scores identical inputs 0/6→6/6). Lands with metrics (Phase 7).
- **A hidden, outcome-anchored canary suite** the quartermaster cannot see (DGM proved a
  self-modifier games a visible fitness check). Lands with programs (Phase 7).

Everything the review filed as roadmap (futures + `$ref` pipelining, QuickJS cell engine,
Agent-Skills-compatible programs) is **post-v1**. We design the value model to *admit* futures
later (an unresolved-value state), but build nothing for it now.

## How we work

- **TDD, always.** Failing test first, then the minimal code to pass it. Regression test for
  every bug fix.
- **A phase lands green before the next starts** (typecheck + unit tests + biome clean;
  `bun run precommit`). Commit per reviewable concern, conventional-commit messages.
- **Subagent fan-out where files don't collide.** Read-only exploration fans out freely.
  Parallel *implementation* only across independent modules, in worktrees, never two agents
  editing one file. Foundational kernel edits are done in-line, coherently.
- **Architectural sub-decisions go to Jesse** before building (sandbox mechanism, store-worker
  transport, cell-worker engine). Routine implementation does not.

## Phases

Order and intent follow spec §12. "Simplification" notes what we changed and why.

### Phase 0 — Kernel prerequisites  ✅ landed 2026-07-18
- [x] **`hitTurnLimit` bug fix** (`95d7340`). An agent that naturally completed on its final
  allowed turn was marked failed + stumbled — a live fitness-signal bug. Fixed by threading
  `completedNaturally` from the natural-completion breaks.
- [x] **Runtime health on Linux** (supported runtime, per Jesse): `node`-interpreter agent
  tools failed on Linux (`/dev/stdin` → /proc pipe ENOENT) — tool scripts now run from a
  shell-side temp file (`a4c97d8`); subcortical eval needed a realistic timeout (`8b0ea34`);
  abort-between-turns test had a timer/spawn race under parallel load (`186f376`).
- **Simplification — deferred, not dropped:**
  - *Zero-tool completion agents* (`tools: []`, `max_turns: 1`) → **Phase 5**, landing with
    `utility/llm-call`, its only consumer. Building it now is dead capability.
  - *Pausable inactivity timer (mechanism only)* → **Phase 1**, landing with the suspension
    logic that first calls it. A pause nothing calls is dead code; the spec split it out for
    review isolation, which we don't need.

### Phase 1 — Channel & auth  ← current
Authenticated host endpoint, per-handle tokens, handle registration
(duplicate/non-parent rejection), env filtering (token, endpoint URL, bus URL), liveness
pings; **timer suspension for all blocking agent waits** (this is where the pausable timer
from Phase 0 lands, *with* pings as its net). Fixes the pre-existing spurious-timeout bug
symmetrically across arms.

Slices (test-first; fan-out where files are disjoint):
- [ ] `src/host/handle-registry.ts` — identity core: registration (duplicate/non-parent
  rejection, owner re-register carve-out when not live), sha256 token hashing,
  constant-time authenticate, live-connection tracking. Pure logic, no I/O.
- [ ] `src/agents/inactivity-timer.ts` — pausable inactivity timer mechanism (reentrant
  pause/resume, resume re-arms fresh). Extracted from the run loop's inline setTimeout;
  nothing suspends yet.
- [ ] Swap the run loop's inline timer for the module (behavior-preserving).
- [ ] Authenticated host endpoint + handshake wiring (registry-backed), token minting at
  spawn, env filtering (token, endpoint URL, bus URL) in exec children.
- [ ] Liveness pings (15 s) + timer suspension during blocking waits, both act modes.

### Phase 2 — Store core
Store worker (op budgets, wedge restart), journal, CAS (staging-confined handoff, spill),
disk/count quotas, name validation, previews + redaction, `value_bind` events, value-read
primitives (truncation bypass), spawnerless local store. *Simplify memory/spill to the
smallest correct LRU; no premature tiering.*

### Phase 3 — Capture & publish
Structured-result methods on `ExecutionEnvironment` (raw bytes; stdout/stderr split;
structured grep matches — grep results must carry offsets/lines that compose into
`slice`/`lines`/`spawn`), capture (`bind:`, auto-capture on both truncation passes, truthful
markers), publish, pulled result manifests + summary budget + collision suffix/rewrite +
store-full fallbacks, auto-bind at boundaries, scope announcements + post-compaction manifest
event. **Review add:** scope-announcement transport uses Anthropic mid-conversation
`role:"system"` messages where available, `system-reminder` fallback elsewhere.

### Phase 4 — Splice & grants
`$ref` whole-arg resolution (loud misses, per-primitive allowlist, post-splice path re-check),
env-grant registration (loud alias collisions, observer-env prohibition), `env` on
delegate/message/continue/StartMessage. **← natural v1 release line: the ≥80% token win is
delivered here, no evaluator. Ship and measure before Phase 5.**

### Phase 5 — Evaluator
Per-agent cell workers, `cell` tool over the authenticated channel, ambient API (incl.
`handle(id)`, `publish()`), cell-output redaction/budget gate, spawn routing (owner relay +
root bridge) with the five cell-spawn deviations, stumble counting + learn dedup, budget
clock, cancellation lease, full blocking-wait registration + cycle detection, host handle
registry for shared handles, featherweight placement, `utility/llm-call` (+ **zero-tool
completion agents** from Phase 0). **Architectural decision pending (review §3.2): cell-worker
isolation.** Recommendation: OS capability sandbox (`anthropic-experimental/sandbox-runtime`,
Seatbelt/bubblewrap — fails closed) rather than the spec's stripped-realm + lexical-ban (fails
open, bypassable). Discuss before building. Add per-session sub-call/token budget (variance
cap). RSS watchdog worded as best-effort liveness, not a hard cap.

### Phase 6 — Code-first
`act` spec field + flag semantics + flag-off-empty genome validation,
cell-implies-value-reads, scoped observer store access, TUI/web rendering. **Review add:**
typed (`.d.ts`-style) surface for the ambient API and spawnable agents — Cloudflare's evidence
says types, not bare functions, are what make model-written cells reliable.

### Phase 7 — Programs
Genome artifact type + sync/export plumbing, quartermaster fabrication (from stumbles **and**
observed dataflow topology — review §2.3, the flywheel), eval-mode gating, metrics dashboards.
**Review adds (self-improvement integrity):** multi-run A/B with significance; the hidden
canary suite; a curator pass for library rot (consolidation/retirement).

## Roadmap (post-v1)
Futures + `$ref` promise pipelining (rides the existing wait graph); QuickJS-WASM cell engine
(byte-precise memory cap); Agent-Skills-compatible program metadata. Also table-stakes and
scheduled but spanning phases: **byte-exact persistence of opaque provider state** (Anthropic
thinking/compaction blocks, OpenAI encrypted reasoning items, Gemini thought signatures) in
the journal/resume path.

## Decisions log
- **2026-07-18:** Phase 0 reduced to the `hitTurnLimit` fix; zero-tool agents → Phase 5,
  pausable timer → Phase 1 (avoid dead code). Simple-clean over the spec's review-isolation
  split.
