# QuickJS-WASM cell engine — build plan (living)

**Date started:** 2026-07-20
**Spec:** `../specs/2026-07-20-quickjs-wasm-cell-engine-design.md`
**Status:** in progress — P1
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

- [ ] **P1 — Engine bring-up.**
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
- [ ] **P2 — Hard caps.** Memory limit from `DEFAULT_CELL_MEMORY_BUDGET_BYTES` (allocation-fail
  typed error; test asserts worker stays alive — absolute terms, survives P3); interrupt-driven
  deadline honoring the parked-time rule (`outstandingAmbient === 0` accrual parity); max
  stack; watchdog threshold raised above the inner cap (cap + measured worker-baseline
  headroom); budget-clock parity tests. Fable review.
- [ ] **P3 — Adversarial containment + cutover.** Escape-probe suite for the new boundary
  (constructor-chain, intrinsic tampering, marshaling edges, allocation/interrupt bypass);
  live keystone canary + code-mode-cannot-exec on real payload bytes under QuickJS; perf
  benchmark (<25% p50 on I/O-bound shapes; compute measured + reported); DELETE the `node:vm`
  path + selector; update Phase-7 security-posture docs; close issue #1. Fable review.

## Deviations log

(none yet)
