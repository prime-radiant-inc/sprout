# QuickJS-WASM cell engine — build plan (living)

**Date started:** 2026-07-20
**Spec:** `../specs/2026-07-20-quickjs-wasm-cell-engine-design.md`
**Status:** in progress — P1 and P2 complete (both Fable-reviewed, findings fixed); P3 next
**Branch:** built on `sap-completion-roadmap`, merges together with the completion work
(Jesse, 2026-07-20: "build and merge together").

Working tracker for the engine swap. Records what we build, in what order, and where we
deliberately simplify. Update as phases land.

## Pre-flight findings (spiked before P1, in scratchpad)

- **Toolchain confirmed under Bun** (`quickjs-emscripten` 0.32.0): memory cap fails the
  allocation in-context (catchable `InternalError: out of memory`), interrupt handler stops a
  hot loop, max stack enforced, the full (b) async model works (`newPromise` deferred → host fn
  returns handle → resolve + `executePendingJobs` → `await` resumes; settlement via
  `getPromiseState`), native `ctx.eq` exists, `ctx.newError` exists.
- **Production loading path:** `quickjs-emscripten-core` + `@jitl/quickjs-singlefile-mjs-release-sync`
  (wasm embedded as base64). Chosen because the cell worker spawns by SELF-INVOCATION
  (`SPROUT_SELF_EXECUTABLE`, possibly a `bun build --compile` binary — see the `/$bunfs/` check
  in self-command.ts), so a loose `.wasm` file next to node_modules cannot be assumed.
  Debug singlefile variant is a devDependency for leak tests.
- **Leak discipline has teeth only on the debug variant:** release dispose is silent with
  leaked handles; debug aborts the wasm instance with the leak printed (`JS_FreeRuntime`
  assertion). The abort poisons the module instance → leak tests use a fresh module per test.
- **Versions pinned exact** (no `^`): all three packages at 0.32.0.

## Engine-seam findings (cell-worker reread)

- The seam is `executeCell` in cell-worker.ts: sandbox bridges (`__hostCall__`, `__hostLog__`,
  `__hostTimers__`) → `vm.createContext` → `CELL_BOOTSTRAP` → programs bootstrap → async IIFE.
  The line loop, `callAmbient`, the infra WeakSet, `ConsoleBuffer`, `serializeReturnValue`, and
  `rejectImportRequire` are engine-agnostic and do not move.
- Two hazards that are harmless under `node:vm` but fatal under QuickJS — P1 must guard both:
  1. **Late ambient response after cell end** (un-awaited ambient call + `return`): must not
     touch a disposed runtime → per-cell generation guard in the engine.
  2. **Worker-side timers surviving the cell**: cancel all host timers and dispose retained
     callback handles at teardown.
- **Marshal-in is the sever:** ambient results cross the boundary as JSON text parsed
  in-context by a pristine `JSON.parse` captured at engine init. The bootstrap's own in-context
  sever stays (bootstrap byte-for-byte unchanged); the double round-trip is bounded by
  `CELL_GET_BUDGET_BYTES` (1 MB) and acceptable.
- **Timer tokens:** the bootstrap stores whatever `hostTimers.setTimeout` returns and passes it
  back to `clearTimeout` — opaque. Under QuickJS the host returns a numeric token instead of a
  host Timer object; bootstrap unchanged.
- **Layout:** realm source builders (`buildCellBootstrap`, `buildProgramsBootstrap`,
  `AMBIENT_METHODS`, `WorkerProgram`) move to a shared module so both engines import them
  without a cycle; cell-worker re-exports the existing names for current importers.

## Frozen non-negotiables (carried)

- The immutability line: cell semantics, ambient API, `$ref` allowlist are KERNEL — the suite
  is the oracle; tests that pinned engine error strings get fixed to shapes, each recorded here.
- No back-compat, no soak: `SPROUT_CELL_ENGINE` selector is build-local scaffolding; it and the
  entire `node:vm` path are deleted together at P3 cutover.

## Method

Per phase: TDD (failing test first) → build → full suite green + tsc + biome clean →
adversarial Fable review in fresh context → fix findings → commit → update this plan.

## Phases

- [x] **P1 — Engine bring-up.** DONE (commits b95c587 seam refactor, 6be183b engine,
  2bb9af8 review fixes). Full worker suite parameterized over both engines (93 cell tests),
  full suite 4119 green. Fable review verdict: pump model, handle discipline, infra
  non-forgeability, and marshal-in sever all sound and empirically probed (~12 adversarial
  probes); findings were a display-parity cluster, fixed — see Deviations.
  - Extract the realm behind a `CellEngine` interface (vm engine = current logic MOVED, not
    rewritten; behavior-preserving refactor under the existing suite).
  - `SPROUT_CELL_ENGINE=quickjs|vm` selector, overridable per `runCellWorker` call so the
    worker test suite runs BOTH engines parametrically in one pass.
  - QuickJS engine: singlefile module lazy-loaded once per worker; fresh runtime + context per
    cell; host-fn bridges; bootstrap + programs bootstrap as in-context source, unchanged;
    event-driven (b) pump (pump on ambient resolve / timer fire; settlement via
    `getPromiseState`); deadlock detector (top-level pending + zero outstanding ambient + zero
    live timers + zero pending jobs → typed cell error); boundary-identity infra tagging
    (in-context `newError`, retained handles, `eq` compare; catch-and-rethrow test must be a
    stumble, uncaught-infra test must be `infrastructure: true`); scoped disposal everywhere;
    debug-variant leak test; generation guard; timer teardown.
  - Full cell suite green under both engines. Fable review.
- [x] **P2 — Hard caps.** DONE (commits bfc412c caps, 1192160 review fixes). Memory cap is the
  wasm linear-memory MAXIMUM (upstream `setMemoryLimit` doesn't enforce cumulative growth —
  see Deviations); OOM is a cell STUMBLE, not infrastructure (a deliberate reclassification —
  see Deviations). Interrupt-driven deadline honors the parked-time rule, with a host-side
  wall-clock deadline timer covering timer-sleep (the interrupt only sees running bytecode);
  `deadlineHit` override is non-forgeable/unswallowable (infrastructure, mirroring the parent
  kill). Explicit 1 MB max stack. RSS watchdog kills at cap + 256 MB measured headroom under
  quickjs, unchanged under vm. 10 hard-cap tests + parity tests; full suite 4136 green.
  Fable review: found HIGH-1 (timer-callback deadline/OOM crashed the worker), HIGH-2
  (marshal-in glue-malloc trap crashed the worker), MED-3 (timer-sleep escaped the deadline),
  MED-4 (>2 GiB budget bricked the subsystem) — all fixed in 1192160.
- [ ] **P3 — Adversarial containment + cutover.** IN PROGRESS.
  - [x] **Adversarial containment suite** (commit 6aff4ee): `test/cell/quickjs-containment.test.ts`,
    14 probes, all green. Host globals unreachable (incl. via Function/Async/Generator/ctor-chain
    constructors, which evaluate in-realm); bridges deleted post-bootstrap; marshal-in sever is
    engine-side/pristine (a cell tampering its own JSON.parse corrupts only its own view);
    getter/Proxy ambient args don't run host-side; interrupt cap unbypassable; bigint bombs
    refused; caught-OOM keeps binding; prototype pollution + globals die at the cell boundary.
    Cross-context isolation within one runtime verified (informs any future runtime reuse).
  - [x] **Perf benchmark** (commit 1f30e3e): `scripts/bench-cell-engine.ts`. MARGINAL on the gate:
    QuickJS adds a fixed **~0.7ms/cell** (3KB bootstrap parse+exec + fresh context + marshalling);
    on the ~3.4ms flagship shape that is **~20–30% p50, straddling the 25% gate** with run-to-run
    noise (real-store runs: 11% / 24% / 30%). Compute is ~15× slower (informational). Runtime
    reuse doesn't help (creation ~0.01ms); bytecode compile is context-bound in quickjs-emscripten
    0.32. **DECISION NEEDED (Jesse):** how to treat the marginal gate before deleting the vm
    fallback — the 0.7ms absolute is negligible against a real agent turn, but the literal
    <25% cell-wall-time gate is not cleanly met.
  - [ ] **Live keystone canary + code-mode-cannot-exec under QuickJS** — `SPROUT_CELL_ENGINE=quickjs
    bun run scripts/eval-sap.ts --smoke`. BILLED (real provider keys). Held for Jesse's go.
  - [ ] **Cutover** — delete `node:vm` path + selector; update Phase-7 security-posture docs;
    close issue #1. HELD pending the perf decision + live canary.

## Deviations log

- **Return-value serialization moved to the engine seam** (P1 review fix). The spec listed
  `serializeReturnValue` as staying in the worker; only the engine sees the live realm value
  with its type intact (a Date that crosses the wasm boundary is already a string), so the
  algorithm — byte-identical — now lives in cell-engine.ts, applied by the vm engine on the
  live value and reproduced in-context by the QuickJS engine's pristine MARSHAL_DISPLAY
  helper. Display bytes match the vm engine exactly; pinned by parameterized tests
  (top-level Date/Error/circular, console args).
- **Accepted divergence — ambient-arg getters.** Under vm, a throwing getter/Proxy trap in an
  ambient argument fires during host-side JSON.stringify and rejects the call; under QuickJS,
  `dump()` neutralizes it host-side (coerced plain data, no cell code runs on the host).
  Strictly safer; kept.
- **Error message text** diverges deliberately (QuickJS reports `boom`, vm's cross-realm
  `String(err)` reports `Error: boom`); spec pins shapes, not engine strings.
- **Upstream bug** (quickjs-emscripten 0.32): `module.newRuntime` drops `ownedLifetimes`, so
  `TestQuickJSWASMModule.assertNoMemoryAllocated` false-positives "runtimes leaked". Leak
  tests assert runtime disposal + the wasm-level sanitizer directly; a leaked handle still
  aborts loudly at dispose under the debug build (verified deliberately, by us and by the
  reviewer independently).
- **Worker guards engine throws** as `infrastructure: true` results (new failure mode the vm
  engine could not produce: wasm-load failure, engine bug). Same classification inside
  `pump()`, which runs from detached callbacks the worker guard cannot see.

### P2 deviations

- **Memory cap is the wasm linear-memory MAXIMUM, not `setMemoryLimit`.** The spec assumed a
  byte-precise per-runtime allocation limit; upstream (quickjs-emscripten 0.32) `setMemoryLimit`
  only rejects a SINGLE allocation larger than the limit and does NOT track cumulative growth
  (verified twice: 20k live 1 KB strings = 21 MB sail past an 8 MB limit). The real cap is a
  `WebAssembly.Memory` whose `maximum` the allocator cannot grow past. `setMemoryLimit` is
  retained as the single-shot fast path. Granularity is honest-not-byte-exact: the cell also
  gets the < 16 MB initial-heap slack. Cap clamped to the variant's declared max (2 GiB =
  32768 pages) so an over-large budget pins at 2 GiB instead of a LinkError.
- **OOM is a cell STUMBLE, not infrastructure** (reclassification). Under vm, OOM surfaced as
  the RSS-watchdog SIGKILL → infrastructure → zero stumbles; that was an accident of the
  guard's position. A cell exhausting its memory budget is genome behavior the learn loop
  should see. Preserving the old classification would require message-based infra tagging,
  which is FORGEABLE (QuickJS exposes `InternalError`/`out of memory` to cell code). The
  DEADLINE stays infrastructure (host-owned `deadlineHit`, non-forgeable).
- **Timer-callback errors fail the CELL, not the worker** (better-than-vm). vm's detached host
  timer crashes the worker on a throw (death + respawn; also a stumble-laundering vector).
  QuickJS holds the callback's error value, so a throw/OOM in a timer fails the cell as a
  stumble and a deadline ends it typed — worker survives. Safe because teardown cancels timers
  at cell end, so a timer only ever fires within its own cell.
- **Host-side wall-clock deadline timer** added alongside the interpreter-step interrupt: the
  interrupt only fires during running bytecode, so a cell idling on a long timer sleep would
  otherwise escape the deadline until the timer fired (bounded only by the parent SIGKILL).
- **Marshal-in trap → module discard.** A wasm OOB trap in the emscripten glue `_malloc`
  (marshalling a large ambient result into a near-cap heap) poisons the module so thoroughly
  that even disposal traps. The engine catches it, finishes the cell as a typed OOM stumble,
  and discards the module (teardown skips all interpreter disposal); the next cell rebuilds a
  clean instance. Verified a fresh module works after the trap.
- **No global module sharing.** Each engine instance owns its module (rebuilt when the cell's
  memory cap changes) — the cap is a property of the wasm instance, and an uncapped first cell
  must not silently disable a later cell's cap.
