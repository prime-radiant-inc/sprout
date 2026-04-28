# LLM Client

Sprout uses a provider registry and native provider adapters. The runtime
resolves model tiers or exact model references before creating LLM requests.

## Provider Registry

Settings define enabled providers, provider kinds, secrets, defaults, and memory
model assignments. Env vars can override runtime model selection without
persisting changes to settings.

Source of truth:
- `src/host/settings/types.ts`
- `src/host/settings/store.ts`
- `src/host/settings/model-overrides.ts`
- `src/host/settings/control-plane.ts`

## Model Resolution

Agent `model` can be a tier or exact provider/model. Memory calls use separate
memory model purposes: extraction, summary, relationship, consolidation,
entityGc, and subcortical. Missing required memory models fail loudly.

Source of truth:
- `src/agents/model-resolver.ts`
- `src/shared/provider-settings.ts`
- `web/src/components/settings/ModelsPanel.tsx`

## Native Adapters

Anthropic, OpenAI, and Gemini use native APIs rather than one flattened schema.
Adapters convert Sprout `Request` and `Message` structures into provider calls
and convert responses back into Sprout messages, tool calls, finish reasons, and
usage accounting.

Source of truth:
- `src/llm/anthropic.ts`
- `src/llm/openai.ts`
- `src/llm/gemini.ts`
- `src/llm/types.ts`

## Streaming

Streaming emits normalized events for text deltas, tool call starts/ends, final
usage, and finish reason. Agent code can throttle chunks before sending them to
the UI.

Source of truth:
- `src/llm/types.ts:StreamEvent`
- `src/agents/agent.ts` streaming completion path
- `test/agents/llm-events.test.ts`

## Prompt Caching

Plan requests include provider-specific prompt-cache options when session id and
agent name are known. Anthropic uses cache control markers, OpenAI uses prompt
cache keys, and Gemini creates explicit cached-content resources for stable
system/tool payloads. Cache creation failures are not silently ignored.

Source of truth:
- `src/agents/plan.ts:buildPlanRequest()`
- `src/llm/anthropic.ts`
- `src/llm/openai.ts`
- `src/llm/gemini.ts`

## Logging

The client can be wrapped with logging middleware. Runtime logs are separate
from session event logs and are intended for diagnostics, not replay.

Source of truth:
- `src/llm/client.ts`
- `src/llm/logging-middleware.ts`
- `src/host/logger.ts`
