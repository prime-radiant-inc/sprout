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

## Cycle Notes After `67b1689`

### Cycle 11b

- Local Harbor mixed-model run passed with reward `1.0`.
- Replay totals:
  - `18` calls
  - `58,879` input tokens
  - `13,600` output tokens
- Model split:
  - `gpt-5.4`: `7` calls / `21,680` input / `2,589` output
  - `gpt-5-mini`: `11` calls / `37,199` input / `11,011` output
- Main waste:
  - a depth-1 `task-manager` branch created tasks, then spent a second turn returning IDs and asking what to do next

### Cycle 12

- Local Harbor mixed-model run passed with reward `1.0` in about `5m 04s`.
- Replay totals:
  - `22` calls
  - `92,015` input tokens
  - `14,291` output tokens
- Model split:
  - `gpt-5.4`: `7` calls / `22,034` input / `2,708` output
  - `gpt-5-mini`: `15` calls / `69,981` input / `11,583` output
- Improvements over cycle 11b:
  - the old wasteful `task-manager` bookkeeping branch disappeared
  - root used only two turns
  - the top-level tree shape was cleaner
- Remaining waste:
  - one depth-3 `gpt-5-mini` execution branch still took `12` turns to install, configure, test, and report
  - it still inserted optional extra proof collection and a final narrative longer than the caller needed
- Practical conclusion:
  - cycle 12 is the best known local mixed-model baseline so far

### Cycle 13

- Experiment: strengthen `command-runner` with explicit batching guidance for bounded operational workflows and an instruction not to spend extra commands gathering already-requested proof.
- Result: regression.
- Observed behavior:
  - `gpt-5-mini` started emitting giant all-in-one `bash -c` scripts
  - those scripts contained broken quoting and nested shell bugs
  - the branch got stuck retrying broken monolithic commands
- This was not a subtle regression:
  - the prompt change encouraged exactly the wrong behavior for `gpt-5-mini`
- Practical conclusion:
  - do not tell `command-runner` to batch whole operational workflows into one script

### Cycle 14

- Experiment: narrow the failed batching guidance into "a few focused commands or short scripts, not one monolithic script."
- Result: still worse than cycle 12.
- Partial replay totals before cancel:
  - `35` calls
  - `195,770` input tokens
  - `18,115` output tokens
- Model split:
  - `gpt-5.4`: `5` calls / `14,446` input / `1,568` output
  - `gpt-5-mini`: `30` calls / `181,324` input / `16,547` output
- Observed behavior:
  - the run did not produce the cycle-13-style giant broken shell script
  - but it still over-expanded the depth-3 `gpt-5-mini` executor into a long, serial, inspection-heavy branch
  - by the time it was canceled, one depth-3 executor branch had already reached `20+` tool-call turns and was still growing
- Practical conclusion:
  - even the narrowed batching wording is not an improvement over cycle 12
  - the remaining problem is no longer a simple `command-runner` wording issue

### Cycle 15

- Experiment: tighten `engineer` so prerequisite findings must be carried into the
  next delegated goal instead of being rediscovered.
- Result: passed with reward `1.0`, but still worse than cycle 12 overall.
- Harbor result:
  - about `5m 33s` agent execution
  - `160,891` input tokens
  - `25,259` output tokens
- Immediate improvement:
  - the engineer created a separate prerequisite pass
  - the prerequisite helper returned the decisive facts in two turns:
    - current user `root`
    - `sudo` absent
    - package manager `apt-get`
    - service manager `service`
    - nginx absent
    - key paths missing
  - the main executor no longer spent turns rechecking `sudo`, `id`, or package
    manager basics
- Remaining waste:
  - the engineer still forwarded generic labels like "the service manager" rather
    than the exact `service` command, so the main executor later tried
    `systemctl restart nginx.service`
  - the main executor still spent `20` turns and reached `113,973` input /
    `10,227` output tokens on its own replay log before reporting upward
  - the first config edit still used a brittle quoted `awk` one-liner and
    stumbled with `runaway string constant`
  - the final worker report still ended with a human-facing
    `If any step should be changed...` tail
- Practical conclusion:
  - carrying forward prerequisites is necessary and helped
  - the next prompt changes should focus on forwarding exact command names and
    suppressing upward conversational filler

## Replay Workshop Value

- The replay JSONL artifacts are sufficient to inspect a real leaf turn without reconstructing the request from indirect logs.
- The workshop is most useful for depth-3 helper branches where `gpt-5-mini` expands into transcript-heavy reports.
- A good workshop target is a helper that succeeded but returned far more output than the caller actually needed.

## Current Checkpoint

- Commit: `67b1689` (`fix: harden benchmark delegation and spawner exits`)
- That commit includes the spawner crash-propagation fix, the Harbor x64 baseline build fix, and the latest prompt tightening that still passes `bun run precommit`.

### Later prompt checkpoints

- `a25c60a` (`fix: carry prerequisite facts into delegated execution`)
  - `engineer` now requires operational prerequisite findings to be carried
    into the next delegated goal.
- `95b5b01` (`fix: forward decisive execution facts to workers`)
  - `engineer` now tells workers to pass exact command names and missing-tool
    facts instead of generic labels.
  - `command-runner` now treats caller-supplied decisive environment facts as
    established unless contradicted by a real command result, and it forbids
    upward `if you want...` closers.

## Next Loop

1. Re-run the local mixed-model Harbor task from commit `67b1689`.
2. Inspect the new replay logs for the first depth-3 `gpt-5-mini` helper branches.
3. Keep tightening the standard delegation/reporting contracts instead of adding benchmark-only behavior.
4. Re-validate locally before spending another AWS run.

## What To Watch Next

- Whether the new spawner crash propagation removes the old "non-zero agent exit with no reward" failure class completely.
- Whether the next waste is still transcript-heavy command output or has moved to a different agent boundary.
- Whether `gpt-5-mini` remains viable for `fast_model` after the prompt-contract tightening.
