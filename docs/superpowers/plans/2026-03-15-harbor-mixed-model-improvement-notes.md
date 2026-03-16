# Harbor Mixed-Model Improvement Notes

**Purpose:** Preserve the current Sprout/Harbor benchmark debugging state so the next local or AWS loop can resume from facts instead of reconstruction.

## Current Benchmark Shape

- Dataset: `terminal-bench@2.0`
- Task: `nginx-request-logging`
- Harbor fallback model: `openai/gpt-5.4`
- Sprout defaults:
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`

## Verified Runtime Findings

- Harbor can now install and launch the compiled Sprout binary successfully.
- Sprout can emit `trajectory.json` and replay logs during benchmark runs.
- The AWS smoke run passes with all defaults on `openai:gpt-5.4`.
- The AWS smoke run also passes when only `fast_model` uses `openai:gpt-5-mini`, but it is materially slower and far more verbose.
- `gpt-5-mini` is mostly being used in depth-3 helper branches, not at root or the main coordination layer.

## Root Causes Already Fixed

### Installed binary and headless runtime

- Bundled CLI/runtime deadlock from the `cli.ts` to `cli-run.ts` cycle.
- Wrong child-process entrypoint detection when Bun reported `/$bunfs/root/...`.
- Child wrappers still assuming `bun run ...ts` instead of the compiled Sprout binary.
- Internal bus startup binding to `localhost` instead of `127.0.0.1`.
- Empty final assistant responses being treated as successful turns.
- Spawned child crashes failing silently instead of surfacing a result to the parent.
- Linux x64 Harbor builds targeting an AVX baseline that is not safe for the benchmark fleet.

### Prompt and workflow inefficiency

- `engineer` was launching dependent config inspection before prerequisite inspection proved the service and paths existed.
- `command-runner` was biased toward full transcripts instead of concise proof.
- Package-manager steps were returning long install output instead of short confirmation lines.

## Key Learnings From The Mixed-Model Runs

- Root-only reminders are not enough. The expensive behavior is coming from the delegated prompt contracts.
- The most wasteful helper branches are asking for raw command transcripts, full file dumps, and exhaustive verification evidence.
- A concise "be shorter" addendum barely helps. The standard prompts need tighter default reporting rules.
- Delegating to `task-manager` is not itself a bug. The problem is whether the delegated agent receives a precise task and returns concise, useful evidence.

## Replay Workshop Value

- The replay JSONL artifacts are sufficient to inspect a real leaf turn without reconstructing the request from indirect logs.
- The workshop is most useful for depth-3 helper branches where `gpt-5-mini` expands into transcript-heavy reports.
- A good workshop target is a helper that succeeded but returned far more output than the caller actually needed.

## Current Checkpoint

- Commit: `67b1689` (`fix: harden benchmark delegation and spawner exits`)
- That commit includes the spawner crash-propagation fix, the Harbor x64 baseline build fix, and the latest prompt tightening that still passes `bun run precommit`.

## Next Loop

1. Re-run the local mixed-model Harbor task from commit `67b1689`.
2. Inspect the new replay logs for the first depth-3 `gpt-5-mini` helper branches.
3. Keep tightening the standard delegation/reporting contracts instead of adding benchmark-only behavior.
4. Re-validate locally before spending another AWS run.

## What To Watch Next

- Whether the new spawner crash propagation removes the old "non-zero agent exit with no reward" failure class completely.
- Whether the next waste is still transcript-heavy command output or has moved to a different agent boundary.
- Whether `gpt-5-mini` remains viable for `fast_model` after the prompt-contract tightening.
