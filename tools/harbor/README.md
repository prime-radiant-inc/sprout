# Sprout Harbor Adapter

This directory contains the Harbor installed-agent adapter for Sprout plus the
binary packaging output used by `inspo/harbor-runner`.

## Build

From the repo root:

```bash
bun run build:harbor-agent
```

That regenerates the embedded `root/` bundle and writes binaries to:

- `tools/harbor/dist/sprout-linux-x64`
- `tools/harbor/dist/sprout-linux-arm64`

## How the adapter configures Sprout

The Harbor adapter runs Sprout headlessly with:

- `--prompt`
- `--genome-path /logs/agent/agent-state/genome`
- `--log-atif /logs/agent/agent-state/trajectory.json`
- `--eval-mode`

Provider credentials are passed through environment variables, and the adapter
sets:

- `SPROUT_SECRET_BACKEND=memory`
- `SPROUT_DEFAULT_BEST_MODEL=<provider:model>`
- `SPROUT_DEFAULT_BALANCED_MODEL=<provider:model>`
- `SPROUT_DEFAULT_FAST_MODEL=<provider:model>`

That makes benchmark runs ephemeral and consistent across root and child agents
without requiring an OS keychain inside the container.

## Harbor runner usage

Point Harbor at this directory:

```bash
cd inspo/harbor-runner
./launch.sh \
  --agent-dir /path/to/sprout/tools/harbor \
  --agent-import-path sprout_agent:SproutAgent \
  --model openrouter/openai/gpt-4o-mini \
  --benchmark terminal-bench@2.0 \
  --tasks 1 \
  --reps 1
```

The adapter downloads `agent-state/` from the container and copies
`agent-state/trajectory.json` to the Harbor-visible `agent/trajectory.json`
location for the viewer.
