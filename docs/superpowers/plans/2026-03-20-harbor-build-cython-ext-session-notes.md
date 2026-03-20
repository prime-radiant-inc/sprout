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
