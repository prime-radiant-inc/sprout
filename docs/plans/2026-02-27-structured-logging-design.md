# Structured Logging System Design

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a structured logging framework that logs every LLM call, tool execution, delegation, and lifecycle event to disk as JSON-L and optionally forwards to the event bus.

**Architecture:** A `Logger` service writes structured `LogEntry` records to session-scoped JSON-L files. Components receive logger instances via constructor injection. A `child()` method creates scoped loggers that inherit context (sessionId, agentId, depth, component). A Client middleware logs all LLM calls automatically; Agent adds rich context at debug level.

**Tech Stack:** TypeScript, Bun, existing EventBus

---

## Logger Interface

```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

type LogCategory =
  | "llm"          // LLM requests and responses
  | "agent"        // Agent lifecycle and delegation
  | "primitive"    // Tool execution
  | "learn"        // Learn process mutations
  | "compaction"   // Context compaction
  | "session"      // Session lifecycle
  | "system";      // Infrastructure and uncategorized

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  component?: string;
  agentId?: string;
  sessionId?: string;
  depth?: number;
  data?: Record<string, unknown>;
}

interface LogContext {
  component: string;       // Required: "agent", "web-server", "llm-client", etc.
  agentId?: string;
  sessionId?: string;
  depth?: number;
}

interface Logger {
  debug(category: LogCategory, message: string, data?: Record<string, unknown>): void;
  info(category: LogCategory, message: string, data?: Record<string, unknown>): void;
  warn(category: LogCategory, message: string, data?: Record<string, unknown>): void;
  error(category: LogCategory, message: string, data?: Record<string, unknown>): void;
  child(context: Partial<LogContext>): Logger;
}
```

Child loggers inherit and merge parent context. An Agent creates `logger.child({ agentId, depth })` and every log call from that agent carries those fields automatically.

## Storage and Output

### Log file location

`{genomePath}/logs/{sessionId}/session.log.jsonl`

Lives alongside the existing event log. One JSON object per line. All levels written to disk.

### Output channels

| Channel | Levels | Purpose |
|---------|--------|---------|
| Disk (JSON-L) | All | Audit trail. Full request/response bodies at debug level. |
| Event bus | info+ | Enables web UI log panel (future). New event kind: `"log"`. |
| stderr | warn+ | Dev console. Controlled by flag. |

### Log levels

| Level | Use |
|-------|-----|
| `debug` | Full LLM request/response bodies, tool arguments, internal state |
| `info` | LLM call metadata (provider, model, latency, tokens), delegations, lifecycle |
| `warn` | Retries, fallbacks, degraded operation |
| `error` | Failures, exceptions, unrecoverable issues |

### Example LLM call entry (info level)

```json
{
  "timestamp": 1709069234567,
  "level": "info",
  "category": "llm",
  "component": "llm-client",
  "agentId": "01HQXYZ...",
  "sessionId": "sess-abc",
  "depth": 0,
  "message": "LLM call completed",
  "data": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "latencyMs": 2340,
    "inputTokens": 1523,
    "outputTokens": 847,
    "cacheReadTokens": 1200,
    "finishReason": "tool_calls",
    "messageCount": 12,
    "toolCount": 5
  }
}
```

## Wiring

### Logger creation and distribution

```
CLI startup
  ├── creates root Logger (sessionId, genomePath, optional bus ref)
  ├── passes to WebServer({ ..., logger })
  ├── passes to SessionController({ ..., logger })
  ├── passes to Client via middleware: loggingMiddleware(logger)
  └── passes to createAgent({ ..., logger })
        ├── Agent creates child: logger.child({ agentId, depth })
        ├── Agent logs LLM calls at debug level (full context)
        ├── Agent passes logger to LearnProcess
        └── Agent passes logger to compactHistory()
```

### Dual-layer LLM logging

Two layers capture LLM calls at different granularity:

1. **Client middleware** — logs every `client.complete()` call at `info` level. Captures provider, model, latency, token counts. No agent context needed. Catches all calls including compaction.

2. **Agent-level** — logs at `debug` level with full agent context (agentId, depth, sessionId) and optionally full request/response bodies. Only covers agent planning calls.

Every LLM call gets at least an `info` entry from middleware. Agent planning calls additionally get a `debug` entry with rich context.

### Components that receive a logger

| Component | Context | What it logs |
|-----------|---------|-------------|
| WebServer | `{ component: "web-server" }` | Client connect/disconnect, commands received |
| SessionController | `{ component: "session-controller" }` | Session state transitions, command handling |
| Client (via middleware) | `{ component: "llm-client" }` | Every LLM request with provider, model, latency, tokens |
| Agent | `{ component: "agent", agentId, depth }` | Planning, delegation, tool execution, lifecycle |
| LearnProcess | `{ component: "learn" }` | Mutation evaluation, learn signals |
| compactHistory | `{ component: "compaction" }` | Compaction requests and results |

## Error Handling

- Log writes are fire-and-forget. Failed writes do not crash the caller.
- The logger creates the log directory lazily on first write.
- Event bus forwarding failures are silently swallowed.
- The logger never throws.

## Testing Strategy

- **Logger unit tests:** writes valid JSON-L to a temp file; child logger inherits and merges context; level filtering (debug only to disk, info+ to bus)
- **Middleware tests:** logs provider, model, latency, tokens after complete(); handles adapter errors (logs error entry); captures timing
- **Integration:** agent run with logger produces both middleware and agent-level entries
- **No mocks:** logger writes to real temp files; tests read and parse entries

## Scope Boundaries

### In scope
- Logger class with levels, categories, child loggers, component context
- JSON-L disk output
- Optional event bus forwarding (new `"log"` event kind)
- Logging middleware for Client
- Agent-level LLM call logging
- Pass logger to WebServer, SessionController, LearnProcess, compaction

### Out of scope
- Log rotation and cleanup
- Log viewer CLI tool
- Web UI log panel (bus events enable it later)
- Metrics aggregation
- Log shipping to external services
- Runtime category filtering
