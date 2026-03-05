# Dynamic Model Discovery

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

## Problem

Model tiers are hardcoded in `MODEL_TIERS` (model-resolver.ts). The table maps tier names to specific model IDs per provider. This rots — GPT-4.1 is already stale — and duplicates provider detection logic that `Client.fromEnv()` already handles.

## Design

### Core Idea

Each provider adapter queries its API for available models. A pattern matcher classifies models into tiers by name. No hardcoded model table.

### ProviderAdapter Changes

Add `listModels()` to the interface:

```typescript
export interface ProviderAdapter {
    name: string;
    complete(request: Request): Promise<Response>;
    stream(request: Request): AsyncIterable<StreamEvent>;
    listModels(): Promise<string[]>;
}
```

Each adapter implements this using its SDK's models API:
- **Anthropic**: `client.models.list()` → filter to `claude-*`
- **OpenAI**: `client.models.list()` → filter to `gpt-*`, `o1-*`, `o3-*`, `o4-*`
- **Google**: `client.models.list()` → filter to `gemini-*`, strip `models/` prefix

On API error, return an empty array (graceful degradation).

### Client Changes

Add `listModelsByProvider()`:

```typescript
async listModelsByProvider(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const [name, adapter] of this.adapters) {
        result.set(name, await adapter.listModels());
    }
    return result;
}
```

### Tier Classification

Replace `MODEL_TIERS` with a pattern matcher:

```typescript
type Tier = "best" | "balanced" | "fast";

function classifyTier(model: string): Tier | null {
    if (/opus|(?<!\w)pro(?!cess)/.test(model)) return "best";
    if (/sonnet/.test(model)) return "balanced";
    if (/haiku|mini|flash|nano/.test(model)) return "fast";
    return null;
}
```

Models that don't match any pattern are still available for selection — they just don't belong to a tier.

### resolveModel Changes

Currently takes `availableProviders: string[]`. New signature takes the pre-fetched model map:

```typescript
function resolveModel(
    model: string,
    modelsByProvider: Map<string, string[]>,
): ResolvedModel
```

When `model` is a tier name ("best", "balanced", "fast"):
1. For each provider in priority order
2. Find their models that classify as the requested tier
3. Return the first match

When `model` is a concrete ID: detect provider, verify it's in the map.

### Startup Flow

```
CLI startup
  → Client.fromEnv()
  → client.listModelsByProvider()    // one-time async call
  → pass modelsByProvider to:
      - getAvailableModels()         // for the web selector
      - SessionController            // for resolveModel at agent creation
  → WebServer receives flat model list as before
```

The model map is fetched once at startup and reused for the session lifetime.

### getAvailableModels Changes

```typescript
function getAvailableModels(modelsByProvider: Map<string, string[]>): string[] {
    const tiers = ["best", "balanced", "fast"];
    const models = new Set<string>();
    for (const providerModels of modelsByProvider.values()) {
        for (const m of providerModels) models.add(m);
    }
    return [...tiers, ...models];
}
```

### What Doesn't Change

- WebServer — still receives `availableModels: string[]`
- Web UI — still renders a flat list with a `<select>`
- Snapshot/API protocol — unchanged
