# QuickJS-WASM cell engine — design

**Date:** 2026-07-20
**Status:** design (awaiting Jesse's go)
**Tracking issue:** prime-radiant-inc/sprout#1
**Predecessor specs:** `2026-07-16-sap-data-plane-and-repl-design.md` (cells, §4),
`2026-07-19-sap-completion-and-roadmap-design.md` (Phase 7 security posture)
**Build tracker (when started):** `../plans/2026-07-20-quickjs-cell-engine-plan.md`

## Purpose

Replace the cell evaluator's `node:vm` realm with a **QuickJS interpreter compiled to WASM** as
the execution substrate for model-authored code. This is a **substrate swap, not a semantics
change**: the cell contract — ambient API, lexical import/require ban, typed outcome envelope,
budget model, program injection, the `$ref`/store semantics — is KERNEL and survives
byte-for-byte. What changes is the floor under it.

### Why now

1. **The integrity edifice rests on containment we don't have.** The mutation gates, keystone
   canary, session budget, and payload capture all assume model-authored code cannot reach host
   capabilities. `node:vm` provides a *confused-deputy* bar that **fails open**: one
   JavaScriptCore engine escape (same-UID) yields the whole host process — API keys in env, the
   live genome, the store, the learn loop. Phase 7 documented this ceiling honestly; this spec
   closes it.
2. **Exposure grows by design.** Sap's point is to run *more* model-authored code over time:
   cells, fabricated programs, evolved program libraries. Sharpest edge: the mutation gates stop
   a bad fabricated program from being *adopted*, but its body *executes* during evaluation — N
   runs per arm, per proposal, of code no human read, with the realm as sole containment.
3. **Two best-effort guards become real.** Today memory limiting is an RSS watchdog (250 ms
   poll, SIGKILL after the fact; a fast allocator outruns it) and the budget clock kills rather
   than prevents. QuickJS provides a **byte-precise allocation limit** (allocation *fails* at
   the cap) and an **interrupt callback** at interpreter-step granularity (deadline enforced,
   not raced).
4. **Defense in depth.** The interpreter lives inside a wasm linear memory. An escape must
   break QuickJS, then the wasm boundary, and only then face JSC — versus one engine bug today.

## Goals

1. Cells and genome program bodies execute under QuickJS-WASM with the ambient API surface
   (`bind/publish/peek/slice/lines/grep/parse/size/get`, `spawn/handle` incl. `handle.future`,
   `console`, timers, `structuredClone`) semantically identical to today.
2. Byte-precise per-cell memory cap and interrupt-driven CPU deadline replace best-effort
   guards (the RSS watchdog is retained as an outer net — see Design).
3. All kernel invariants preserved: lexical import/require scan, `$ref` allowlist, JSON-sever
   of ambient results, identity-based infrastructure-error tagging, the typed outcome envelope,
   cap constants (`CELL_SPAWN_CAP`, `CELL_MAX_OUTSTANDING_AMBIENT`, `CELL_GET_BUDGET_BYTES`).
4. Single engine at the end: the `node:vm` path is **deleted at cutover** — no dual-engine
   maintenance, no soak, no compatibility flag (decided; see Rollout).
5. The security-posture docs flip from "fails open, documented" to "fails closed, tested."

## Non-goals

- Changing any cell/store/splice/publish semantics, the ambient API shape, or the worker
  protocol.
- Running cells outside the existing per-agent cell-worker subprocess (the process model,
  stdin-pipe lease, and SIGKILL wedge recovery stay).
- A hard sandbox against a hostile *host* (OS-level sandboxing — Seatbelt/bubblewrap — remains
  a separate, orthogonal future).
- Determinism guarantees beyond the interpreter itself (ambient responses and timers remain
  external inputs).

## Design

### Where the engine sits

Unchanged architecture: each agent process owns ONE cell-worker subprocess speaking the stdio
JSONL protocol (`{id, op:"cell", code, programs?}` → ambient round-trips → `{id, op:"result",
ok, output, returnValue?, error?, infrastructure?}`). The QuickJS-WASM instance lives **inside
that worker** where `vm.createContext` lives today (`cell-worker.ts:369-377`). The parent-side
`CellHost` — budget clock, futures, spawn servicing, stumble accounting, wedge recovery — does
not change.

One wasm module instance per worker process (amortizes instantiation); a **fresh QuickJS
runtime + context per cell** (today's fresh-`createContext`-per-cell isolation, preserved).
Prior art: `quickjs-emscripten` (mature, maintained). Exact binding APIs are confirmed at
bring-up, not assumed here; the load-bearing capabilities — a per-runtime memory limit, an
interrupt callback, a max stack size, and support for async host functions — are established
features of that toolchain.

### Realm construction

Today the bootstrap runs as in-context source over three host bridges (`__hostCall__`,
`__hostLog__`, `__hostTimers__`) which are deleted after capture, and ambient results are
JSON-severed in-context. Under QuickJS the boundary strengthens: the three bridges become
**host functions registered on the QuickJS context** — there is no host constructor chain to
leak because host objects cannot cross the wasm boundary as anything but marshaled values. The
existing `CELL_BOOTSTRAP` source (ambient wrappers, sealed timer ids, context-source
`structuredClone`, console buffering, JSON-sever) and `buildProgramsBootstrap` run unchanged as
in-context source — same semantics, same injected `programs.<name>` namespace, same lexical
scan upstream at validate + load.

Cell code still executes as today's wrapper: `"use strict"; (async () => { <code> })()`.

### Async model (decided)

The ambient API is async — every call round-trips to the parent — and, decisively, it is
**uniformly `await`-based**: cell code always `await`s an ambient call; there is no synchronous
(blocking, non-awaited) host call anywhere in the contract. Two shapes were considered:

- **(a) Asyncified host calls** (the toolchain's Asyncify-instrumented async build): a host
  function suspends the whole interpreter stack until the parent responds. Necessary only for
  *synchronous* blocking host calls — which our contract does not have.
- **(b) Native-promise + job-pump** (plain sync variant): the ambient host function creates a
  QuickJS deferred (`context.newPromise()`), stashes its resolver keyed by request-id, sends
  the stdio request, and returns the promise handle **synchronously**. The cell's `await`
  suspends via QuickJS's own async/await; when the parent responds we resolve the deferred and
  `runtime.executePendingJobs()` to run continuations; we pump until the top-level
  `(async()=>{…})()` promise settles. Timers and multiple-outstanding-ambient (already capped
  by `CELL_MAX_OUTSTANDING_AMBIENT`) each get their own deferred and pump identically.

**Decision: (b) is primary.** Because the ambient surface is already async/await, (b) maps onto
it 1:1 using QuickJS's native promise machinery (exposed directly by `quickjs-emscripten` in the
sync variant) with **zero Asyncify instrumentation** — no ~2× wasm-size penalty, no
instrumented-call tax, and a boundary the P3 security review can audit as "host fn returns a
deferred; parent resolves it" rather than stack-unwinding. The suspension mechanism's per-call
overhead is noise next to the stdio round-trip it wraps, so (a) would pay Asyncify's cost to
synthesize blocking we never use. The parent-owned budget-clock rule (accrue only while not
parked on ambient I/O) falls out for free: parked time is not executing.

**Fallback:** (a) Asyncify, adopted *only* if bring-up surfaces a cell semantic that genuinely
requires a synchronous host call (none is known). Switch recorded in the plan if it ever fires.

**The one real risk of (b)** — pump correctness: pumping with nothing ready, no ambient
outstanding, and the top-level promise unsettled is a genuine hang. It must surface as a typed
cell error via a pump-loop deadlock detector, never a wedge. P1 test, not a design blocker.

### Hard caps (the payoff)

- **Memory:** per-runtime allocation limit set from the existing
  `DEFAULT_CELL_MEMORY_BUDGET_BYTES` config (operator-tunable as today). At the cap the
  *allocation fails* inside the interpreter → the cell errors with the typed envelope — no
  kill-race. The **RSS watchdog is retained** as the outer net at the process level: the wasm
  instance, bindings, and worker JS itself live outside the QuickJS limit, and the watchdog is
  what catches a runaway *there*. Its doc changes from "the only memory guard (best-effort)" to
  "outer net behind a byte-precise inner cap."
- **CPU:** the interrupt callback checks the cell's deadline at interpreter-step granularity —
  the parent-owned budget clock semantics (accrue only while not parked on ambient I/O) are
  preserved by suspending the deadline while a host call is outstanding, exactly mirroring
  today's `outstandingAmbient === 0` accrual rule. The SIGKILL wedge path remains for a wedged
  *worker* (not a wedged cell — that can no longer happen).
- **Stack:** the interpreter's max-stack knob replaces "hope JSC throws RangeError first."

### What is byte-for-byte unchanged

Worker protocol and message types; `AMBIENT_METHODS`; the lexical `rejectImportRequire` scan
(validate + load + in-worker trust note); `serializeReturnValue` and the JSON-sever rule;
identity-based infra-error tagging; `CELL_SPAWN_CAP` / `CELL_MAX_OUTSTANDING_AMBIENT` /
`CELL_GET_BUDGET_BYTES` / `DEFAULT_CELL_BUDGET_MS`; `cell-api-types.ts` (the rendered `.d.ts`
is engine-agnostic); `CellHost` in full; futures; program injection; the keystone security
property.

### Rollout (decided: no back-compat, no soak)

Bring-up uses a temporary `SPROUT_CELL_ENGINE=quickjs|vm` selector **local to the build** — a
migration scaffold to keep the suite runnable against both engines while P1–P2 land. At the P3
cutover the selector **and** the `node:vm` path are deleted in the same build. No dual-engine
ship, no soak period, no compatibility flag (Jesse, 2026-07-20). QuickJS is the only cell engine
that ships.

## Invariants

- The immutability line: cell semantics, ambient API, `$ref` allowlist are KERNEL — the engine
  swap may not alter observable cell behavior (the suite is the oracle).
- A cell that passes/fails/errors under `node:vm` produces the same envelope under QuickJS,
  modulo error *message text* (asserted shapes, not engine strings — tests that pin engine
  strings get fixed honestly, recorded in the plan).
- No new host-reachable surface: the QuickJS context exposes exactly the bootstrap-installed
  globals; anything else present in a fresh context is interpreter-intrinsic only.
- Genome programs execute at cell privilege in the same context, as today.

## Phases

**P1 — Engine bring-up.** Wasm module + per-cell runtime lifecycle in cell-worker; host-fn
bridges; bootstrap + programs bootstrap running as in-context source; async model (b) wired,
including the pump-loop deadlock detector;
full cell suite (`test/cell`, cell-related `test/agents` slices) green under
`SPROUT_CELL_ENGINE=quickjs`. Fable review.

**P2 — Hard caps.** Memory limit (allocation-fail typed error + test that a fast allocator is
*stopped*, not raced), interrupt-driven deadline honoring the parked-time rule, max stack;
RSS-watchdog re-doc as outer net; budget-clock parity tests. Fable review.

**P3 — Adversarial containment + cutover.** Extend the realm-escape suite for the new
boundary (constructor-chain probes, intrinsic tampering, wasm-boundary marshaling edges,
allocation/interrupt bypass attempts); run the **live keystone canary + code-mode-cannot-exec
on real payload bytes** under QuickJS; perf benchmark (below); then delete the `node:vm` path
+ selector, update the Phase-7 security-posture docs and close issue #1. Fable review.

## Acceptance

1. Full suite green with QuickJS as the only engine (today's bar: 4078 tests).
2. The adversarial containment suite passes; no cell can reach a host capability, including
   under deliberate escape probes added in P3.
3. **Memory:** a cell allocating past the cap gets a typed in-envelope error before the
   watchdog would have fired (test races the old guard deliberately).
4. **CPU:** a hot loop is stopped at the deadline by the interrupt path (no SIGKILL), and
   parked ambient time still does not accrue.
5. **Live proof:** keystone canary and code-mode-cannot-exec PASS from real provider bytes
   under QuickJS (same harness as the Phase 4/5 live runs).
6. **Perf gate:** on an I/O-bound representative cell benchmark (capture → splice → spawn
   fan-out, the sap flagship shapes), p50 cell wall-time regresses **< 25%** vs `node:vm`;
   a compute microbenchmark is measured and *reported* (informational — cells are not compute
   kernels; a large interpreter gap there is expected and acceptable).
7. Estimated size: ~500–800 LOC engine bring-up + caps, plus tests; three Fable-reviewed
   phases.

## Risks (honest)

- **Pump-loop correctness** (the (b) hang case) — covered by the P1 deadlock detector; the
  Asyncify fallback (a) exists only if a synchronous host call ever proves necessary.
- **JS-surface deltas** (intrinsics/edge semantics between JSC and QuickJS) — the suite and
  the bootstrap's from-source installs (structuredClone, timers) minimize exposure; residual
  deltas are found by the suite, fixed honestly, and recorded.
- **Wasm-side memory lives outside the QuickJS cap** — covered by the retained RSS watchdog.
- **Toolchain dependency** (`quickjs-emscripten` maintenance) — pinned version, and the engine
  seam in cell-worker stays narrow enough that a future engine swap repeats this spec, not a
  rewrite.
- **Error-text drift** breaking tests that pinned engine strings — fixed by asserting shapes;
  each such change recorded in the plan (no silent weakening).

## Security posture after cutover

The cell realm becomes: untrusted JS → QuickJS interpreter → wasm linear memory → worker
subprocess (no credentials, stdin-pipe lease) → host. Memory and CPU are enforced, not raced.
The remaining honest ceiling — a hostile cell attacking the *worker process* via a wasm/binding
bug — is documented in the same places the current ceiling is, and OS-level sandboxing of the
worker remains the recorded next rung if we ever want it.
