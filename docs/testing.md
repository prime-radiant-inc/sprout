# Testing

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](./README.md)
- [Architecture](./architecture.md)
- [Testing](./testing.md)
- [Plans Index](./plans/README.md)
- [Audits Index](./audits/README.md)
- [Delegation Quick Start](./QUICK_START_DELEGATION_GUIDE.md)
<!-- DOCS_NAV:END -->

## Quick Reference

```bash
bun run test:unit:parallel      # Unit tests only, parallel (recommended)
bun run test:unit               # Unit tests only, single process
bun test                       # Full suite with VCR replay (~15s, no API keys needed)
bun run test:integration       # Integration tests with VCR replay (<1s)
bun run test:integration:live  # Integration tests with real API calls (~200s, needs keys)
bun run test:integration:record  # Re-record VCR fixtures (~200s, needs keys)
```

## Test Categories

### Unit tests (`bun run test:unit` / `bun run test:unit:parallel`)

Fast, no external dependencies. Mock all LLM calls. These run in the pre-commit hook.
Selection is managed by lane scripts: `scripts/test-unit-files.sh` and `scripts/test-integration-files.sh`.

- `test/agents/*.test.ts` (excluding `*.integration.test.ts`)
- `test/genome/*.test.ts`
- `test/host/*.test.ts` (excluding `*.integration.test.ts`)
- `test/kernel/*.test.ts`
- `test/learn/*.test.ts` (excluding `*.integration.test.ts`)
- `test/tui/*.test.{ts,tsx}`
- `test/util/*.test.ts`
- `test/helpers/*.test.ts`

### Integration tests (`bun run test:integration`)

Test real LLM API interactions, agent loops, and end-to-end workflows. Use the VCR system (see below) to replay recorded API responses by default.

- `test/integration/e2e.test.ts` — Full pipeline: root agent init, file creation, learn, cross-session
- `test/agents/agent.integration.test.ts` — Agent with real LLM: delegation, genome recall
- `test/llm/anthropic.test.ts` — Anthropic adapter: text, tools, caching, streaming, thinking
- `test/llm/openai.test.ts` — OpenAI adapter: text, tools, streaming
- `test/llm/gemini.test.ts` — Gemini adapter: text, tools, streaming
- `test/llm/client.test.ts` — Client routing, middleware, streaming
- `test/learn/learn.integration.test.ts` — Learn pipeline with real LLM

## Provider Settings And Selection Coverage

The provider registry and settings UI span host bootstrapping, secret storage, model resolution, web transport, and the TUI. Coverage is split by seam:

- `test/host/settings-*.test.ts` covers XDG settings paths, settings persistence/recovery, env import, secret backends, and the settings control plane.
- `test/llm/provider-registry.test.ts` and `test/llm/model-catalog.test.ts` cover provider materialization and per-provider model discovery.
- `test/host/session-selection.test.ts`, `test/host/session-controller-selection.test.ts`, and `test/host/cli-resume.test.ts` cover canonical session selection, compatibility handling for bare model ids, and resume behavior.
- `test/web/protocol.test.ts`, `test/web/server.test.ts`, and `test/web/e2e.test.ts` cover browser transport, websocket settings commands, and live `settings_updated` propagation.
- `test/tui/settings-panel.test.tsx`, `test/tui/provider-settings-editor.test.tsx`, and `test/tui/app.test.tsx` cover the TUI settings flow and provider-aware `/model` behavior.
- `test/host/cli-interactive.test.ts` and `test/host/cli-web.test.ts` cover interactive wiring so web and TUI settings surfaces hit the same host control plane.

Provider-related tests use the in-memory secret backend or mocked shell commands instead of the real OS keychain. Web server tests bind to port `0` and read the assigned port back from the server to avoid parallel test collisions.

### Operator-facing entry points

- Web: open the settings panel from the status bar settings button.
- TUI: use `/settings`.
- Session model selection: `/model inherit`, `/model best`, `/model balanced`, `/model fast`, `/model providerId:modelId`, or `/model modelId`.

## VCR (Record/Replay) System

Integration tests use a VCR pattern: LLM API responses are recorded once and replayed in subsequent runs. This makes the full test suite run in ~15s with zero API calls.

### How it works

1. **Record mode** (`VCR_MODE=record`): Tests make real API calls. Requests and responses are saved to JSON fixture files in `test/fixtures/vcr/`.

2. **Replay mode** (default): Tests load saved responses from fixture files and return them sequentially. No API keys needed. The agent loop still runs normally — only the LLM `complete()` and `stream()` calls are intercepted.

3. **Live mode** (`VCR_MODE=off`): Tests hit real APIs without recording. Same as running without VCR.

### Default behavior

When no `VCR_MODE` env var is set, tests automatically use replay mode if fixture files exist. This means `bun test` just works out of the box — no configuration needed.

### Fixture files

Stored in `test/fixtures/vcr/` and committed to the repo:

```
test/fixtures/vcr/
  e2e/                    # E2E integration tests
  agent-integration/      # Agent integration tests
  llm-anthropic/          # Anthropic adapter tests
  llm-openai/             # OpenAI adapter tests
  llm-gemini/             # Gemini adapter tests
  llm-client/             # Client routing tests
  learn/                  # Learn pipeline tests
```

Each test case gets its own fixture file (one JSON cassette per test).

### Re-recording fixtures

When models change, adapters are updated, or test behavior changes, re-record:

```bash
# Re-record all integration tests (needs API keys)
bun run test:integration:record

# Re-record a specific test file
VCR_MODE=record bun test test/llm/anthropic.test.ts
```

API keys are loaded from `~/prime-radiant/serf/.env` via dotenv.

### Path substitution

The e2e and agent integration tests use temp directories with random names. The VCR system replaces real paths with placeholders (`{{WORK_DIR}}`, `{{GENOME_DIR}}`, `{{TEMP_DIR}}`) when recording and substitutes them back on replay. This keeps fixtures portable across runs.

### Writing VCR-enabled tests

**For tests that use `Client` (agent-level tests):**

```typescript
import { createVcr } from "../helpers/vcr.ts";
import { Client } from "../../src/llm/client.ts";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/my-tests");

test("my integration test", async () => {
    const vcr = createVcr({
        fixtureDir: FIXTURE_DIR,
        testName: "my-integration-test",
        realClient: Client.fromEnv(),  // only used in record mode
    });

    // Use vcr.client wherever you'd use a real Client
    const result = await createAgent({ client: vcr.client, ... });

    // ... assertions ...

    await vcr.afterTest();  // saves recording in record mode
});
```

**For tests that use provider adapters directly:**

```typescript
import { createAdapterVcr } from "../helpers/vcr.ts";
import { AnthropicAdapter } from "../../src/llm/anthropic.ts";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/llm-anthropic");

test("adapter test", async () => {
    const realAdapter = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY!);
    const vcr = createAdapterVcr({
        fixtureDir: FIXTURE_DIR,
        testName: "adapter-test",
        realAdapter,  // only used in record mode
    });

    const resp = await vcr.adapter.complete(req);
    // ... assertions ...

    await vcr.afterTest();
});
```

### Cassette format

Each fixture is a JSON file with this structure:

```json
{
  "recordings": [
    {
      "type": "complete",
      "request": { "model": "...", "messages": [...] },
      "response": { "id": "...", "message": {...}, "usage": {...} }
    },
    {
      "type": "stream",
      "request": { "model": "...", "messages": [...] },
      "events": [{ "type": "text_delta", "delta": "..." }, ...]
    }
  ],
  "metadata": {
    "recordedAt": "2026-02-24T...",
    "testName": "...",
    "providers": ["anthropic"]
  }
}
```

Calls are matched sequentially — the first `complete()` call gets the first recording, the second gets the second, etc. The `raw` field is stripped from responses to keep fixtures clean.

## Pre-commit Hook

The git pre-commit hook (`.githooks/pre-commit`) runs:

1. `biome check --staged` — Lint/format staged files
2. `tsc --noEmit` — Typecheck (incremental)
3. `TEST_JOBS=8 bun run test:unit:parallel` — Unit tests only (parallel, capped by default in hook)

Total: ~15s. Integration tests are NOT run on commit.

## Local Quality Automation

Install project hooks once per clone:

```bash
bun run hooks:install
```

Additional local automation commands:

```bash
bun run check:ci       # lint + typecheck + architecture + unit lane
bun run deadcode       # knip dead-code report (deps + exports, non-blocking)
bun run deadcode:runtime  # strict runtime gate (unresolved imports + trace checks)
bun run deadcode:trace  # validates known cross-entrypoint trace paths
bun run deps:cycles    # madge cycle report (root + web, non-blocking)
bun run deps:cycles:strict  # same as above, but exits non-zero on findings
bun run check:deep     # check:ci + deadcode + deps:cycles
FLAKE_RUNS=10 bun run test:flake  # rerun unit lane N times to catch flakes
```

The git pre-push hook (`.githooks/pre-push`) runs:

1. `bun run check:ci`
2. `bun run deps:cycles`

This keeps pre-commit fast and surfaces structural debt at push time without blocking on existing backlog.

## CI Considerations

For CI without API keys, `bun test` works out of the box (VCR replay). For CI that should verify real API compatibility, use `bun run test:integration:live`.
