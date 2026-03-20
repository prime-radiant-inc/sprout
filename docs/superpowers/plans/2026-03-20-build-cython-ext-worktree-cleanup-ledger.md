# Build Cython Ext Worktree Cleanup Ledger

Date: 2026-03-20

## Purpose

Record the stale experiment worktrees that were cleaned up after the
`build-cython-ext` eval campaign so we can reduce checkout-local noise without
losing the high-level provenance of what was removed.

This file is a cleanup ledger, not a full experiment notebook. The detailed
Harbor outcomes still live in the corresponding `result.json`,
`test-stdout.txt`, and replay artifacts under `/tmp/harbor-local-*`.

## Landed Baseline

- `main` is at `6ad5566`.
- The landed eval-improvement baseline under that tip is `06a3648`.

## Removed Clean Stale Worktrees

These worktrees were clean at removal time and were no longer needed as active
development environments:

- `build-cython-exp10-20260319`
- `delegation-arch-20260304`
- `experiment-15-minimum-missing-fact`
- `experiment-16-bounded-pass-principle`
- `experiment-17-invariant-recheck`
- `experiment-18-smallest-output-step`
- `experiment-19-next-step-capability`
- `experiment-20-authoritative-gate`
- `experiment-21-prereq-first`
- `experiment-22-direct-edit-first`
- `experiment-23-frontier-gate`
- `experiment-25-bounded-blocker-pass`
- `experiment-26-authoritative-gate-restoration`
- `experiment-27-least-powerful-next-step`
- `experiment-28-local-blocker-first`
- `experiment-29-short-heartbeat`
- `experiment-30-authoritative-gate-rerun`
- `experiment-32-bounded-family`
- `experiment-33-one-owner-downstream`
- `experiment-34-simplest-correct`
- `experiment-35-no-repeat-gate`
- `experiment-36-repair-anchor`
- `experiment-37-stronger-gate`
- `experiment-39-rerun-no-repeat`
- `experiment-40-source-of-truth`
- `experiment-41-rollback-invalid-state`
- `experiment-43-direct-source-first`
- `experiment-45-rerun-invalidated-layers`
- `experiment-46-bounded-named-sites`
- `experiment-47-keep-latest-stage`
- `experiment-48-exp43-plus-bounded`
- `experiment-49-single-remaining-site`
- `experiment-50-exp43-plus-source-truth`
- `experiment-51-routine-direct-edit`
- `experiment-52-keep-named-local-frontier`
- `experiment-53-one-owner-local-frontier`
- `experiment-54-no-sibling-reopen`
- `experiment-55-bounded-local-construct-sweep`
- `experiment-9-22a3bbb`
- `integrate-main-06a3648`
- `repro-head-env`
- `wip-experiment-13-bounded-family-pass`

## Retained Worktrees

These were intentionally kept because they still have uncommitted state or are
part of the current checkout-debugging thread:

- `experiment-31-failing-chain`
- `experiment-38-blocker-over-polish`
- `experiment-42-repeated-blocker-escalation`
- `experiment-44-producer-source-truth`
- `experiment-56-exact-frontier-scope`
- `experiment-56b-exact-frontier-scope`
- `fix-subprocess-harness`
- `repro-current-head`

## Cleanup Rule

Remove only clean stale worktrees. Do not remove dirty worktrees until their
state has either been committed, copied into a fresh note, or explicitly
discarded.
