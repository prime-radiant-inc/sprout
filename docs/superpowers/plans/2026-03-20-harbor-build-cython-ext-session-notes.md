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
