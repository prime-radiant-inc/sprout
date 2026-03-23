# Harbor Build Cython Ext Session Notes

Date: 2026-03-20

## Purpose

Start a durable session record for the March 2026 Harbor improvement campaign,
including:

- the broad local-functionality wins that were already landed
- the engineering principles that produced real improvement
- the later `build-cython-ext` experiment waves
- the current checkout-local Bun subprocess-test anomaly

This is a start, not a verbatim transcript. The goal is to preserve the
decisions, outcomes, and current frontier so the next loop can resume from
facts instead of reconstruction.

## Landed State

- `main` is at `6ad5566`.
- The landed evaluation-improvement baseline under that tip is `06a3648`.
- The current checkout branch is `wip/experiment-24-direct-repair-loop-owner`
  at `a31380e`, which is one commit ahead of `main`.
- `a31380e` is a test-only follow-up:
  - `test: add direct repair-loop ownership guidance`

## Broad Functionality Outcome

The initial local Harbor breadth batch was brought to green across distinct
task shapes:

- `git-leak-recovery`
- `vulnerable-secret`
- `multi-source-data-merger`
- `log-summary-date-ranges`
- `sqlite-db-truncate`
- `regex-log`
- `openssl-selfsigned-cert`

Those wins came from general prompt-contract and execution-discipline fixes, not
task-specific recipes.

## Engineering Principles That Actually Helped

These themes repeatedly moved real behavior in the right direction:

- preserve exact outputs, literals, tokens, schemas, and enumerated labels
- preserve stated invariants instead of rewriting the environment to fit the
  solution
- preserve distinctions; collapse them only when the task and the evidence
  justify it
- prove required deliverables in the target operating context
- keep the deliverable frontier at the acceptance gate
- patch named breakages before widening into broader scans
- keep one owner on a direct repair loop when the frontier is already known
- treat empty or sharply reduced outputs as partial when prior evidence already
  surfaced concrete candidates

## Mainline Commit Spine

The landed improvement spine on `main` now includes these notable fixes:

- `96f0db5` `fix: keep structured field evidence separate`
- `d8c7951` `fix: promote preserve distinctions rule`
- `f919fdb` `fix: run exec commands under bash`
- `7a98dcd` `fix: require semantic consistency per field`
- `c1de570` `fix: treat empty recoveries as partial`
- `1d60601` `fix: preserve stated environment invariants`
- `308fc7e` `fix: forward exec working directories`
- `8776ee2` `fix: preserve project-root execution context`
- `f640bb7` `fix: preserve environment invariants during build work`
- `5212c49` `fix: gate build steps on source confirmation`
- `a46c606` `fix: preserve exact external source identity`
- `7a2cce9` `fix: preserve exact verification paths`
- `b485800` `fix: preserve install verification context`
- `de88599` `fix: remediate named verification frontiers directly`
- `51736b2` `fix: generalize dependency invariant guidance`
- `c9a73d8` `fix: preserve required build outputs`
- `7cac4c7` `fix: prefer simplest contract-safe intervention`
- `b125efd` `fix: preserve exact acceptance code blocks`
- `51c0933` `fix: keep exact end-to-end checks authoritative`
- `e979cad` `fix: patch named breakages before sibling scans`
- `38a839f` `fix: stop contradictory editor verification loops`
- `10d743d` `fix: prioritize direct blocker remediation`
- `c028b5f` `fix: keep repair-loop ownership direct`
- `06a3648` `fix: keep deliverable frontier at the acceptance gate`
- `6ad5566` `style: format tool tests after verification`

## Build Cython Ext Campaign Summary

The `build-cython-ext` task became the main unsolved frontier after the broad
batch went green.

What improved:

- exact repo/tag identity preservation
- fixed global environment invariants, especially NumPy pin preservation
- better proof discipline around installed-location verification
- better propagation of exact acceptance snippets through delegation
- better repair behavior when a named traceback already identified the next
  blocker

What repeatedly failed:

- timeout after the run had already reached the real downstream compatibility
  frontier
- drifting from the exact end-to-end gate into weaker component probes
- reopening upstream stages after the task had already moved downstream
- too many one-traceback-per-cycle repair loops instead of converging on the
  active failure family

## Best Diagnostic Frontier From Build Cython Ext

By the later experiment waves, the remaining failures were no longer setup or
spec-drift failures. The task had narrowed to real compatibility work in the
installed package:

- `fractions.gcd` removal fallout in `pyknotid.make.torus`
- NumPy alias fallout such as `np.float` and `np.int`
- downstream example and repo-test failures caused by that same compatibility
  family

The most useful conclusion from those runs was:

- the bottleneck is now control-flow and convergence after reaching the true
  compatibility frontier, not basic environment setup or prompt routing

## Experiment-Wave Outcome

The later `build-cython-ext` work was run as many small parallel experiment
waves from the landed baseline.

What we know so far:

- no post-`06a3648` experiment has been promoted to `main`
- several waves were explicitly discarded after scoring worse or equal while
  timing out
- `exp31` was the best of one clean four-way batch at `8 passed / 3 failed`,
  but still not a keep
- the later `exp55` family improved signal further, but still did not produce a
  trustworthy keep

The cleanup ledger for stale worktrees is recorded in:

- [2026-03-20-build-cython-ext-worktree-cleanup-ledger.md](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/docs/superpowers/plans/2026-03-20-build-cython-ext-worktree-cleanup-ledger.md)

## Current Checkout-Local Bun Test Finding

The current subprocess-test anomaly is not a committed-code regression.

What was established:

- these subprocess-heavy tests fail from the root checkout cwd:
  - `test/kernel/execution-env.test.ts`
  - `test/host/cli-compiled.test.ts`
  - `test/tasks/cli.test.ts`
  - `test/tools/harbor/sprout-agent.test.ts`
- the same tests pass in a clean worktree at the same `HEAD`
- the same tests also pass when run from a neutral cwd with:
  - `bun test --cwd /tmp <absolute test path>`

The strongest current statement is:

- the failure is checkout-local and cwd-sensitive
- it follows `bun test` running with cwd at the root checkout
- it does not follow the committed code or the test files by themselves

What was ruled out:

- the repo `.env` file by itself
- the visible root `*.bun-build` files by themselves
- the previously removed junk files at repo root

The practical harness direction is:

- keep the tests
- stop treating root-checkout cwd as a trustworthy environment for these
  subprocess-heavy cases
- run those tests from a neutral cwd or clean worktree

## Active Debug Worktrees

These worktrees are still relevant and were intentionally retained during
cleanup:

- `fix-subprocess-harness`
- `repro-current-head`
- `experiment-56-exact-frontier-scope`
- `experiment-56b-exact-frontier-scope`

## Next Resumption Point

Resume from two threads:

1. Harness hygiene
   - make subprocess-heavy Bun tests run from a neutral cwd
   - verify the root checkout stops giving false negatives for those cases

2. `build-cython-ext`
   - continue from the real downstream compatibility frontier
   - judge new ideas primarily on whether they improve convergence after the run
     reaches named compatibility failures

## Active Eval Loop Continuation

The current long-lived experiment worktree is:

- `wip/active-eval-loop-mainline`
- `/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/.worktrees/active-eval-loop`

The control worktree for current Harbor A/B runs is:

- `main`
- `/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/.worktrees/integrate-harness-fix`

### `exp138` outcome

Candidate:

- `dc16707` `fix: forbid invented exact acceptance snippets`

Controls stayed on `main` at `35f7cd1`.

Results:

- candidate A: `8 passed / 3 failed`, timeout
- candidate B: `7 passed / 4 failed`, timeout
- control A: `7 passed / 4 failed`, timeout
- control B: `3 passed / 8 failed`, timeout

Useful root cause:

- the better candidate rep preserved the constrained environment and used a
  narrow live reinstall after local source edits
- the worse candidate rep widened into `python -m pip install --upgrade
  --force-reinstall .`, re-resolved unrelated packages, and drifted NumPy to
  `2.4.3`

Checkpoint that followed:

- `c7d2b34` `fix: preserve dependency invariants during reinstall`

### `exp139` outcome

Candidate:

- `c7d2b34` `fix: preserve dependency invariants during reinstall`

Control:

- `35f7cd1` on `main`

Harbor tmpdirs:

- candidate A: `/tmp/sprout-exp139-candidate-a.qy2G06`
- candidate B: `/tmp/sprout-exp139-candidate-b.W7PM9y`
- control A: `/tmp/sprout-exp139-control-a.5sPpm6`
- control B: `/tmp/sprout-exp139-control-b.6EbaVK`

Results:

- candidate A: `3 passed / 8 failed`, timeout
- candidate B: `7 passed / 4 failed`, timeout
- control A: `7 passed / 4 failed`, timeout
- control B: `7 passed / 4 failed`, timeout, but one remaining failure was the
  NumPy version invariant itself

Decisive new root cause:

- when the exact gate still said named compiled modules were missing, the bad
  rep pivoted into repository-structure analysis, package-export analysis, and
  option-list framing instead of taking the next explicit output-producing build
  or install step in the live source tree
- the better rep stayed closer to the build frontier by checking prerequisites,
  running the smallest explicit extension build step, and only then moving back
  to runtime verification

Checkpoint that followed:

- `238bffc` `fix: keep missing outputs on the build frontier`

### `exp140` launch

Candidate:

- `238bffc` `fix: keep missing outputs on the build frontier`

Control:

- `35f7cd1` on `main`

Before launch:

- rebuilt Harbor agent artifacts in both active and control worktrees with
  `bun run build:harbor-agent`
- switched back to the documented local Harbor harness under each worktree's
  `inspo/harbor`

Launcher correction:

- active worktree runs can source their local `.env`
- control worktree runs cannot; the control lanes must source the repo-root
  `/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/.env`

Current live tmpdirs:

- candidate A: `/tmp/sprout-exp140-candidate-a.ljBIOv`
- candidate B: `/tmp/sprout-exp140-candidate-b.Zbziwm`
- control A: `/tmp/sprout-exp140-control-a.scG4Uv`
- control B: `/tmp/sprout-exp140-control-b.Wk8C3h`

### `exp140` outcome

Candidate:

- `238bffc` `fix: keep missing outputs on the build frontier`

Control:

- `35f7cd1` on `main`

Results:

- candidate A: `6 passed / 5 failed`, timeout
- candidate B: `9 passed / 2 failed`, timeout
- control A: `2 passed / 9 failed`, timeout
- control B: `3 passed / 8 failed`, timeout

Keep decision:

- `238bffc` is a real keep
- both candidate reps beat both controls by a wide margin
- candidate B reached the narrow installed-path compatibility frontier at
  `np.float` in `cinvariants` / example usage

Decisive split inside the keep:

- candidate A widened into the broader `python3 -m pip install .` path
- that path also mutated unrelated runtime dependencies and reopened the NumPy
  version failure
- candidate B took the narrower direct producer path:
  - install only the missing build prerequisites
  - rerun `python3 setup.py build_ext --inplace`
  - keep the environment invariant intact
  - then continue on the installed-path compatibility frontier

Next candidate:

- keep `238bffc` as the new baseline
- add a stronger engineer rule:
  - when output generation itself is the blocker, prefer the smallest direct
    producer for those outputs over a broader package install or environment
    sync that can also mutate unrelated runtime dependencies
  - do not widen that output-producing step into unrelated runtime dependency
    changes unless the exact gate names those dependencies as the blocker or
    prerequisite

### `exp141` launch

Candidate:

- `5e22108` `fix: prefer direct output producers over broad installs`

Control:

- `35f7cd1` on `main`

Harbor tmpdirs:

- candidate A: `/tmp/sprout-exp141-candidate-a.zoQgew`
- candidate B: `/tmp/sprout-exp141-candidate-b.V96iPn`
- control A: `/tmp/sprout-exp141-control-a.5eIWIP`
- control B: `/tmp/sprout-exp141-control-b.rxMxWD`

Launch notes:

- rebuilt Harbor agent artifacts in active and control worktrees before launch
- all four lanes source the repo-root `.env`
- all four lanes use the documented local Harbor path under each worktree's
  `inspo/harbor`

Interim operational notes while `exp141` is still running:

- the local supported Harbor path remains direct `uv run harbor run` from the
  shared Harbor checkout with the worktree's `tools/harbor` on `PYTHONPATH`
- `inspo/harbor-runner/launch.sh` is still the AWS spot runner, not the
  canonical local hill-climb harness
- Harbor has not emitted `result.json` yet, but this is not a dead launcher:
  all four local containers are still up and still have live
  `sprout --internal-agent-process` children
- the verifier directories are still empty, so Harbor has not crossed into the
  verifier-output phase yet

Live branch split already visible inside `exp141`:

- candidate A stayed closer to the intended output-production loop, but after
  the narrower build/install repair it is now failing at the exact repo-test
  frontier on a concrete NumPy alias in `spacecurve.py` (`np.float`)
- candidate B is doing a more disciplined live-source confirmation before the
  next rebuild/install step:
  - confirm whether `pyknotid/make/torus.py` still says
    `from fractions import gcd` or now says `from math import gcd`
  - only then take the smallest required next rebuild/reinstall step and rerun
    the exact acceptance snippet from `/`
- control A widened into a broader rebuild/reinstall workflow that also asks
  for git-status / persistence proof
- control B is still spending turns on diagnosis-only reader work instead of
  moving directly on the live build/install frontier

Provisional interpretation before verifier results:

- `5e22108` is already pushing more work onto the real output-producing frontier
  than `main`
- if this wave comes back mixed, the next likely generalization is not about
  output production itself, but about what to do after that frontier is healthy:
  when the exact repo-test gate reopens a concrete compatibility alias, keep the
  loop on that exact failing code path instead of rediscovering install state
  or broadening back into diagnostics

### `exp141` outcome

Candidate:

- `5e22108` `fix: prefer direct output producers over broad installs`

Control:

- `35f7cd1` on `main`

Results:

- candidate A:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
  - but the remaining failures were already deeper than `main`: the old
    `fractions.gcd` frontier was gone and the run had reopened on the later
    `np.float` compatibility path
- candidate B:
  - `reward 0.0`
  - timeout
  - `8 passed / 3 failed`
  - remaining frontier: `fractions.gcd` in installed `torus.py` plus the repo
    test tail
- control A:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
  - remaining frontier still included both `np.float` and `fractions.gcd`
- control B:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
  - same mixed `np.float` plus `fractions.gcd` frontier as control A

Keep decision:

- `5e22108` is a real keep
- both candidate reps improved the frontier over `main` when judged by failure
  reason, not just count
- candidate B beat both controls outright
- candidate A tied the control count but had already eliminated the older
  `fractions.gcd` failure family and advanced to the deeper `np.float`
  compatibility frontier

Decisive split after the keep:

- the missing-output drift is now under better control
- the remaining instability is what happens after the operating-context gate has
  already proved the compiled/install outputs are present
- candidate A got farther downstream and reopened on a concrete compatibility
  alias in `spacecurve.py`
- candidate B spent more budget rediscovering whether the live `torus.py` patch
  had actually persisted before taking the next rebuild/reinstall step
- the next improvement should keep the loop on that exact reopened
  compatibility site once output/install proof is already in hand, instead of
  widening back into install-state rediscovery, source-state confirmation, or
  broader diagnosis

Checkpoint that followed:

- committed candidate `8013d36`
  `fix: stay on exact reopened compatibility sites`

### `exp142` launch

Candidate:

- `8013d36` `fix: stay on exact reopened compatibility sites`

Control:

- `35f7cd1` on `main`

Launch notes:

- rebuilt Harbor agent artifacts in both active and control worktrees with
  `bun run build:harbor-agent`
- launched from the same local Harbor path as the prior wave:
  direct `uv run harbor run` under each worktree's `inspo/harbor` with the
  worktree's `tools/harbor` on `PYTHONPATH`
- all four lanes source the repo-root
  `/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/.env`
- all four trial directories were created successfully, so the wave is valid

Harbor tmpdirs:

- candidate A: `/tmp/sprout-exp142-candidate-a.5VuvaW`
- candidate B: `/tmp/sprout-exp142-candidate-b.6pQmHh`
- control A: `/tmp/sprout-exp142-control-a.rlvM39`
- control B: `/tmp/sprout-exp142-control-b.U7MV3x`

Interim operational note while `exp142` is still in flight:

- re-checked the repo harness support after a user prompt to verify the local
  launch path was still the intended one
- `tools/harbor/README.md` still documents the canonical local workflow:
  rebuild with `bun run build:harbor-agent`, then run `uv run harbor run`
  under the chosen worktree's `inspo/harbor` with that worktree's
  `tools/harbor` on `PYTHONPATH`
- `inspo/harbor-runner` is the AWS spot runner, not the canonical local
  hill-climb harness
- that means the current local eval loop is on the right harness path; the
  current blocker is still run completion and failure-shape stability, not a
  wrong launcher family

Early branch split already visible inside `exp142` before Harbor wrote
`result.json`:

- candidate B reopened on a new concrete failure family:
  `SyntaxError: '(' was never closed` in `pyknotid/visualise.py`
- that is a worse and different frontier than the intended installed-context
  compatibility-site focus
- the wave therefore already contains at least one bad candidate lane even
  before the verifier files land

Next candidate prepared while `exp142` is still waiting on Harbor completion:

- live root cause from the `exp142` split:
  - candidate B patched `visualise.py` and only rechecked a few expected lines,
    but it never proved the edited file still parsed before continuing
  - candidate A widened back into prerequisite rediscovery (`Cython`, `pytest`,
    `pyproject.toml`) instead of holding the exact reopened compatibility site
- new engineer rule added:
  - after a local source repair that the next build, install, or verification
    step depends on, prove the edited file still passes the smallest direct
    integrity check before rebuild or reinstall
  - if that integrity check fails, keep the loop on that same file until the
    file-local breakage is repaired
- focused regression update:
  - relaxed prompt regression tests remain semantic anchors only
  - added anchor:
    `prove the edited file still passes the smallest direct integrity check before rebuild or reinstall`
- verification:
  - `bun test test/host/embedded-root.test.ts` red then green
  - `bun run build:harbor-agent`
  - `bun run precommit`

## March 22 `exp92` Live Wave

The next active candidate is `3cbce3b`.

Principle under test:

- if a previous run likely produced the needed proof but those proof lines are
  unavailable now, rerun the same authoritative gate in the real context and
  capture fresh evidence instead of blocking on missing historical output

Wave shape:

- candidate branch: `wip/active-eval-loop` at `3cbce3b`
- control branch: `main`
- task: `build-cython-ext`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5.4-mini`
  - `fast_reasoning_effort=medium`

Live tempdirs:

- `/tmp/sprout-exp92-candidate-a.DGi5on`
- `/tmp/sprout-exp92-candidate-b.VJmDSt`
- `/tmp/sprout-exp92-control-a.b8JFIY`
- `/tmp/sprout-exp92-control-b.CQnBoJ`

Early live signal:

- all four runs created trial dirs successfully
- all four produced growing `trajectory.json` files
- no `result.json` or verifier output yet at the time of this note

If this wave fails, the next likely root-cause question is whether the repair
loop is still allowing substitute proof paths to displace the authoritative gate
even after it reruns that gate.

## March 22 `exp92` Outcome

`exp92` was a discard.

Results:

- candidate A `3cbce3b`: `8 passed / 3 failed`, `AgentTimeoutError`
- candidate B `3cbce3b`: `2 passed / 9 failed`, `AgentTimeoutError`
- control A `main`: `3 passed / 8 failed`
- control B `main`: `3 passed / 8 failed`, `AgentTimeoutError`

Root cause of the candidate split:

- candidate A moved the frontier downstream:
  - compiled extensions were present in the installed environment
  - remaining failures were `cinvariants`, example usage, and repo tests
- candidate B regressed after a different turn shape:
  - it successfully rebuilt extensions in the source tree
  - then the exact snippet failed on a downstream consumer blocker
    (`vispy` / `plot_shell`)
  - while the installed package still lacked the required compiled deliverables,
    the loop changed build/install path and accepted a reinstall path that still
    left those deliverables absent
  - that let the open deliverable gap fall behind the downstream consumer
    blocker, and the run collapsed back to missing installed extensions

Next candidate principle:

- when the same authoritative gate shows both a still-missing required
  deliverable and a downstream consumer failure, keep the missing deliverable
  primary
- do not switch to a different build/install path that still leaves the
  required deliverable absent just because the downstream blocker looks easier
  to patch

## March 22 `exp93` Live Wave

Active candidate: `c9285b5`

Principle under test:

- when the same authoritative gate shows both a still-missing required
  deliverable and a downstream consumer failure, keep the missing deliverable
  primary
- do not switch to a different build/install path that still leaves the
  required deliverable absent just because the downstream blocker looks easier
  to patch

Wave shape:

- candidate branch: `wip/active-eval-loop` at `c9285b5`
- control branch: `main`
- task: `build-cython-ext`
- model shape unchanged:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5.4-mini`
  - `fast_reasoning_effort=medium`

Live tempdirs:

- `/tmp/sprout-exp93-candidate-a.kolhfy`
- `/tmp/sprout-exp93-candidate-b.ZakehB`
- `/tmp/sprout-exp93-control-a.kqjvyI`
- `/tmp/sprout-exp93-control-b.CywGZb`

Early live signal:

- all four runs launched cleanly
- all four created trial dirs and entered real agent execution
- no Harbor completion artifacts yet at the time of this note

## March 22 `exp93` Outcome

`exp93` was a discard.

Results:

- candidate A `c9285b5`: `7 passed / 4 failed`, `AgentTimeoutError`
- candidate B `c9285b5`: `7 passed / 4 failed`, `AgentTimeoutError`
- control A `main`: `8 passed / 3 failed`, no Harbor exception
- control B `main`: `8 passed / 3 failed`, `AgentTimeoutError`

What the surviving control path proved:

- the exact snippet was already green
- the compiled extensions were already built and installed into the target
  environment
- the remaining failures had collapsed to a narrow runtime family:
  - `np.int` compatibility fallout
  - missing `vassiliev_degree_3` / `vassiliev_degree_2` export path in
    `pyknotid.invariants`
  - repository-test fallout from that same local compatibility frontier

First real root cause:

- this was no longer a deliverable-production failure
- the engineer surfaced a partial-success report with explicit remaining test
  failures
- `tech-lead` / root accepted that report as a stopping point because one
  explicit acceptance proof was green
- the run stopped with language equivalent to “most of the way there” even
  though other named acceptance checks were still red

Next candidate principle:

- when the task names multiple explicit acceptance checks, one satisfied check
  does not turn the others into caveats
- treat a green snippet, install proof, or component proof as supporting
  evidence only while any other named acceptance check still fails or remains
  unrun
- keep the repair loop alive on the remaining named acceptance frontier instead
  of reporting partial completion upward

## March 22 Post-`exp93` Reset

After `exp93` lost to `main`, the active experiment branch was reset back onto a
`main` baseline inside the long-lived `active-eval-loop` worktree.

Supporting cleanup done at the same time:

- kept the notebook on the active branch instead of creating another worktree
- trimmed `test/host/embedded-root.test.ts` back to semantic prompt anchors
  instead of the older brittle exact-string checks

Next candidate principle from the control-A root cause:

- when the task names multiple explicit acceptance checks, one green check does
  not downgrade the others into caveats
- root and `tech-lead` must treat that green subset as supporting evidence only
  and keep the loop on the remaining named acceptance frontier

## March 22 `exp94` Live Wave

Active candidate: `7b25b85`

Principle under test:

- when the task names multiple explicit acceptance checks, one green check does
  not downgrade the others into caveats
- root and `tech-lead` must treat that green subset as supporting evidence only
  and keep the loop on the remaining named acceptance frontier

Wave shape:

- candidate branch: `wip/active-eval-loop-mainline` at `7b25b85`
- control branch: `main` at `35f7cd1`
- task: `build-cython-ext`
- model shape unchanged:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5.4-mini`
  - `fast_reasoning_effort=medium`

Live tempdirs:

- candidate A: `/tmp/sprout-exp94-candidate-a.jMBpZe`
- candidate B: `/tmp/sprout-exp94-candidate-b.8JIwhC`
- control A rerun: `/tmp/sprout-exp94-control-a-rerun.BUdKi0`
- control B rerun: `/tmp/sprout-exp94-control-b-rerun.nph6bJ`

Launch note:

- the first control launch used the wrong cwd for Harbor and died before agent
  startup because the `main` worktree does not carry its own `inspo/harbor`
  checkout
- the corrected control reruns now execute Harbor from the shared repo
  `inspo/harbor` while importing `sprout_agent` from the `main` worktree

Partial live signal so far:

- candidate B finished first at `7 passed / 4 failed`, no Harbor exception
- remaining candidate-B frontier:
  - `np.int` in `ccomplexity`
  - `fractions.gcd` still alive in `cinvariants`, example usage, and repo tests
- root did not falsely close the task on candidate B:
  - it surfaced the remaining blockers explicitly instead of reporting
    completion
- control B later finished worse at `6 passed / 5 failed`, no Harbor exception
  - it regressed to `Knot.gauss_code` / export-path fallout in addition to
    missing installed extension proof
- candidate A and control A were still running at the time of this note

## March 22 `exp94` Outcome

`exp94` was a discard.

Results:

- candidate A `7b25b85`: `9 passed / 2 failed`, `AgentTimeoutError`
- candidate B `7b25b85`: `7 passed / 4 failed`, no Harbor exception
- control A `main`: `10 passed / 1 failed`, `AgentTimeoutError`
- control B `main`: `6 passed / 5 failed`, no Harbor exception

What changed:

- the acceptance-closure wording did move one branch in the intended direction:
  - candidate B did not falsely close on a green subset
  - it surfaced explicit remaining blockers instead
- but the change was not stable and did not beat the best `main` control

First real candidate split:

- candidate A fell into an editor-versus-shell contradiction loop
  - an editor branch reported successful source repairs
  - shell-level verification in the same workspace still showed the old lines
  - root kept the run alive, but it never recovered to a stable authoritative
    live repair path
  - that branch eventually regressed hard enough to break the NumPy invariant
    and lose installed deliverables
- candidate B stayed more honest about open blockers
  - but it still stalled above the best control frontier

Best control frontier:

- control A reached the narrowest remaining failure:
  - `10 passed / 1 failed`
  - only `test_ccomplexity` remained red
- the last failure was still a direct NumPy alias site in
  `pyknotid/representations/representation.py`

Root cause from the best control:

- the run was still too literal about “patch the first active site, rerun, then
  patch the next site”
- it patched line 500 in the local `n.int` block, reran the full gate, then
  discovered line 501 in the same block as the next failure
- that is a local same-family closure failure, not a discovery failure

Next candidate principle:

- when the active gate names a local code block with one same-family failure and
  the adjacent lines in that block share the same obsolete construct, close the
  local same-family block in one bounded pass before rerunning the expensive
  gate
- keep that bounded pass local:
  - same file
  - same block
  - same failure family
  - no wider sweep until the gate proves it is needed

## March 22 `exp95q` Live Wave

Active candidate: `361072b`

Principle under test:

- when the active gate names one local site and the adjacent lines in that same
  block clearly use the same obsolete construct, close that local same-family
  block in one bounded pass before paying for another full rerun of the same
  expensive gate

Wave shape:

- candidate branch: `wip/active-eval-loop-mainline` at `361072b`
- control branch: `main` at `35f7cd1`
- task: `build-cython-ext`
- model shape unchanged:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5.4-mini`
  - `fast_reasoning_effort=medium`

Live tmpdirs:

- candidate A: `/tmp/sprout-exp95q-candidate-a.WMbRjn`
- candidate B: `/tmp/sprout-exp95q-candidate-b.gYeTvk`
- control A: `/tmp/sprout-exp95q-control-a.SWQtbs`
- control B: `/tmp/sprout-exp95q-control-b.YlXPdE`

Launch note:

- detached launcher attempts were discarded as infra noise
- the valid wave is the direct four-session Harbor batch above
- all four runs created trial dirs successfully before this note was written

Interim result hygiene:

- original candidate A is junk signal and should not be counted against `361072b`
- it never established `/app/pyknotid` in the task container
- verifier therefore failed at the pre-product frontier:
  - `/app/pyknotid does not exist`
  - `pyknotid is not installed`
  - all extension imports missing
- this matches the earlier spawner-timeout smell from the tiny trajectory and
  should be treated as infra/startup noise, not a meaningful product outcome
- replacement candidate A was launched at
  `/tmp/sprout-exp95q-candidate-a-r1.xmTMRM` and is the real second candidate
  rep for judging this wave

Partial frontier read from finished lanes:

- candidate B did not beat the best control on score or termination
  - candidate B: `7 passed / 4 failed`, timeout
  - control B: `8 passed / 3 failed`, timeout
- but the failure reasons diverged in a useful way:
  - control B still failed at the earlier installed-path `fractions.gcd`
    frontier in `pyknotid/make/torus.py`
  - candidate B pushed through that frontier and exposed later installed-path
    NumPy alias debt in `spacecurve.py`, `ccomplexity.pyx`, and related runtime
    paths
- that means `361072b` is not a clean keep, but it is useful diagnosis:
  - local same-block closure can move the run downstream
  - the next likely win is a bounded same-family closure across the already
    named installed-path file set, not another strictly single-site repair rule

Final `exp95q` outcome:

- candidate commit `361072b` is a discard
- original candidate A stayed junk and was excluded
- replacement candidate A regressed badly:
  - `3 passed / 8 failed`
  - timed out
  - it widened into runtime dependency churn around `sympy` / `vispy` and then
    failed through `pyknotid.visualise` / `openknot.py`, losing the compiled
    extension frontier
- candidate B was better but still not promotable:
  - `7 passed / 4 failed`
  - timed out
  - it pushed past the old `fractions.gcd` frontier and exposed later
    installed-path NumPy alias debt
- best control remained stronger:
  - control B `8 passed / 3 failed`
  - timed out
  - still stalled one blocker earlier at installed-path `fractions.gcd`

Decision:

- do not keep `361072b`
- keep only the diagnostic lesson:
  - once the target-context gate has already named a small same-family file
    set, the next likely improvement is a bounded closure across that named
    set

Next candidate:

- commit `8daa738` tests that principle
- `exp96r` is the live `2x2`:
  - candidate: `8daa738`
  - control: `main` at `35f7cd1`

## March 22 `exp96r` Keep

Keep:

- commit `8daa738` is a real keep

Wave result:

- candidate A `8daa738`:
  - `9 passed / 2 failed`
  - no Harbor exception
- candidate B `8daa738`:
  - `9 passed / 2 failed`
  - `AgentTimeoutError`
- control A `main`:
  - `3 passed / 8 failed`
  - `AgentTimeoutError`
- control B `main`:
  - `6 passed / 5 failed`
  - `AgentTimeoutError`

Why this counts as a keep:

- both candidate reps beat both controls on the same task
- one candidate rep removed the Harbor exception entirely
- the remaining frontier is narrow and stable in the candidate:
  - `test_example_usage`
  - `test_pyknotid_repository_tests`

Engineering lesson confirmed:

- when the authoritative target-context gate has already named a small
  same-family file set, a bounded closure across that named set is better than
  single-site rerun churn
- keeping that closure bounded to the already named installed-path set avoids
  drifting into repo-wide compatibility hunts while still pushing the run
  materially downstream

Next task after the keep:

- `constraints-scheduling`
- Why this next:
  - fresh local frontier with no prior Harbor runs
  - different task shape from build/install repair loops
  - stresses read-only inputs, exact structured output, hard constraints,
    minute-level earliest-slot selection, and preference tie-break discipline

## March 22 `exp97` Constraints Scheduling

Result:

- no new keep
- current branch split:
  - candidate A failed
  - candidate B passed cleanly
- both `main` controls passed cleanly

Failure reason:

- the failing candidate scheduled `2024-01-16 12:00 UTC`
- that satisfied hard constraints but violated the tie-break preference for
  Alice's morning when a valid morning option existed

Decision:

- do not treat `constraints-scheduling` as a new win for the current branch
- do not hill-climb this task now because `main` already passes reliably
- move to the next untouched frontier instead

Next task after `constraints-scheduling`:

- `nginx-request-logging`
- Why:
  - also untouched locally
  - different operational/configuration shape from both
    `build-cython-ext` and `constraints-scheduling`

## March 22 `exp98` Nginx Request Logging

Result:

- no new keep
- both current-branch candidate reps passed cleanly
- both `main` controls passed cleanly

Wave result:

- candidate A current branch:
  - verifier green
  - reward `1.0`
  - no Harbor exception
- candidate B current branch:
  - verifier green
  - reward `1.0`
  - no Harbor exception
- control A `main`:
  - verifier green
  - reward `1.0`
  - no Harbor exception
- control B `main`:
  - verifier green
  - reward `1.0`
  - no Harbor exception

Decision:

- treat `nginx-request-logging` as a clean non-regression only
- do not hill-climb it further because both branch and control already solve it
- move immediately to a fresh unsolved frontier

Next task after `nginx-request-logging`:

- `db-wal-recovery`
- Why:
  - still untouched locally
  - likely to exercise recovery discipline and bounded closure behavior without
    collapsing back into the same exact install/compile loop as
    `build-cython-ext`

## March 22 `exp99` DB WAL Recovery

Result:

- new real frontier
- both `main` controls failed without producing `/app/recovered.json`
- current branch split:
  - candidate A also failed without `/app/recovered.json`
  - candidate B produced a valid sorted JSON file, but only with the 5 base
    rows from `main.db`

Wave result:

- candidate A current branch:
  - reward `0.0`
  - no Harbor exception
  - failed at missing `/app/recovered.json`
- candidate B current branch:
  - reward `0.0`
  - no Harbor exception
  - passed existence/shape/sort checks
  - failed completeness with only 5 recovered rows
- control A `main`:
  - reward `0.0`
  - no Harbor exception
  - failed at missing `/app/recovered.json`
- control B `main`:
  - reward `0.0`
  - no Harbor exception
  - failed at missing `/app/recovered.json`

Root cause:

- the fresh failure is not ordinary JSON production
- it is preservation of a consumable evidence source
- candidate B's replay shows that one early probe saw `/app/main.db-wal` as a
  16512-byte `data` file, then parallel `sqlite3` inspection against the live
  database ran before WAL forensics completed
- subsequent probes found `/app/main.db-wal` gone and the run fell back to the
  5 base rows from `main.db`

Engineering lesson:

- when a task depends on transient sidecars or another consumable evidence set,
  preserve the full evidence set first and inspect copies before running any
  stateful reader that could checkpoint, normalize, or otherwise consume the
  live originals
- do not split that evidence set across parallel probes

Next candidate after `exp99`:

- commit `0dc73dc` `fix: preserve consumable evidence before stateful probes`

## March 22 `exp100` DB WAL Recovery

Result:

- no keep
- both `main` controls still failed flat without producing
  `/app/recovered.json`
- the candidate changed the shape of one rep but not reliably

Wave result:

- candidate A `0dc73dc`:
  - reward `0.0`
  - no Harbor exception
  - preserved both `main.db` and `main.db-wal` into artifacts
  - still failed without producing recovered output
- candidate B `0dc73dc`:
  - reward `0.0`
  - no Harbor exception
  - regressed to the same flat no-output failure as `main`
- control A `main`:
  - reward `0.0`
  - no Harbor exception
  - failed at missing `/app/recovered.json`
- control B `main`:
  - reward `0.0`
  - no Harbor exception
  - failed at missing `/app/recovered.json`

Root cause:

- the consumable-evidence rule took effect in one candidate rep, but not
  reliably enough
- the missing layer was the architect/orchestration investigation frame
- one rep still delegated live investigation early enough to allow the same
  evidence-loss shape

Engineering lesson:

- if transient or consumable evidence must survive investigation, the snapshot
  requirement has to exist at the investigation-planning layer too, not only in
  engineer and command-runner leaf behavior

Next candidate after `exp100`:

- commit `db733f2` `fix: snapshot consumable evidence during investigation`

## March 22 `exp101` DB WAL Recovery Launcher Root Cause

Result:

- the original `exp101` batch was invalid
- the Harbor runs did not fail on product behavior
- they failed because the launch mechanism was wrong for this tool runtime

Root cause:

- launching Harbor through detached `nohup ... &` child processes from
  `exec_command` is not reliable here
- when the `exec_command` parent exits, the tool runtime cleans up that process
  tree
- the result is an empty tmpdir with only `run.sh` and `launcher.log`, even
  though the same `run.sh` starts Harbor correctly in the foreground

Evidence:

- foreground `bash run.sh ...` created Harbor job state immediately
- `nohup /bin/bash run.sh ... </dev/null &` created no Harbor job state and left
  an empty zero-byte `launcher.log`
- the detached child processes were gone when inspected with `ps`

Engineering lesson:

- this environment needs a persistent supervisor shell for multi-run local
  Harbor waves
- detached child launches are not trustworthy experiment infrastructure here

## March 22 `exp102` DB WAL Recovery

Current state:

- relaunch in progress from a single persistent supervisor shell
- candidate branch: `wip/active-eval-loop` at `db733f2`
- control branch: `main`
- task: `db-wal-recovery`

Live tempdirs:

- `/tmp/sprout-exp102-candidate-a.I9YBsq`
- `/tmp/sprout-exp102-candidate-b.aZSTHA`
- `/tmp/sprout-exp102-control-a.xvjl3b`
- `/tmp/sprout-exp102-control-b.y2jVH5`

Early signal:

- all four runs created trial dirs successfully
- the wave is being held open by one persistent supervisor shell instead of
  detached child launches
- only `trial.log` exists so far; agent-state artifacts have not materialized
  yet at the time of this note

## March 22 `exp102` DB WAL Recovery Outcome

Result:

- discard
- both candidate reps failed without producing `/app/recovered.json`
- controls split:
  - one control failed the same no-output way
  - one control still produced the 5 base rows

Wave result:

- candidate A `db733f2`:
  - no Harbor exception
  - verifier failed all 7 checks
  - no `/app/recovered.json`
- candidate B `db733f2`:
  - no Harbor exception
  - verifier failed all 7 checks
  - no `/app/recovered.json`
- control A `main`:
  - no Harbor exception
  - verifier passed existence/shape/sort but failed completeness
  - recovered only the 5 base rows
- control B `main`:
  - no Harbor exception
  - verifier failed all 7 checks
  - no `/app/recovered.json`

Root cause:

- the architect-layer snapshot rule was bypassed on the losing candidate path
- root still treated this as a generic unfamiliar-files task and delegated
  `project-explorer` first
- that exploration phase consumed the only early window where `/app/main.db-wal`
  was still visible
- by the time the debugger started, `/app/main.db-wal` was already absent, so
  the run could only fail or fall back to the 5 base rows

Engineering lesson:

- transient-evidence tasks are not ordinary "understand the codebase first"
  tasks
- the snapshot-first rule must exist at the root routing layer
- root has to route transient-evidence recovery tasks into snapshot-aware
  investigation before generic project exploration can delay or displace that
  prerequisite

Next candidate after `exp102`:

- commit `13bca98` `fix: snapshot transient evidence before exploration`

## March 22 `exp103` DB WAL Recovery

Wave shape:

- candidate branch: `wip/active-eval-loop-mainline` at `13bca98`
- control branch: `main`
- task: `db-wal-recovery`

Tempdirs:

- candidate A: `/tmp/sprout-exp103-candidate-a.aUKX1t`
- candidate B: `/tmp/sprout-exp103-candidate-b.2sFhwZ`
- control A: `/tmp/sprout-exp103-control-a.Nj1P1H`
- control B: `/tmp/sprout-exp103-control-b.0J4PdP`

Outcome:

- mixed, not a keep
- control A and control B both recovered only the 5 base rows
- candidate A regressed to no `/app/recovered.json`
- candidate B materially improved the frontier:
  - recovered 11 ids
  - failed only the WAL overlay semantics for existing ids

Verifier shape:

- controls:
  - `/tmp/sprout-exp103-control-a.Nj1P1H/.../verifier/test-stdout.txt`
  - `/tmp/sprout-exp103-control-b.0J4PdP/.../verifier/test-stdout.txt`
  - both passed existence/shape/sort and failed completeness at the 5-row
    baseline
- candidate A:
  - `/tmp/sprout-exp103-candidate-a.aUKX1t/.../verifier/test-stdout.txt`
  - all 7 checks failed because no `/app/recovered.json` was written
- candidate B:
  - `/tmp/sprout-exp103-candidate-b.2sFhwZ/.../verifier/test-stdout.txt`
  - passed existence/shape/sort/id coverage
  - failed because WAL updates for existing ids were not applied
  - concrete mismatch:
    - expected `id=1 value=150`
    - recovered `id=1 value=100`

What `13bca98` definitely improved:

- root no longer routed this transient-evidence task through
  `project-explorer` first
- candidate roots delegated directly to `debugger` with snapshot-first
  instructions
- that removed the previous evidence-loss failure mode where the early WAL
  window was consumed by generic exploration

Root cause of the candidate split:

- candidate A preserved the evidence but still stopped too early
- its debugger proved:
  - the WAL was nonstandard
  - the bytes were low-entropy / structurally suggestive enough to merit
    deeper work
  - but it stopped at passive inspection and reported the 11-row recovery as
    unverifiable
- candidate B kept going after that same frontier
- it escalated into bounded byte-level transform search and found a trivial
  reversible transform:
  - single-byte XOR with key `0x42`
- that transform exposed the missing WAL-derived rows

Engineering lesson:

- preserving transient evidence was necessary but not sufficient
- once opaque binary evidence is proven nonrandom and structurally suggestive,
  passive inspection is not enough
- bounded reversible-transform search is part of the root-cause workflow there,
  not optional cleverness

Next candidate after `exp103`:

- add a general reversible-transform rule to the execution layer
- if opaque binary evidence is nonstandard but clearly nonrandom and still
  structurally close to the target format, try the smallest bounded reversible
  transform family before concluding that the missing data is unrecoverable

## March 22 `exp104` DB WAL Recovery

Wave shape:

- candidate branch: `wip/active-eval-loop-mainline` at `26506d9`
- control branch: `main`
- task: `db-wal-recovery`

Tempdirs:

- candidate A: `/tmp/sprout-exp104-candidate-a.0Zlrhv`
- candidate B: `/tmp/sprout-exp104-candidate-b.RAa4oZ`
- control A: `/tmp/sprout-exp104-control-a.y3bE7v`
- control B: `/tmp/sprout-exp104-control-b.9aadXY`

Outcome:

- mixed, not a keep
- candidate B passed cleanly with reward `1.0`
- candidate A regressed to no `/app/recovered.json`
- control A failed all checks
- control B stayed at the 5-row baseline

What `26506d9` definitely improved:

- the bounded reversible-transform rule is real
- the passing candidate found the trivial XOR transform on the preserved WAL
  copy and recovered the full 11-row dataset
- both controls still lost on the old frontier, so the new rule added real
  capability

Root cause of the candidate split:

- the failing candidate did not merely "lose track" of preserved evidence
- it preserved `/app/snapshot_evidence/main.db-wal`, then a later repair branch
  opened both `/app/main.db` and `/app/snapshot_evidence/main.db` through normal
  writable `sqlite3.connect(...)` inspection rather than explicit read-only
  access or fresh disposable working copies
- that inspection consumed the WAL sidecars, so the same branch later saw:
  - `/app/main.db-wal` missing
  - `/app/snapshot_evidence/main.db-wal` missing
- after that, it escalated as if the evidence had disappeared

The passing candidate avoided that failure mode:

- it preserved evidence in a unique snapshot directory
- it used explicit `sqlite3 -readonly` inspection on preserved evidence
- it only mutated fresh working copies during XOR decode and WAL replay

Engineering lesson:

- preserving transient evidence is still not sufficient if preserved copies are
  later treated as mutable working state
- preserved transient evidence must become the authoritative immutable source
- stateful readers like SQLite must use explicit read-only access on preserved
  evidence, or else operate on fresh disposable working copies made from it
- if a disposable working copy later loses a sidecar or journal, the loop
  should restart from preserved evidence rather than reporting that the
  preserved evidence disappeared

Next candidate after `exp104`:

- add an execution-layer immutability rule for preserved transient evidence
- require read-only access on preserved copies whenever the tool supports it
- require fresh disposable working copies for stateful tools that cannot
  guarantee read-only behavior

`exp105b` provisional read while candidate lanes were still finishing:

- candidate B reached the correct product behavior and wrote `/app/recovered.json`
  with all 11 recovered rows
- candidate A still failed early, but the failure frontier moved again

Root cause of the new failing candidate split:

- the failing debugger lane preserved bytes but broke the file-set identity that
  SQLite uses to discover companion files
- it copied `/app/main.db` to `/tmp/main.db.ro` and `/app/main.db-wal` to
  `/tmp/main.db-wal.ro`
- for the copied database, SQLite would look for a sibling WAL named
  `/tmp/main.db.ro-wal`, so the preserved WAL was effectively detached from the
  copied DB
- that detached snapshot then produced a false partial view of the evidence and
  the lane later escalated as if the WAL had disappeared or had no effect

Engineering lesson:

- preserving transient evidence is still not sufficient if the snapshot breaks
  the neighboring-path or basename relationship that tools use to discover
  companion files
- preserved copies and disposable working copies must keep the full related file
  set together under the names the tool expects
- a detached sidecar under an ad hoc name is supporting evidence at best; it is
  not proof that the real companion data is absent or irrelevant

`exp106` early root-cause read:

- the companion-file identity rule took at snapshot time: the failing candidate
  preserved `/app/analysis_snapshot/main.db-wal` under the correct sibling name
- but the same candidate still opened the preserved snapshot with normal
  `sqlite3.connect(...)` calls during symptom reproduction
- that writable/stateful open checkpointed the preserved WAL to zero bytes
- later steps then saw `main.db-wal` as empty and misdiagnosed the preserved
  evidence as intrinsically truncated

Engineering lesson:

- preserving names and adjacency is still not enough if a later \"normal open\"
  step is allowed to run against the preserved copy itself
- immutable preserved evidence and normal-open reproduction must stay in
  separate contexts
- if the investigation needs to reproduce ordinary stateful tool behavior, that
  reproduction belongs on a fresh disposable working copy derived from the
  preserved evidence, never on the preserved evidence itself

`exp106` outcome:

- candidate B under `6de37b2` passed cleanly on `db-wal-recovery`
- control B still failed at the old 5-row frontier (`2 failed, 5 passed`)
- control A still failed to produce `/app/recovered.json`
- candidate A still regressed to the 5-row frontier because it mutated the
  preserved snapshot during \"normal open\" symptom reproduction

Interpretation:

- `6de37b2` is directionally real, not noise
- preserving companion-file identity helped a winning branch stay on the true
  XOR-decoding/recovery path
- but it is not stable enough by itself, because another branch still treated a
  normal `sqlite3.connect(...)` probe on the preserved snapshot as acceptable
  and checkpointed the preserved WAL away

Next candidate after `exp106`:

- keep preserved evidence immutable even when reproducing the tool's ordinary
  behavior
- if we need to see what a normal/writable open does, do that only on a fresh
  disposable working copy made from preserved evidence

`exp109` Git Leak Recovery:

- no new keep
- both active-branch candidate reps passed cleanly
- the checked `main` control also passed cleanly

Decision:

- treat `git-leak-recovery` as a non-regression only
- do not hill-climb it further because the active branch did not open a new
  capability gap relative to `main`

Next task after `git-leak-recovery`:

- `log-summary-date-ranges`
- Why:
  - different task family from the recovery/evidence loop
  - directly exercises one of the older unresolved structured-field /
    date-bucket failure modes

`exp111` / `exp112` local Harbor launcher root-cause note:

- The repo still supports the same local Harbor path documented in:
  - `docs/superpowers/plans/2026-03-16-terminal-bench-functionality-batch.md`
  - `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`
- The initial failure was not Harbor itself.
- Two separate launcher mistakes were mixed together:
  - I reintroduced shell-quoting drift while trying to background runs.
  - More importantly, detached background children launched through the Codex
    exec harness do not survive reliably after the parent exec exits.
- A direct foreground probe with the canonical repo-root command proved the real
  local behavior:
  - `uv run harbor run ...` is silent for roughly a minute before the job
    directory appears.
  - judging local Harbor from the first 10-20 seconds was wrong.
- Operational correction:
  - run local Harbor evals in long-lived exec sessions
  - monitor `jobs-dir`, `trajectory.json`, `result.json`, and verifier artifacts
    instead of wrapper PIDs or early silence

`exp112` `log-summary-date-ranges` read:

- No new keep.
- The task is currently noisy on both active and `main`.
- Settled lanes:
  - active candidate B: clean pass, reward `1.0`
  - main control A: clean fail, reward `0.0`
    - first real miss: stopped after a first-pass filename-pattern check and
      never widened to inspect the actual files under `/app/logs`
    - verifier failed because `/app/summary.csv` was never created
  - main control B: clean pass, reward `1.0`
- Active candidate B took a better path than the failing control:
  - widened from the initial filename probe
  - found the real `YYYY-MM-DD_<source>.log` files
  - sampled bracketed severity tokens like `[ERROR]`
  - wrote `/app/summary.csv`
  - passed verifier
- Because `main` also has a clean pass on the same task shape, this wave is not
  evidence of a new active-branch improvement. Treat it as split/noise and move
  outward instead of hill-climbing this task.

`exp112` candidate A failure reason:

- candidate A did not just miss the output file; it produced the wrong summary
  counts
- verifier saw rows like `["month_to_date", "ERROR", "0"]` where the expected
  count was `4682`
- that means the branch widened past filename discovery but still failed to
  extract the real bracketed severity/date data correctly
- classify this as another noisy branch, not a new capability gap relative to
  `main`

Next task after `log-summary-date-ranges`:

- `multi-source-data-merger`
- Why:
  - still part of the original broad local-functionality batch
  - different task family from the date-bucket log summarization path
  - good check for whether the active branch still helps on a structured
    multi-input merge task

`exp113` `multi-source-data-merger` early read:

- still no new keep
- settled lanes so far:
  - active candidate B: clean pass, reward `1.0`
  - main control A: clean pass, reward `1.0`
- pending lanes:
  - active candidate A
  - main control B
- both pending lanes are still running in live Docker containers
- both pending lanes already wrote `agent-state/trajectory.json` snapshots with
  `final_metrics`, but Harbor has not yet written verifier output or job-level
  `result.json`
- current best interpretation:
  - this task likely behaves like `exp112`: active and `main` both have clean
    passes available
  - the remaining question is whether the hanging lanes expose a reusable
    control-flow defect or just more run-to-run noise

Operational note from `exp113`:

- local Harbor can leave containers running long after trajectory snapshots look
  complete
- for these lanes, empty `job.log` and empty container logs are not enough to
  call them dead
- live-container state plus missing verifier/result artifacts means the run is
  still active until proven otherwise

`exp113` hang signature and runtime root cause:

- the two stuck lanes (`candidate A`, `control B`) both froze after a final
  `llm_start` event with no matching `llm_end`
- one stalled on `gpt-5-mini`, the other on `gpt-5.4`
- their Docker containers stayed live for many minutes with no verifier output
  and no job-level `result.json`
- the agent layer already races LLM calls against an abort signal, but the
  OpenAI adapter dropped both timeout and signal when calling
  `client.responses.create(...)`
- that means a provider stall before the first response object or first stream
  chunk can pin the underlying SDK request even after the agent decides the turn
  should be over

Fix candidate after `exp113`:

- active branch runtime change in `src/llm/openai.ts`
- forward the existing request abort signal into OpenAI `responses.create(...)`
- add a bounded OpenAI request timeout so pre-stream stalls do not hang Harbor
  lanes indefinitely
- targeted regressions added in `test/llm/openai.test.ts` and verified green

`exp114` `multi-source-data-merger` result and next root cause:

- after the OpenAI timeout/signal fix, both active candidate lanes reached the
  correct output (`reward 1.0` / green verifier), while both `main` control
  lanes still failed correctness
- this is real functional progress, but not yet a clean keep, because the
  winning candidate lanes still ended with `AgentTimeoutError`
- the remaining timeout is no longer a provider-stall problem; it is a
  workflow-closing problem after decisive task proof already exists

`exp114` decisive orchestration finding:

- the first wrong turn happens above `tech-lead`
- root delegated the task as if it were necessarily a code-review pipeline and
  explicitly framed the handoff as something to send through spec review and
  quality review
- that framing prevented the shorter operational/artifact path from taking over
  even after decisive external acceptance proof existed
- later, `tech-lead` also allowed supporting review work to keep the task open
  after the authoritative gate was already satisfied

Next candidate after `exp114`:

- root should delegate to `tech-lead` with the workflow that matches the actual
  acceptance mode instead of assuming every code-editing task needs the full
  review ceremony
- if a task is primarily artifact/data production or an external verifier/snippet/
  runtime check is the authoritative gate, root should say that explicitly and
  avoid pre-committing `tech-lead` to spec/quality review
- once decisive correctness evidence from the authoritative external gate
  exists and no unresolved ambiguity remains, supporting reviews must not keep
  the task open

`exp115` `multi-source-data-merger` confirmation:

- candidate commit `dd15817` is a real keep on this task family
- candidate lanes:
  - candidate A: clean pass, reward `1.0`, no exception
  - candidate B: clean pass, reward `1.0`, no exception
- main control lanes:
  - control A: failed, reward `0.0`
  - control B: clean pass, reward `1.0`, no exception
- interpretation:
  - `main` can still pass this task, but it is materially less reliable
  - the active branch improvement is reliability, not just a lucky single lane
  - the accepted general rule is:
    - root must delegate to `tech-lead` with the workflow that matches the
      authoritative acceptance mode
    - artifact- or data-production tasks must not be pre-committed to the full
      spec-review / quality-review ceremony
    - once decisive external proof exists and no unresolved ambiguity remains,
      supporting review must not keep the task open

Operational note from `exp115`:

- worktrees do not carry the ignored `inspo/harbor` checkout
- for local control runs, the correct pattern is:
  - build the agent binary inside the worktree being tested
  - run Harbor from the shared repo checkout
  - point `PYTHONPATH` at the specific worktree's `tools/harbor`

Next task after `multi-source-data-merger`:

- `vulnerable-secret`
- reason:
  - it is still in the original broad local-functionality batch
  - it exercises a different task family from the artifact/data merge path
  - it is a good test of whether the new workflow-closing keep helps only the
    current task or improves broader benchmark reliability

`exp116` `vulnerable-secret` generalization check:

- candidate branch: `wip/active-eval-loop-mainline` at `dd15817`
- control branch: `main`
- task: `vulnerable-secret`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- run shape:
  - Harbor executed from the shared repo checkout
  - `PYTHONPATH` pointed at the branch-specific `tools/harbor`
  - this kept the tested branch isolated without depending on ignored
    `inspo/harbor` contents inside a worktree

`exp116` outcome:

- candidate A: clean pass, reward `1.0`, no exception
- candidate B: clean pass, reward `1.0`, no exception
- control A: clean pass, reward `1.0`, no exception
- control B: clean pass, reward `1.0`, no exception

Interpretation:

- `dd15817` did not buy a reliability edge on `vulnerable-secret`
- it also did not regress the task
- this is neutral generalization signal:
  - the `multi-source-data-merger` keep appears task-family-specific so far
  - `vulnerable-secret` is already robust enough that the workflow-closing
    improvement does not change the result distribution

Operational decision after `exp116`:

- stop using ad hoc detached shell launch patterns when the repo already has a
  documented local Harbor workflow
- prefer:
  - build the agent binary in the branch being tested
  - run `uv run harbor run` from the shared Harbor checkout
  - track completion from trial `result.json` and verifier artifacts

Next task after `vulnerable-secret`:

- `log-summary-date-ranges`
- reason:
  - it was one of the original broad-batch failures
  - its frontier was artifact semantics, not secret extraction
  - it is a better test of whether `dd15817` helps tasks whose acceptance gate
    is an externally checked output artifact

`exp117` `log-summary-date-ranges` generalization check:

- candidate branch: `wip/active-eval-loop-mainline` at `dd15817`
- control branch: `main`
- task: `log-summary-date-ranges`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- run shape:
  - same documented local Harbor workflow as `exp116`
  - Harbor from the shared checkout
  - branch-specific `PYTHONPATH` for `tools/harbor`

`exp117` outcome:

- candidate A: clean pass, reward `1.0`, no exception
- candidate B: clean pass, reward `1.0`, no exception
- control A: clean pass, reward `1.0`, no exception
- control B: clean pass, reward `1.0`, no exception

Interpretation:

- this is another neutral generalization check
- `dd15817` does not improve a task family that is already robust on `main`
- the candidate and control reached the same accepted artifact outcome
- the interesting branch-local behavior difference was earlier in the repair
  path:
  - one candidate lane recovered from a shell-script stumble by transforming an
    already-produced artifact into the exact verifier shape
  - control lanes delegated the counting/writing path more conservatively
  - despite different internal routes, the final benchmark outcome was still
    `4/4` clean green

Operational note from `exp117`:

- local Harbor startup for this task can spend over a minute in container
  bootstrap before `trajectory.json` appears
- empty `job.log`, empty `trial.log`, and missing `trajectory.json` are not by
  themselves evidence of a dead run during that setup window
- the decisive liveness check was the container process table inside the local
  Docker environment

Next task after `log-summary-date-ranges`:

- `sqlite-db-truncate`
- reason:
  - it still ends in an externally verified artifact, so the acceptance-mode
    keep remains relevant
  - it requires more recovery work than the already-robust ops tasks
  - it is a better chance of seeing whether `dd15817` matters once the task is
    not already trivially green on `main`

`exp118` `sqlite-db-truncate` regression check:

- candidate branch: `wip/active-eval-loop-mainline` at `dd15817`
- control branch: `main`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- run shape:
  - same documented local Harbor workflow as `exp116` and `exp117`
  - Harbor from the shared checkout
  - branch-specific `PYTHONPATH` for `tools/harbor`

`exp118` outcome:

- candidate A: reward `0.0`, no exception, verifier score `0`
- candidate B: reward `0.0`, no exception, verifier score `0`
- control A: reward `0.0`, no exception, verifier score `6`
- control B: reward `0.0`, no exception, verifier score `2`

Interpretation:

- `dd15817` regresses this recovery task family relative to `main`
- the active branch closes too easily on a plausible-looking recovery artifact
  even when the recovered values are not grounded by decisive source evidence
- `main` is still not good enough to pass the task, but it holds the repair
  loop on structure-aware evidence much longer and materially outperforms the
  active branch
- this is not a close call:
  - both active lanes produced `0` exact tuple matches
  - `main` recovered `6` matches in one lane and `2` in the other

Root-cause note from `exp118`:

- the current workflow-closing keep overgeneralizes from "artifact exists and
  external gate is authoritative" to "plausible-looking artifact is good enough
  to report"
- on recovery tasks, that is wrong
- a shape-correct JSON artifact with guessed normalization, placeholder values,
  null padding, or heuristic fill-in is still supporting evidence only until
  the recovered values themselves are tied back to the named input evidence

Prompt fix after `exp118`:

- strengthen root delegation so recovery or extraction tasks require proof that
  output values are grounded by the named input evidence
- strengthen `tech-lead` so best-effort recovery, heuristic fill-in, guessed
  normalization, or null-padded artifacts cannot close the task without
  source-grounded proof

Next task after `exp118`:

- rerun `sqlite-db-truncate`
- reason:
  - this is the right local confirmation target for the new guardrail
  - the failure family is now specific and repeatable
  - moving to a new task before retesting would throw away clean causal signal

`exp119` `sqlite-db-truncate` rerun after heuristic-recovery guardrail:

- candidate branch: `wip/active-eval-loop-mainline` at `70f0cfc`
- control branch: `main`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`

`exp119` outcome:

- candidate A: reward `0.0`, no exception, verifier score `6`
- candidate B: reward `0.0`, no exception, verifier score `0`
- control A: reward `0.0`, no exception, verifier score `0`
- control B: clean pass, reward `1.0`, no exception

Interpretation:

- `70f0cfc` is not a keep
- the new guardrail changed behavior in the right direction but was not stable
- candidate B avoided the old plausible full-artifact failure and stopped at a
  smaller grounded subset
- candidate A got materially closer to the pass threshold than the old
  candidate baseline by recovering `6` exact rows
- but `main` still won the batch because one control lane passed cleanly

Root-cause note from `exp119`:

- candidate A decoded the last two rows correctly from the bytes:
  - `testword08 -> 99.99`
  - `testword09 -> 0.5`
- it then discarded them because it treated the user's integer-shaped example
  (`"value": M`) as an implicit integer-only domain constraint
- that is the wrong abstraction:
  - the example defines schema shape
  - it does not silently narrow the allowed value domain when direct source
    evidence establishes additional values of the same field
- control B continued on the established structure-aware path and kept the
  float rows, which is why it passed

Prompt fix after `exp119`:

- root: for recovery tasks, treat example rows or sample values as schema-shape
  guidance, not a hidden value-domain restriction, unless the caller
  explicitly constrains the domain or type
- `tech-lead`: when direct source evidence recovers additional values that
  still fit the required schema, do not exclude them just because the example
  was narrower or integer-shaped

Next task after `exp119`:

- rerun `sqlite-db-truncate`
- reason:
  - this is still the cleanest confirmation target for the new root-cause fix
  - the decisive failure mode is now specific: over-reading examples as domain
    restrictions
  - the batch should tell us quickly whether this becomes a real keep or just a
    narrower near-miss

`exp120` `sqlite-db-truncate` rerun after value-domain fix:

- candidate branch: `wip/active-eval-loop-mainline` at `8b5f33e`
- control branch: `main`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`

`exp120` outcome:

- candidate A: reward `0.0`, no exception, verifier score `0`
- candidate B: reward `0.0`, no exception, verifier score `6`
- control A: clean pass, reward `1.0`, no exception
- control B: reward `0.0`, no exception, verifier score `0`

Interpretation:

- `8b5f33e` is not a keep
- it improved one candidate lane materially:
  - candidate B reached the same `6`-match near-miss frontier
  - while one control lane stayed at `0`
- but candidate A still regressed badly, so the patch is not stable enough
- this means the higher-level example-value fix is directionally right, but a
  lower-layer agent contract is still allowing the wrong method on some paths

Root-cause note from `exp120`:

- candidate A reopened a weaker recovery method after the stronger SQLite
  leaf-page / serial-type decode had already been established
- instead of staying inside the proven record structure, it switched to a
  looser nearby-byte interpretation and produced garbage like:
  - `testword07c`
  - `testword06K`
  - `testword052`
  - large nonsensical integers
- that exposes a lower-layer contract bug in `command-runner`:
  - the current prompt still allows a structured recovery task to fall back to
    weaker adjacency heuristics after a stronger model is already known
  - it also still phrases example-value shape too much like an admissibility
    gate instead of a field-role/schema check

Prompt fix after `exp120`:

- `command-runner`: once a structure-aware decode has established field
  boundaries, record layout, or typed field decoders, do not switch to weaker
  adjacency or nearby-byte heuristics for those same fields unless new
  evidence breaks the stronger model
- `command-runner`: example values are a field-role/schema check, not a hidden
  value-domain restriction unless the caller explicitly says only certain
  values or types are allowed

Next task after `exp120`:

- rerun `sqlite-db-truncate`
- reason:
  - the remaining instability is now isolated to the lower execution layer
  - this new fix is still general and directly tied to the observed failure
  - rerunning the same task gives the cleanest confirmation signal before
    widening again

`exp121` `sqlite-db-truncate` rerun after lower-layer decode fix:

- candidate branch: `wip/active-eval-loop-mainline` at `c0fc1bc`
- control branch: `main`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`

`exp121` partial outcome:

- candidate A: clean pass, reward `1.0`, no exception
- candidate B: reward `0.0`, no exception, verifier score `2`
- control B: clean pass, reward `1.0`, no exception
- control A: reward `0.0`, no exception

Interpretation:

- `c0fc1bc` is not a keep
- it materially improved one candidate lane all the way to a clean pass
- but the second candidate lane still collapsed into a weaker, wrong decoding
  method, so the fix is not stable enough

Root-cause note from `exp121`:

- candidate A stayed on the structured SQLite leaf-page decode and recovered:
  - `testword00 -> 1`
  - ...
  - `testword08 -> 99.99`
  - `testword09 -> 0.5`
- candidate B surfaced the correct keys, then abandoned record structure and
  paired each recovered key with the next 8 raw bytes after the string,
  interpreting those adjacent bytes as doubles
- that produced the classic wrong-shape numeric garbage like:
  - `8.960515547256254e-299`
  - `3.151125814673771e-260`
- so the remaining lower-layer bug is narrower than `exp120`:
  - the prompt now discourages broad weaker adjacency fallbacks
  - but it still allows one field to be filled from bytes immediately adjacent
    to another recovered field even when the container structure is already
    known or still parseable

Prompt fix after `exp121`:

- `command-runner`: if a structured container or record model is already known
  or still directly parseable, do not fill one field from the raw bytes
  immediately before or after another recovered field just because those bytes
  are nearby
- `command-runner`: treat key-local or token-local byte adjacency as
  supporting evidence only until record framing or another structure-aware
  decode directly supports that field value

Next task after `exp121`:

- rerun `sqlite-db-truncate`
- reason:
  - the new failure is a clean generalization of the surviving bad path
  - the candidate/control split is now methodologically sharp
  - the same task is still the fastest way to confirm whether this narrower
    adjacency rule becomes a real keep

Commit after `exp121`:

- `2cd47f7` `fix: keep adjacent bytes from closing structured fields`

`exp122` `sqlite-db-truncate` rerun after adjacency-field fix:

- candidate branch: `wip/active-eval-loop-mainline` at `2cd47f7`
- control branch: `main`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp122-candidate-a.qp0an4pk`
  - candidate B: `/tmp/sprout-exp122-candidate-b.s7uzvga_`
  - control A: `/tmp/sprout-exp122-control-a.zq5k2pur`
  - control B: `/tmp/sprout-exp122-control-b.43mzm21d`

`exp122` outcome:

- candidate A: reward `0.0`, no exception, verifier score `0`
- candidate B: reward `0.0`, no exception, verifier score `6`
- control A: reward `0.0`, no exception, verifier score `0`
- control B: reward `0.0`, no exception, verifier score `6`

Interpretation:

- `2cd47f7` is not a keep
- the adjacency-field fix did not improve the batch over `main`
- both branches still split between:
  - fully wrong typed/semantic values
  - near-pass outputs that still violate the exact field contract on the last
    unresolved rows

Root-cause note from `exp122`:

- candidate A wrote all 10 `word` values but filled `value` with strings like:
  - `"?"`
  - `"@X"`
  - `"0x19"`
  - `""`
- candidate B wrote mostly correct numeric rows but still used:
  - `null` for unresolved numeric values
- both candidate lanes then reported the output as being in the required
  format because the array/object shape and keys matched
- that exposes the next lower-layer contract bug:
  - shape-only validation is still outranking exact field-type requirements
  - a required numeric field is being treated as satisfied by any placeholder
    that preserves object shape
  - rows with wrong-typed fields are still being counted as recovered rows

Prompt fix after `exp122`:

- `command-runner`: when the caller specifies exact field types, treat those
  types as part of the exact schema, not as optional refinements
- `command-runner`: do not report success or “required format” when keys match
  but a required field is still `null`, stringly-typed, a raw marker, or
  another placeholder for an unresolved typed value
- `command-runner`: if a required typed field is unresolved, keep the task
  open and treat that row as partial instead of counting it as recovered

Next task after `exp122`:

- rerun `sqlite-db-truncate`
- reason:
  - the remaining failure is now a pure schema-validity contract issue
  - this is broader than SQLite and directly useful for any typed extraction
    task
  - the same task remains the fastest confirmation target

Commit after `exp122`:

- `94d2a3b` `fix: keep type-invalid rows from closing schemas`

`exp123` `sqlite-db-truncate` rerun after schema-type gate fix:

- candidate branch: `wip/active-eval-loop-mainline` at `94d2a3b`
- control branch: `main`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp123-candidate-a.9ep9yrma`
  - candidate B: `/tmp/sprout-exp123-candidate-b.dlbvka84`
  - control A: `/tmp/sprout-exp123-control-a.rx4nvl_b`
  - control B: `/tmp/sprout-exp123-control-b.787u5502`

`exp123` outcome:

- candidate A: clean pass, reward `1.0`, no exception
- candidate B: reward `0.0`, no exception
- control A: reward `0.0`, no exception, verifier score `2`
- control B: reward `0.0`, no exception, verifier score `0`

Interpretation:

- `94d2a3b` is a real keep
- candidate batch: `1 pass / 1 fail`
- control batch: `0 pass / 2 fail`
- this is the first sqlite rerun in the recent sequence where the candidate
  clearly outperformed `main` across the batch rather than merely tying it

Root-cause note confirmed by `exp123`:

- the exact-schema type gate changes behavior in a useful way
- one candidate lane that previously would have closed on `null`/string
  placeholders instead kept digging and reached a clean pass
- `main` still closed early on partial or narrowly grounded outputs and never
  got a pass in the same wave

Keep checkpoint:

- `94d2a3b` `fix: keep type-invalid rows from closing schemas`

Next task after `exp123`:

- move the active baseline to `94d2a3b`
- switch to `log-summary-date-ranges`
- reason:
  - it was the remaining failure in the earlier broad-functionality batch that
    still looks like an exact-structure/exact-semantics task
  - that makes it a good generalization target for the new schema-validity
    baseline before chasing another recovery-only frontier

`exp124` `log-summary-date-ranges` from the new baseline:

- candidate branch: `wip/active-eval-loop-mainline` at `94d2a3b`
- control branch: `main`
- task: `log-summary-date-ranges`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp124-candidate-a.66apsbe5`
  - candidate B: `/tmp/sprout-exp124-candidate-b.faa_fs2l`
  - control A: `/tmp/sprout-exp124-control-a.dlvm8iyg`
  - control B: `/tmp/sprout-exp124-control-b.vcg2igta`

`exp124` outcome:

- candidate A: verifier green (`2 passed / 0 failed`), `exception_info: null`
- candidate B: verifier green (`2 passed / 0 failed`), `exception_info: null`
- control A: verifier green (`2 passed / 0 failed`), `exception_info: null`
- control B: verifier green (`2 passed / 0 failed`), `exception_info: null`
- note:
  - Harbor again left `reward: null` in all four `result.json` files
  - for this run family, the trustworthy success signal was green verifier output
    plus `exception_info: null`

Interpretation:

- clean `2/2` tie between active baseline `94d2a3b` and `main`
- the new schema-validity keep does not regress this exact-structure reporting
  task
- `log-summary-date-ranges` is no longer the best frontier for further
  hill-climbing from this baseline

Next task after `exp124`:

- `multi-source-data-merger`
- reason:
  - it was an earlier broad-batch failure on `main`
  - the active branch already has a real keep on this task family (`dd15817`)
  - rerunning it from the newer `94d2a3b` baseline is the next clean check for
    whether the accumulated keeps still preserve that earlier reliability edge

Operational note before `exp125`:

- the direct backgrounded shell launcher path is not trustworthy for local
  Harbor runs in this environment
- foreground `uv run harbor run ...` holds and creates trials correctly
- detached launches also hold when started with a fresh session
  (`subprocess.Popen(..., start_new_session=True)`)
- use the documented local Harbor workflow plus a fresh session for background
  runs instead of plain `nohup ... &`

`exp125` `multi-source-data-merger` from the `94d2a3b` baseline:

- candidate branch: `wip/active-eval-loop-mainline` at `94d2a3b`
- control branch: `main` at `35f7cd1`
- task: `multi-source-data-merger`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp125-debug.svIsbJ`
  - candidate B: `/tmp/sprout-exp125-candidate-b.2foxcqy3`
  - control A: `/tmp/sprout-exp125-control-a.0xk56dhs`
  - control B: `/tmp/sprout-exp125-control-b.sfu79pu2`

`exp125` outcome:

- candidate A: verifier green (`3 passed / 0 failed`), `exception_info: null`
- candidate B: verifier green (`3 passed / 0 failed`), `exception_info: null`
- control A: failed (`merged_users.parquet` and `conflicts.json` missing)
- control B: failed (`merged_users.parquet` and `conflicts.json` missing)
- note:
  - Harbor again left `reward`, `status`, and `completed_at` unset in
    `result.json`, so the trustworthy signal stayed verifier output plus
    `exception_info`

Interpretation:

- the active baseline still clearly beats `main` on `multi-source-data-merger`
- candidate B also surfaced a real bus-resume defect during the run, even
  though that particular rep still got home:
  - a resumed nested coordinator attempted `message_agent` on a previously
    delegated child handle and got `Unknown handle`
  - the visible failure showed up in
    `/tmp/sprout-exp125-candidate-b.2foxcqy3/.../01KMCDZHDF61WM1916M8CM6RCM.jsonl`

Resume/runtime root cause found after `exp125`:

- resumed agent processes were only replaying their own history
- they were not reliably reconstructing the completed delegated child handles
  visible in that history for nested non-root agents
- and even when a completed handle was pre-registered into the spawner, the
  respawn path for that handle did not subscribe to its result topic
- that meant `messageAgent()` on a resumed completed handle could fall through
  to the synthetic `Agent process ... exited with code 0` failure even though
  the respawned child actually completed

Runtime fix work after `exp125`:

- generalized child-handle extraction to the resumed agent's own depth instead
  of hardcoded root depth
- added completed-handle loading with agent metadata
- pre-registered completed child handles during nested agent resume
- fixed `AgentSpawner` so respawning a pre-registered completed handle
  subscribes to its result topic before waiting for the next result

Repo verification for the runtime fix:

- `bun test test/host/cli-resume.test.ts test/bus/spawner.test.ts test/bus/resume.test.ts`
  - `75 pass / 0 fail`
- `bun test test/bus/agent-process.test.ts test/host/cli-resume.test.ts test/bus/spawner.test.ts test/bus/resume.test.ts`
  - `96 pass / 0 fail`

Operational note on Harbor support:

- the repo does have a real Harbor runner harness under `inspo/harbor-runner`,
  but that path is the AWS spot-instance runner
- for local hill-climbing, the stable supported path remains direct
  `uv run harbor run` from the shared Harbor checkout
- the unreliable piece was the ad hoc detached shell launcher, not missing
  Harbor runner support

Checkpoint after runtime fix:

- commit: `6a6d6b4` `fix: resume completed delegated handles`
- scope:
  - restore completed delegated handles during resume for nested agents
  - carry enough spawn metadata to re-message resumed handles correctly
  - subscribe to result topics when respawning pre-registered completed handles

`exp126` `multi-source-data-merger` confirmation from the runtime-fix checkpoint:

- candidate branch: `wip/active-eval-loop-mainline` at `6a6d6b4`
- control branch: `main` at `35f7cd1`
- task: `multi-source-data-merger`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp126-candidate-a.vfxxy6bi`
  - candidate B: `/tmp/sprout-exp126-candidate-b.jvl75cwf`
  - control A: `/tmp/sprout-exp126-control-a.8em7f21f`
  - control B: `/tmp/sprout-exp126-control-b.os52fh9p`
- trial dirs created successfully:
  - candidate A: `multi-source-data-merger__29N98um`
  - candidate B: `multi-source-data-merger__Pwewnqb`
  - control A: `multi-source-data-merger__HBgKeoq`
  - control B: `multi-source-data-merger__amSX7zo`

`exp126` completed outcome:

- candidate A: clean green, reward `1.0`
- candidate B: clean green, reward `1.0`
- control A: clean green, reward `1.0`
- control B: failed, reward `0.0`
  - verifier frontier: conflict report schema drift
  - concrete failure: `KeyError: 'field'` in `test_conflict_report_values`

Interpretation:

- `6a6d6b4` is a real keep on `multi-source-data-merger`
- the runtime root cause was real:
  resumed delegated-child handles now survive replay/resume without losing the
  saved spawn identity or the result-topic subscription
- the candidate no longer exhibits the old `Unknown handle` / completed-child
  respawn failure shape
- the task itself is somewhat forgiving because one `main` control rep also went
  green, so the next task should stress recovery and control flow more directly

Next task after the `exp126` keep:

- move from `multi-source-data-merger` to `db-wal-recovery`
- keep the candidate at `6a6d6b4` in the long-lived experiment worktree
- keep `main` at `35f7cd1` as the control
- use the same local Harbor harness path, but on the harsher recovery task

`exp127` `db-wal-recovery` generalization wave:

- candidate branch: `wip/active-eval-loop-mainline` at `3f5b0bf`
  - effective runtime change under test still comes from `6a6d6b4`
- control branch: `main` at `35f7cd1`
- task: `db-wal-recovery`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp127-candidate-a.PnmHy1`
  - candidate B: `/tmp/sprout-exp127-candidate-b.arWNgk`
  - control A: `/tmp/sprout-exp127-control-a.dEknNW`
  - control B: `/tmp/sprout-exp127-control-b.fWFuk0`
- launch method:
  - one managed local shell session keeps all four `uv run harbor run` processes
    alive and waits on them together
  - this avoids opening four additional long-lived Codex exec sessions just to
    babysit parallel local Harbor runs
- early runtime check:
  - Harbor created all four job dirs successfully
  - one candidate lane has already crossed from install into the real task
    prompt
  - the batch is valid and no longer looks like a launcher false start

`exp127` partial results:

- candidate A: clean green, reward `1.0`
  - verifier passed all 7 checks
  - `exception_info: null`
  - successful path:
    - preserved evidence first
    - identified single-byte XOR key `66` on the WAL bytes
    - decoded the WAL on a work copy
    - let SQLite apply the decoded WAL to recover all 11 rows
    - wrote `/app/recovered.json`
- control A: hard fail, reward `0.0`
  - verifier frontier: no `/app/recovered.json`
- control B: hard fail, reward `0.0`
  - verifier frontier: no `/app/recovered.json`
  - dominant failure shape:
    - extended diagnosis and conditional next steps
    - no decisive artifact write
- candidate B: still in flight at this checkpoint
  - stronger than control on task shape
  - has already escalated into deeper byte-level recovery work
  - but one delegated recovery branch stumbled on a Python indentation error

Interim interpretation:

- `6a6d6b4` is already beating `main` on the harsher `db-wal-recovery` task
  in at least one clean rep
- the candidate prompt can now hit the correct forensic loop:
  preserve evidence, decode WAL on copies, recover rows, and write the exact
  artifact
- both controls failed the same way:
  they never produced `/app/recovered.json`
- the remaining question for `exp127` is reliability, not capability

`exp127` final outcome:

- candidate A: clean green, reward `1.0`
- candidate B: fail, reward `0.0`, `AgentTimeoutError`
  - wrote `/app/recovered.json`, but only with the 5 base rows
  - verifier frontier:
    - `Expected 11 records, got 5`
    - `Only base data recovered - WAL decryption failed`
- control A: fail, reward `0.0`
  - no `/app/recovered.json`
- control B: fail, reward `0.0`
  - no `/app/recovered.json`

Root-cause split exposed by `exp127`:

- the candidate prompt is directionally better than `main`, but not yet stable
- the winning lane kept a single decisive owner on the preserved-evidence ->
  decode -> verify -> artifact path
- the failing candidate lane drifted into supporting parallel branches:
  - clue extraction
  - byte-level parser experiments
  - deeper delegation churn
- that branch still wrote an artifact, but it regressed to the 5-row base DB
  and timed out before the real WAL recovery landed
- both controls failed earlier and worse:
  the task never reached an output artifact at all

Decision after `exp127`:

- not a clean keep yet
- do not promote from a `1/2` candidate split even though both controls lost
- next experiment should strengthen one-owner decisive recovery on preserved
  evidence and demote supporting side quests until the authoritative artifact
  exists

Follow-up prompt change after `exp127`:

- commit: `aea1560` `fix: keep decisive artifact loops single-owner`
- change:
  - when a preserved evidence set already exists and the required artifact is
    still missing, keep one owner on the decisive path from that evidence to
    the artifact
  - treat supporting side branches as subordinate while the required artifact
    is still missing
  - do not let clue extraction, broader diagnosis, or parallel helper work
    displace that owner unless that owner is blocked on a specific missing fact
- focused regression:
  - `bun test ./test/host/embedded-root.test.ts`
  - red before the prompt patch
  - green after regeneration

`exp128` `db-wal-recovery` confirmation wave:

- candidate branch: `wip/active-eval-loop-mainline` at `aea1560`
- control branch: `main` at `35f7cd1`
- task: `db-wal-recovery`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp128-candidate-a.JmV6aF`
  - candidate B: `/tmp/sprout-exp128-candidate-b.UTYdpr`
  - control A: `/tmp/sprout-exp128-control-a.spbjIm`
  - control B: `/tmp/sprout-exp128-control-b.zgwRFr`

`exp128` confirmed keep on the candidate side:

- candidate A: clean green, reward `1.0`, `exception_info: null`
- candidate B: clean green, reward `1.0`, `exception_info: null`
- control A: fail, verifier never found `/app/recovered.json`,
  `exception_info: null`
- control B: fail, verifier found only the base 5 rows in
  `/app/recovered.json`, `exception_info: null`

Why this is a keep:

- `db-wal-recovery` had been stuck at `1/2` candidate reliability on the prior
  prompt version
- `aea1560` is the first `2/2` clean candidate on this task
- the winning behavior matches the intended general rule:
  keep one owner on the decisive preserved-evidence -> artifact path and keep
  supporting side branches subordinate while the required artifact is still
  missing

Interpretation:

- `aea1560` is a real keep on `db-wal-recovery`
- the candidate cleared the reliability bar cleanly with `2/2` green runs
- `main` still shows both old failure families on this task:
  - complete artifact miss
  - partial base-only recovery without WAL reconstruction

Next task after `exp128`:

- `log-summary-date-ranges`
- Why:
  - it is a different task family from the evidence-preserving recovery loop
  - it is still a good check on exact structure plus semantic extraction
  - it helps confirm that the new single-owner decisive-loop rule generalizes
    without regressing an older broad-batch reporting task

Operational correction before `exp129`:

- do not rely on ignored worktree-local state for Harbor launch setup
- source the repo-root `.env` explicitly
- when a comparison worktree does not carry `inspo/harbor`, run Harbor from the
  shared repo-root checkout while still pointing `PYTHONPATH` at the target
  worktree's `tools/harbor`

`exp129` `log-summary-date-ranges` generalization check:

- candidate branch: `wip/active-eval-loop-mainline` at `74ac854`
- control branch: `main` at `35f7cd1`
- task: `log-summary-date-ranges`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp129-candidate-a.02e93e`
  - candidate B: `/tmp/sprout-exp129-candidate-b.7d8279`
  - control A rerun: `/tmp/sprout-exp129-control-a-rerun.8e323f`
  - control B rerun: `/tmp/sprout-exp129-control-b-rerun.8b1b72`

Early live signal:

- the first control launch attempt died in setup because the control worktree
  did not have an ignored `.env`
- both candidate lanes created real Harbor trial dirs on the first launch
- both control lanes were relaunched with repo-root `.env` plus shared
  repo-root Harbor checkout

`exp129` outcome:

- candidate A: verifier green (`2 passed / 0 failed`), `exception_info: null`
- candidate B: verifier green (`2 passed / 0 failed`), `exception_info: null`
- control A rerun: verifier green (`2 passed / 0 failed`), `exception_info: null`
- control B rerun: verifier green (`2 passed / 0 failed`), `exception_info: null`

Interpretation:

- clean `2/2` tie between active baseline `74ac854` and `main`
- the `aea1560` decisive-artifact-loop keep does not regress
  `log-summary-date-ranges`
- this task is still not the best hill-climbing frontier because `main` is
  already robust here once the run reaches the real files and bracketed
  severity tokens

Next task after `exp129`:

- `sqlite-db-truncate`
- Why:
  - it is still an exact typed-extraction task with a real earlier keep
    (`94d2a3b`)
  - it is a better outward generalization target than another reporting tie
  - it should tell us whether the newer decisive-loop keep compounds cleanly
    with the older exact-schema extraction keeps

`exp130` `sqlite-db-truncate` outward check:

- candidate branch: `wip/active-eval-loop-mainline` at `f56ece3`
- control branch: `main` at `35f7cd1`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launcher shape:
  - source repo-root `.env`
  - run Harbor from the shared repo-root checkout
  - point `PYTHONPATH` at the target worktree's `tools/harbor`
- launch dirs:
  - candidate A: `/tmp/sprout-exp130-candidate-a.389214`
  - candidate B: `/tmp/sprout-exp130-candidate-b.55fc7f`
  - control A: `/tmp/sprout-exp130-control-a.9a813f`
  - control B: `/tmp/sprout-exp130-control-b.cb6148`

Early live signal:

- all four lanes created real Harbor trial dirs on the first try
- this wave is using the stabilized local launcher contract instead of
  worktree-local ignored state

`exp130` outcome:

- candidate A: fail, verifier score `5`, `exception_info: null`
- candidate B: fail, verifier score `2`, `exception_info: null`
- control A: clean pass, reward `1.0`, `exception_info: null`
- control B: clean pass, reward `1.0`, `exception_info: null`

Interpretation:

- `f56ece3` is a discard on `sqlite-db-truncate`
- active branch lost cleanly to `main`: `0/2` candidates vs `2/2` controls
- the decisive-artifact-loop keep does not yet compound cleanly with the older
  typed-schema extraction keeps on this task family

Root-cause note from `exp130`:

- candidate A kept exact `word` boundaries for rows `00` through `07` but then
  dropped the last two float rows entirely because it did not keep refining
  value proof inside the same record model
- candidate B recovered the float values `99.99` and `0.5` but let adjacent
  junk bytes stay attached to the `word` field, producing near-matches like
  `testword08@X`
- the passing control stayed on intact leaf-page record pairs and closed exact
  `word` plus `value` tuples
- the next general fix is therefore not a broader recovery strategy change
- it is to keep exact field-boundary refinement inside a known record model,
  instead of either dropping proven rows or accepting extra-byte junk in the
  field

Prompt fix after `exp130`:

- commit: `4cd642a` `fix: keep record-field boundaries exact`
- change:
  - if a known record model already yields a coherent row except one field
    still has extra leading or trailing bytes, keep that row open and refine
    the field boundary inside the same record model
  - do not drop sibling fields or previously proven rows just because one
    field from that row still needs boundary cleanup
- focused regression:
  - `bun test ./test/host/embedded-root.test.ts`
  - red before the prompt patch
  - green after regeneration

Next task after `exp130`:

- rerun `sqlite-db-truncate`
- Why:
  - the failure family is now narrow and methodologically clean
  - the new prompt fix directly targets the surviving exact field-boundary gap
  - rerunning the same task is the fastest honest confirmation signal

`exp131` `sqlite-db-truncate` confirmation rerun:

- candidate branch: `wip/active-eval-loop-mainline` at `4cd642a`
- control branch: `main` at `35f7cd1`
- task: `sqlite-db-truncate`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launcher shape:
  - source repo-root `.env`
  - run Harbor from the shared repo-root checkout
  - point `PYTHONPATH` at the target worktree's `tools/harbor`
- launch dirs:
  - candidate A: `/tmp/sprout-exp131-candidate-a.573c26`
  - candidate B: `/tmp/sprout-exp131-candidate-b.3e5546`
  - control A: `/tmp/sprout-exp131-control-a.2baa74`
  - control B: `/tmp/sprout-exp131-control-b.736204`

Early live signal:

- all four lanes created real Harbor trial dirs on the first try
- the candidate Harbor agent was rebuilt after `4cd642a` before launch

`exp131` outcome:

- candidate A: fail, verifier score `2`, `exception_info: null`
- candidate B: fail, verifier score `0`, `exception_info: null`
- control A: fail, verifier score `0`, `exception_info: null`
- control B: fail, verifier score `0`, `exception_info: null`

Interpretation:

- `4cd642a` is a discard on `sqlite-db-truncate`
- this was not a launcher or verifier failure
- `exp130` proved the same `main` control recipe can pass cleanly minutes
  earlier, so `exp131` is real model-path variance, not a broken harness
- the shared local recipe remains acceptable for the loop, but this task now
  needs variance-aware confirmation instead of a single 2x2 confirmation rerun

Root-cause note from `exp131`:

- control A regressed to a bad low-fidelity path: it regex-matched `testword`
  strings, inferred values from trailing label digits, and wrote a zero-score
  artifact
- control B also regressed to low-fidelity salvage, preserving labels but
  emitting wrong value types and adjacent junk
- candidate B kept more row structure than the controls, but still allowed
  label/value contamination and wrong numeric closure across sibling rows
- candidate A over-corrected in the other direction and kept only two
  high-confidence float rows plus forensic metadata, dropping the rest of the
  family
- the common surviving gap is not generic exactness anymore
- it is failure to hold neighboring same-schema rows inside one record-family
  model once that family is already plausible
- the next general fix is therefore to keep same-schema neighboring rows in one
  record family while unresolved field boundaries remain, instead of either
  resolving each row independently or discarding the family down to only the
  most obvious exemplars

Prompt fix after `exp131`:

- working tree candidate after `4cd642a`
- change:
  - when neighboring rows plausibly share the same schema and record layout,
    keep them in one record family while unresolved field boundaries remain
  - do not switch to isolated per-row guesses once the family model is
    established
- focused regression:
  - `bun test ./test/host/embedded-root.test.ts`
  - red before the prompt patch
  - green after regeneration

Next task after `exp131`:

- rerun `sqlite-db-truncate`
- Why:
  - `exp131` showed the remaining gap is family-consistent closure, not raw
    field-boundary awareness alone
  - the new prompt patch directly targets the split between over-pruning and
    per-row guessing
  - the task is still the fastest honest way to verify whether this more
    general family-consistency rule compounds with the earlier exact-schema
    recovery gains

`exp132` setup:

- candidate commit: `bdab82b` `fix: keep record families coherent`
- control commit: `35f7cd1` on `main`
- task: `sqlite-db-truncate`
- long-lived candidate worktree:
  - `/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/.worktrees/active-eval-loop`
- control worktree:
  - `/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/.worktrees/integrate-harness-fix`
- launch dirs:
  - candidate A: `/tmp/sprout-exp132-candidate-a.b3d854`
  - candidate B: `/tmp/sprout-exp132-candidate-b.06f495`
  - control A: `/tmp/sprout-exp132-control-a.32a7cb`
  - control B: `/tmp/sprout-exp132-control-b.5cfe4e`

`exp132` live root-cause signal:

- candidate A recovered the exact 10-row set from the surviving SQLite table
  leaf page and Harbor scored it `1.0`
- candidate B reached the same 10-row recovery and passed the verifier on the
  downloaded artifact path
- control A regressed to the old ambiguous-family failure mode and wrote `[]`,
  which the verifier scored `0.0`
- control B eventually passed cleanly on the same task, so the final comparison
  settled at `2/2` candidate passes versus a split `1/2` on `main`

`exp132` outcome:

- `bdab82b` is a keep
- decisive general win:
  - when neighboring rows plausibly share one schema and layout, keep them in a
    single record family until the field boundaries are resolved
  - do not collapse into isolated per-row guesses or prune the family down to
    only the most obvious exemplar rows
- why it worked:
  - both candidate reps held the same surviving-page model through completion
    and decoded all 10 rows from SQLite cell structure
  - the failing `main` control lost that family model and treated the same page
    as too ambiguous to recover safely
- recovered row set:
  - `testword00=1`
  - `testword01=2`
  - `testword02=10`
  - `testword03=25`
  - `testword04=42`
  - `testword05=50`
  - `testword06=75`
  - `testword07=99`
  - `testword08=99.99`
  - `testword09=0.5`

Next task after `exp132`:

- move off `sqlite-db-truncate`
- Why:
  - the active branch now has a stable 2/2 pass on this task
  - the remaining value is to test whether the new record-family discipline
    transfers to the next failing task rather than overfitting this one

`exp133` setup:

- candidate branch: `wip/active-eval-loop-mainline` at `03001d4`
- control branch: `main` at `35f7cd1`
- task: `build-cython-ext`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp133-candidate-a.f2a573`
  - candidate B: `/tmp/sprout-exp133-candidate-b.77a72b`
  - control A: `/tmp/sprout-exp133-control-a.c827b8`
  - control B: `/tmp/sprout-exp133-control-b.418bac`

Early live signal:

- all four lanes created real Harbor trial dirs successfully on the first try
- this is a clean re-entry measurement wave, not a new prompt edit yet
- the purpose is to measure how far the accumulated active-branch keeps now
  generalize back into the old `build-cython-ext` frontier before designing the
  next prompt change there

`exp133` mid-wave observations:

- no `result.json` or verifier artifacts yet, but all four trajectories are
  still advancing
- candidate A is on the healthiest visible path so far:
  - it installed Cython into the global environment without disturbing NumPy
    `2.3.0`
  - it is now in the exact rebuild/install/prove loop for the compiled
    extensions from `/app/pyknotid`
- candidate B is less trustworthy:
  - it drifted into proxy import checks from inside `/app/pyknotid`
  - it tried top-level imports like `chelpers` instead of staying on the exact
    installed-package proof path
- control A caught up farther than the earlier `main` waves:
  - it reached the installed-package compatibility frontier at `np.float` in
    `spacecurve.py`
  - that means `main` is not failing only at bootstrap anymore
- control B spent time repairing prerequisite and optional-import blockers:
  - first `Cython` missing
  - then `vispy` import pressure from `visualise.py`
  - then the global rebuild/install loop
- the likely next prompt experiment, if this wave comes back mixed, is to
  strengthen exact import-target preservation in the requested operating
  context:
  - when the caller asks for proof of specific installed package imports, do not
    shorten them, reinterpret them, or substitute source-tree proxy imports
- sharper root cause from candidate B:
  - the parent delegation did not inline the exact verification snippet into
    the leaf goal
  - it referred abstractly to "the provided Python snippet" and "exact import
    checks"
  - the leaf then concluded no exact snippet had been provided and substituted
    a proxy probe from `/app/pyknotid`
  - the likely next general fix is therefore at delegation time:
  - when a downstream step must run an exact snippet, import list, or test
      invocation, embed that literal content in the helper goal instead of
      referring to it abstractly

`exp133` outcome:

- no keep
- all four lanes finished with `reward 0.0` and `AgentTimeoutError`
- candidate A regressed badly:
  - `2 passed / 9 failed`
  - missing compiled installed modules plus `fractions.gcd` remained
- candidate B reached the narrower frontier but did not beat `main`:
  - `7 passed / 4 failed`
  - remaining failures were mainly NumPy alias fallout such as `np.float`
- control A and control B both also reached `7 passed / 4 failed`
- the active branch therefore did not materially outperform `main` on this
  task yet

Sharper root cause from `exp133`:

- the live split in candidate B was not only a leaf-level proof mistake
- the parent delegation abstracted the required runtime proof as "the provided
  Python snippet" and "exact import checks" instead of embedding the literal
  snippet and import targets in the helper goal
- the leaf then truthfully concluded no literal snippet had been provided in
  its own goal and substituted proxy import probes from the source checkout
- the next candidate should therefore strengthen literal handoff at delegation
  time rather than only restating target-context proof rules again

Prompt fix after `exp133`:

- candidate commit: `f322aee` `fix: inline exact verification literals in
  helper goals`
- change:
  - if an exact verification depends on a literal snippet, import list, or test
    invocation already present in the task or prior findings, embed that
    literal content in the helper goal instead of referring to it abstractly as
    "the provided snippet", "exact import checks", or similar shorthand
- focused regression:
  - red before the prompt patch in `./test/host/embedded-root.test.ts`
  - green after regeneration with `bun run scripts/generate-embedded-root.ts`
    and `bun test ./test/host/embedded-root.test.ts`

`exp134` setup:

- candidate commit: `f322aee` `fix: inline exact verification literals in
  helper goals`
- control commit: `35f7cd1` on `main`
- task: `build-cython-ext`
- model shape:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- launch dirs:
  - candidate A: `/tmp/sprout-exp134-candidate-a.7a8465`
  - candidate B: `/tmp/sprout-exp134-candidate-b.5bbe4b`
  - control A: `/tmp/sprout-exp134-control-a.a8f4a3`
  - control B: `/tmp/sprout-exp134-control-b.00debd`

`exp134` live signal:

- the canonical local harness for these runs is still the documented
  `uv run harbor run` path with the packaged `tools/harbor` adapter
- the repo already had that support; the repeated launcher mistakes came from
  drifting into ad hoc shell orchestration rather than reusing the established
  Harbor workflow
- candidate A is still showing a bad control-flow shape after the new prompt:
  - it proved that a rebuild path replaced NumPy `2.3.0` with `2.4.3`
  - but then it collapsed into a prose summary of the blocker instead of
    continuing the exact required verification loop from that decisive
    invariant break
- candidate B is showing the intended literal-handoff improvement:
  - the live replay contains the exact bounded operational request with the
    required files, environment, compiled-extension names, exact README
    snippet, and repo-test exclusions
  - this is materially better than the `exp133` failure mode where the helper
    only received abstract labels such as "the provided Python snippet" and
    "exact import checks"
- the remaining question for `exp134` is therefore not whether the prompt knob
  took
- it did
- the real question is whether preserving the literal operational request
  translates into verifier-level progress rather than better-looking internal
  execution traces only

`exp134` resolved outcome:

- no keep
- all four lanes finished with `reward 0.0` and `AgentTimeoutError`
- candidate A regressed badly:
  - `3 passed / 8 failed`
  - compiled installed modules were still missing and `fractions.gcd` remained
- candidate B was best:
  - `10 passed / 1 failed`
  - the remaining frontier was the old narrow `ccomplexity` / `np.int` path
- control A also regressed:
  - `3 passed / 8 failed`
- control B landed in the middle:
  - `7 passed / 4 failed`

Sharper root cause from `exp134`:

- the literal-handoff rule was directionally right
- candidate B shows it can preserve the exact operational request into the live
  branch
- candidate A shows a different remaining control-flow failure:
  - a helper inside an active operational repair loop returned blocker prose
    after proving an invariant break
  - the parent then followed with another diagnosis-oriented request instead of
    restating the still-open direct repair loop on the same exact gate
- the next candidate should therefore strengthen engineer behavior at that
  handoff point:
  - if a helper in an active operational repair loop returns incomplete
    findings, blocker prose, or diagnosis without taking the still-open direct
    action, do not follow with another diagnosis-only request
  - restate the still-open operational steps, current invariants, and the same
    exact gate, and ask for the next direct repair loop instead

Harness correction after `exp134`:

- the repo already had the right Harbor support for this loop
- the intended local path is the documented `uv run harbor run` flow under
  `inspo/harbor` with the packaged `tools/harbor` adapter
- `inspo/harbor-runner/launch.sh` is the AWS spot launcher, not the canonical
  local loop
- future local experiment waves should use the documented local Harbor command
  rather than ad hoc shell orchestration

## March 23 `exp135` Live Wave

Candidate under test:

- `ef07ef7` `fix: keep operational repair loops active`

Control:

- `35f7cd1` on `main`

Harness notes:

- the clean local Harbor path is the documented `uv run harbor run` flow under
  `inspo/harbor`, with `tools/harbor` on `PYTHONPATH`
- `--n-attempts` / `-k` is Harbor's attempt-per-trial knob, not a clean
  independent-repetition knob
- this live wave therefore began as one candidate job and one control job with
  retry headroom, not a true 2x2 rep structure

Launch dirs:

- candidate: `/tmp/sprout-exp135-candidate.doyHYh`
- control: `/tmp/sprout-exp135-control.UeoYXW`

Current live signal before verifier output:

- both lanes are genuinely running in Harbor with real trial dirs and
  `trajectory.json`
- candidate stayed closer to the intended direct repair shape:
  - after the exact `fractions.gcd` blocker was surfaced in
    `pyknotid/make/torus.py`, the next helper goal kept the loop anchored to
    that exact file and exact blocker
  - the current failure inside that loop is no longer broad diagnosis drift; it
    is a bounded but bad patch mechanism:
    - the helper tried to patch through `command-runner` with a shell
      `git apply` envelope that did not apply
- control is showing a different churn pattern:
  - it is still spending turns on broader install/build remediation and
    environment/package-manager steps such as `Cython`, `setuptools`, and
    reinstall flow
  - it has not shown the same degree of exact-blocker focus on `torus.py`

Provisional root cause surfaced by `exp135` live replay:

- `engineer` is now better about keeping ownership of an active repair loop
- but it can still hand a required source edit to `command-runner`
- `command-runner` only has `exec`, so when the next decisive step is a source
  patch it may flail with shell patch mechanics instead of using the bounded
  editing path
- if the final verifier outcome agrees, the next experiment should likely test
  a cleaner boundary:
  - when the next direct action is a source edit, keep the repair loop at
    engineer level and use `editor` for that bounded patch
  - then return to `command-runner` for the immediate rebuild/install/recheck

`exp135` first-attempt result:

- candidate first attempt `build-cython-ext__wn3KhhM` timed out at
  `2 passed / 9 failed`
- control first attempt `build-cython-ext__7en8oiP` timed out at
  `9 passed / 2 failed`
- the control first attempt reached the narrow old frontier:
  - installed compiled extensions present
  - remaining failures concentrated in `ccomplexity` / NumPy alias fallout and
    the repo-test tail
- the candidate first attempt lost badly despite better exact-blocker focus:
  - it burned time inside a `torus.py` direct-repair loop after handing the
    required source edit to `command-runner`
  - the helper then failed on shell patch mechanics instead of executing a
    bounded editor-mediated source patch and immediate rerun

Current judgment while Harbor retry attempts are still running:

- `ef07ef7` is losing badly so far
- unless the retry attempt reverses the outcome materially, the next general
  prompt fix should test a cleaner helper boundary than "keep ownership alone"

Second-attempt live follow-up:

- these Harbor jobs are still genuinely active; the second attempts have not
  yet emitted `result.json`
- candidate second attempt `build-cython-ext__XFRJT8B` is currently deeper on a
  narrow operational frontier:
  - it is holding the exact extension-build loop open in `/app/pyknotid`
  - the decisive blocker is now the missing `setuptools` prerequisite while
    preserving the global NumPy `2.3.0` invariant
- control second attempt `build-cython-ext__YYqVeRV` is still using a broader
  source-compatibility sweep over NumPy alias sites under `pyknotid/`
- this strengthens the current hypothesis:
  - the missing capability is not more blocker emphasis by itself
  - it is a cleaner boundary between bounded source edits and bounded execution
    helpers, so direct file edits do not get routed through `command-runner`

Editor root cause surfaced during the retry:

- the candidate retry did correct the helper boundary at the engineer layer:
  - it routed the named `torus.py` source patch to `editor` instead of
    `command-runner`
- but the `editor` child then exposed a second prompt-level failure:
  - it never called a write primitive at all
  - it only read `pyknotid/make/torus.py`, described the minimal
    `fractions.gcd -> math.gcd` diff, re-read the unchanged live file, and then
    reported that the edit had not persisted
- that means the problem was not a broken Harbor file-write primitive in this
  case; it was an `editor` contract that still allowed "describe the diff" to
  masquerade as "make the edit"
- the static editor prompt also carried a provider mismatch:
  - OpenAI workers get `apply_patch` instead of `edit_file`
  - but the prompt only taught "prefer edit_file" and did not explicitly say to
    call the available write primitive

Prompt fix cut from this root cause:

- strengthen `root/agents/utility/agents/editor.md` so the editor:
  - uses the targeted existing-file edit primitive available to it
    (`edit_file` or `apply_patch`)
  - does not stop after describing a diff or hypothetical patch
  - actually calls the write primitive
  - re-reads the exact changed lines after the write call to confirm the live
    file changed
- added a focused semantic regression in
  `test/host/embedded-root.test.ts`
- regenerated `src/generated/embedded-root.ts`

Resolved `exp135` outcome:

- candidate retry `build-cython-ext__XFRJT8B` reached a full verifier green:
  - `11 passed / 0 failed`
  - but Harbor still recorded `AgentTimeoutError`
- control retry `build-cython-ext__YYqVeRV` stayed much worse:
  - NumPy drifted to `2.4.3`
  - compiled extensions were still missing
  - verifier ended at `6 failed / 5 passed`
- so `ef07ef7` is still not a clean keep, but it did move the product all the
  way to a verifier-clean state before failing to close the loop
- that makes the next experiment target narrower:
  - preserve the improved source-edit routing
  - eliminate the "describe diff / fail to write / keep running after green"
    behavior

Next live wave from the new editor-contract fix:

- candidate commit: `b9f3d5b` `fix: require editor write calls for edits`
- control commit: `35f7cd1` on `main`
- current Harbor jobs:
  - candidate A2: `/tmp/sprout-exp136-candidate-a2.YjDLas`
  - candidate B2: `/tmp/sprout-exp136-candidate-b2.aSwKzC`
  - control A2: `/tmp/sprout-exp136-control-a2.hmhOJe`
  - control B2: `/tmp/sprout-exp136-control-b2.eSYnMo`

Harness clarification and first live `exp136` signal:

- the repo does already have a real Harbor batch harness under
  `inspo/harbor-runner`, but that launcher is the AWS spot-instance path
- the canonical local micro-benchmark loop is still the documented direct
  adapter path:
  - `bun run build:harbor-agent`
  - `cd inspo/harbor`
  - `uv run harbor run ... --agent-import-path sprout_agent:SproutAgent`
- the practical correction here is not to swap local work onto
  `inspo/harbor-runner`, but to keep local runs on the staged `tools/harbor`
  adapter and stop inventing alternate launch mechanics beyond what is needed
  to detach a local run cleanly

Mid-run `exp136` evidence:

- all four `exp136` lanes are still genuinely active
- the root and child log trees are already multi-megabyte, so these are not
  dead launches or empty containers
- the first causal signal from the candidate is good:
  - candidate A2 replay now contains `apply_patch`
  - candidate B2 replay now contains explicit write-primitive references
- that is the exact behavior the editor prompt fix was meant to force
- this does not prove a keep yet, but it does show the old
  "describe the diff without ever calling a write primitive" failure mode is
  no longer the only observed path in the candidate branch

Helper-layer follow-up cut while `exp136` was live:

- mid-run replay evidence exposed a second helper-layer gap after the editor
  fix started taking effect:
  - install-proof snippets could still be launched from inside the source tree
    instead of a clean directory outside it
  - exact ignored test paths could still be rewritten into `-k` filters instead
    of preserved as exact path-based exclusions
- tightened `root/agents/utility/agents/command-runner.md` so it now says:
  - run an exact install-proof snippet from the clean working directory itself
  - do not stay in the source tree and launch a child subprocess from there
  - preserve exact ignored paths with path-based flags such as `--ignore=` when
    the runner supports them
  - do not rewrite exact ignored paths into `-k` filters or other
    content-based approximations
- added matching semantic anchors to `test/host/embedded-root.test.ts`
- regenerated `src/generated/embedded-root.ts`
- focused regression and full `bun run precommit` both passed in the active
  eval worktree

First finished `exp136` control lane:

- control A2 `build-cython-ext__MnhzMPD` finished with `reward 0.0`,
  `exception_info: null`, and `7 passed / 4 failed`
- it confirmed the control is still on the older narrow frontier rather than a
  better one:
  - `ccomplexity` still dies on `np.int`
  - `pyknotid.make.torus` still imports `fractions.gcd`
  - example usage and repo tests fail downstream from those same issues
- this means the current helper-layer prompt fix is still causally relevant:
  the control is not already solving the snippet-context or exact-ignore-path
  problems that surfaced in the live candidate logs

`exp137` outcome and next root cause:

- candidate commit: `04bae63` `fix: preserve exact install and test contexts`
- control commit: `35f7cd1` on `main`
- valid Harbor jobs:
  - candidate A: `/tmp/sprout-exp137-candidate-a.PNRt98`
  - candidate B: `/tmp/sprout-exp137-candidate-b.8FLDAh`
  - control A2: `/tmp/sprout-exp137-control-a2.CKxJDX`
  - control B2: `/tmp/sprout-exp137-control-b2.H5JT7k`
- invalid early control tmpdirs from the first broken launch should be ignored:
  - `/tmp/sprout-exp137-control-a.YRKAe5`
  - `/tmp/sprout-exp137-control-b.eIfEuJ`

`exp137` results:

- candidate A reached the best technical frontier of the batch but still timed
  out:
  - `reward 0.0`
  - `9 passed / 2 failed`
  - remaining verifier failures were `np.complex` in
    `pyknotid/invariants.py` plus repo-test tail fallout
- candidate B regressed hard:
  - `reward 0.0`
  - timeout
  - `2 passed / 9 failed`
  - broad `ModuleNotFoundError: No module named 'pyknotid'` family again
- control A2 ended at `7 passed / 4 failed`
- control B2 ended at `3 passed / 8 failed`

Interpretation:

- `04bae63` is directionally better than `main` because candidate A beat both
  controls on the technical frontier
- `04bae63` is still not a keep because both candidate reps timed out and
  candidate B fell off the install frontier

Decisive new root cause from the candidate split:

- candidate B invented an "exact acceptance snippet" even though the task had
  never supplied one
- it searched for an acceptance snippet conceptually, then substituted its own
  surrogate import check (`import pyknotid`, `import pyknotid.knot`) as if that
  were the exact gate
- that displaced the real deliverable proof and led the run back into the broad
  install-failure family
- candidate A did not take that detour and stayed on the narrower frontier

Narrow next fix:

- the command-runner prompt already forbids inventing a proxy when exact
  snippet content is absent
- the missing rule is at the engineer layer, where delegation goals were still
  allowed to speak as though an exact acceptance snippet existed without any
  literal snippet content from the task or verifier
- next candidate will make that rule explicit:
  - do not invent or author an exact acceptance snippet when none was supplied
  - if no literal exact snippet exists, keep the gate anchored to the exact
    named command, import path, test path, or deliverable proof already
    provided by the task or failing check

`exp138` outcome and current reinstall root cause:

- candidate commit: `dc16707` `fix: forbid invented exact acceptance snippets`
- control commit: `35f7cd1` on `main`
- Harbor jobs:
  - candidate A: `/tmp/sprout-exp138-candidate-a.1GqIYT`
  - candidate B: `/tmp/sprout-exp138-candidate-b.bOtOBW`
  - control A: `/tmp/sprout-exp138-control-a.dzDjFa`
  - control B: `/tmp/sprout-exp138-control-b.kG0S0Z`

`exp138` results:

- candidate A:
  - `reward 0.0`
  - timeout
  - `8 passed / 3 failed`
  - remaining failures were the tighter NumPy alias tail:
    `np.int` in `ccomplexity`, `np.float` in `cinvariants`, and example-usage
    fallout
- candidate B:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
  - it widened the environment and drifted NumPy to `2.4.3`
- control A:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
- control B:
  - `reward 0.0`
  - timeout
  - `3 passed / 8 failed`

Interpretation:

- `dc16707` is directionally better than `main`
- it removed the invented-snippet failure family and improved the best
  technical frontier
- it is still not a keep because both candidate reps timed out and candidate B
  regressed by breaking the fixed environment invariant

Decisive split inside `exp138`:

- candidate A stayed on the direct live repair loop:
  - it used a bounded live edit for `pyknotid/make/torus.py`
  - it preserved the existing environment with
    `python3 -m pip install --no-deps --force-reinstall .`
  - NumPy stayed at `2.3.0`
- candidate B hit an editor contradiction on the same torus import, then later
  widened into `python -m pip install --upgrade --force-reinstall .`
- that broader reinstall re-resolved unrelated packages and pulled NumPy to
  `2.4.3`, which reopened a worse frontier

Engineering lesson:

- after local source fixes in a constrained existing environment, the next
  rebuild or reinstall step must preserve the already-resolved dependency set
- broad upgrade or full dependency re-resolution is a different move and must
  not be chosen unless the active gate already proves a missing prerequisite or
  version conflict requires it

Next candidate:

- add an engineer-layer rule to prefer the narrowest rebuild or reinstall that
  reuses the current dependency set
- explicitly forbid widening that step into upgrade, force-reinstall,
  dependency sync, or other unrelated package re-resolution unless the active
  gate proves it is necessary

Candidate checkpoint and next wave:

- committed candidate `c7d2b34` `fix: preserve dependency invariants during reinstall`
- focused regression and full `bun run precommit` both passed before commit
- both active and control worktrees rebuilt Harbor artifacts with
  `bun run build:harbor-agent`
- launched the next 2x2 local Harbor wave from the persistent supervisor shell
  using the documented `uv run harbor run` path under each worktree's
  `inspo/harbor`
- Harbor tmpdirs:
  - candidate A: `/tmp/sprout-exp139-candidate-a.qy2G06`
  - candidate B: `/tmp/sprout-exp139-candidate-b.W7PM9y`
  - control A: `/tmp/sprout-exp139-control-a.5sPpm6`
  - control B: `/tmp/sprout-exp139-control-b.6EbaVK`

`exp139` results and next root cause:

- candidate commit: `c7d2b34` `fix: preserve dependency invariants during reinstall`
- control commit: `35f7cd1` on `main`

Results:

- candidate A:
  - `reward 0.0`
  - timeout
  - `3 passed / 8 failed`
  - it fell off the output-producing frontier and never got the compiled
    extensions installed
- candidate B:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
  - it preserved the environment better than the bad rep and reached the
    narrower alias/import frontier
- control A:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
- control B:
  - `reward 0.0`
  - timeout
  - `7 passed / 4 failed`
  - but one remaining failure was the NumPy version invariant itself, so it is
    not equivalent to the better control frontier

Interpretation:

- `c7d2b34` is not a keep
- the new rule removed one bad move, but it did not stabilize the loop
- candidate B only tied the stronger controls, and candidate A regressed badly

Decisive new root cause:

- candidate A saw the exact gate still failing because the named compiled
  modules were absent
- instead of taking the next explicit output-producing build or install step in
  the live source tree, it pivoted into repository-structure analysis,
  package-export analysis, and option-list framing
- that burned the remaining budget while the named outputs were still missing
- candidate B did better because it stayed closer to the explicit build frontier:
  it checked the build prerequisites, ran the smallest explicit extension build
  command, and only then moved back to runtime verification

Next candidate:

- keep the reinstall-invariant rule from `c7d2b34`
- add a stronger output-frontier rule at the engineer layer:
  - when the exact gate still says named compiled, native, generated, or
    installed outputs are missing, do not pivot into repo-structure analysis,
    export analysis, or option lists
  - take the smallest explicit output-producing build or install step in the
    live source tree, plus any directly named missing prerequisite, and rerun
    the same exact gate
