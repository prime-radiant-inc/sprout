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

## Local Harbor Rerun Recipe

From the repo root:

```bash
bun run build:harbor-agent
tmpdir=$(mktemp -d /tmp/harbor-local-mixed-cycleNN.XXXXXX)
set -a
source .env
set +a
export PYTHONPATH="/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/tools/harbor${PYTHONPATH:+:$PYTHONPATH}"
cd inspo/harbor
uv run harbor run \
  --job-name sprout-mixed-cycleNN \
  --jobs-dir "$tmpdir" \
  --orchestrator local \
  -n 1 \
  -k 1 \
  --agent-import-path sprout_agent:SproutAgent \
  -m openai/gpt-5.4 \
  --ak best_model=openai:gpt-5.4 \
  --ak balanced_model=openai:gpt-5.4 \
  --ak fast_model=openai:gpt-5-mini \
  -d terminal-bench@2.0 \
  -t nginx-request-logging \
  -l 1
```

Notes:
- The repo `.env` is the intended source of `OPENAI_API_KEY` for local reruns.
- `PYTHONPATH` must include `tools/harbor` so Harbor can import `sprout_agent:SproutAgent`.
- Keep the job shape fixed while iterating on prompt changes so token and runtime comparisons stay meaningful.

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

### Cycle 16

- Experiment: require `command-runner` to treat caller-supplied decisive facts
  as established unless later steps may have changed them.
- Result: canceled early after enough evidence.
- Improvement:
  - `engineer` passed exact facts like `apt-get`, `service`, `root`, and
    `no sudo` into the main execution branch
- Remaining waste:
  - the main worker still spent its first turn re-checking facts the caller had
    already established, including whether `nginx` was present
- Practical conclusion:
  - the next fix needed to land in `command-runner`, not `engineer`

### Cycle 17

- Experiment: stop `command-runner` from re-checking decisive established facts.
- Result: full local Harbor mixed-model run completed, but reward was `0.0`.
- Harbor result:
  - `112,722` input tokens
  - `18,913` output tokens
- Verifier failure:
  - expected index page content `Welcome to the benchmark webserver`
  - got `Welcome to the benchmark webserver.`
  - expected 404 page content `Page not found - Please check your URL`
  - got `Page not found - Please check your URL.`
- Root cause:
  - exact file-content literals lost their delimiters as they moved through the
    orchestration chain, so sentence punctuation bled into the contents
  - root delegated `exact content Welcome to the benchmark webserver` and
    `exact content Page not found - Please check your URL` with no quotes
  - `tech-lead` and `engineer` then treated those as ordinary prose rather than
    immutable literals
- Practical conclusion:
  - exact-literal preservation must be a standard orchestration rule, not just
    a generic non-interactive reminder

### Cycle 18

- Experiment: add a shared non-interactive rule in `factory.ts` telling root to
  wrap short exact literals in quotes and preserve those delimiters.
- Result: canceled after enough replay evidence.
- What the replay logs showed:
  - root still stripped both quoted file contents in its first delegation
  - `tech-lead` then preserved one literal but mutated the other into
    `"Page not found - Please check your URL."`
- Practical conclusion:
  - the generic non-interactive addendum was still too weak
  - root and `tech-lead` need an explicit built-in delegation rule with a
    concrete good/bad exact-literal example

### Cycle 19

- Result: passed with reward `1.0`, but exposed a real orchestration bug.
- Harbor result:
  - about `5m 23s` agent execution
  - `102,178` input tokens
  - `34,040` output tokens
- What the logs showed:
  - the exact-literal fix worked end-to-end
  - root still dispatched `verifier` immediately, before implementation evidence existed
  - verifier correctly reported that nginx was absent and `localhost:8080` was unreachable
  - implementation completed successfully afterward
  - root then waited for the stale verifier result and ended with a contradictory final narrative instead of re-verifying the implemented state
- Practical conclusion:
  - root must not dispatch `verifier` in parallel with a branch that is creating the thing to be verified
  - verification should start only after the implementing specialist reports concrete actions or evidence, unless the caller explicitly asked for a baseline

### Cycle 20 checkpoint

- Commit `a794b6c` (`fix: delay verifier until implementation evidence exists`)
  added the standard root sequencing rule and regenerated the embedded bundle.
- Targeted prompt regressions passed:
  - `bun test test/host/embedded-root.test.ts test/agents/factory.test.ts`

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
- `167104b` (`fix: stop rechecking delegated execution facts`)
  - `command-runner` now avoids spending turns re-checking decisive facts the
    caller already established.
- `e635bcc` (`fix: preserve exact literals in delegated prompts`)
  - the non-interactive root guidance now explicitly tells root to quote short
    exact literals and preserve those delimiters when delegating.

## Next Loop

1. Land the standard orchestrator exact-literal rule in `root.md` and
   `tech-lead.md`, then regenerate the embedded root bundle.
2. Re-run the local mixed-model Harbor task from that checkpoint once the
   OpenAI key has quota again.
3. Inspect the new root and `tech-lead` replay logs before waiting for the full
   verifier result.
4. Keep tightening the standard delegation/reporting contracts instead of
   adding benchmark-only behavior.

## What To Watch Next

- Whether the new spawner crash propagation removes the old "non-zero agent exit with no reward" failure class completely.
- Whether the next waste is still transcript-heavy command output or has moved to a different agent boundary.
- Whether `gpt-5-mini` remains viable for `fast_model` after the prompt-contract tightening.
- Whether the next root and `tech-lead` delegations preserve quoted exact file
  contents without adding sentence punctuation.
- Whether the OpenAI key has enough quota for replay-workshop iterations; the
  current key started returning `429 You exceeded your current quota` during
  live replay experiments on the captured cycle-18 root turn.
