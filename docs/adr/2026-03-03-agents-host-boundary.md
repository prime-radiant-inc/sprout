# ADR: Agents-Host Dependency Boundary

- Status: Accepted
- Date: 2026-03-03

## Context

The architecture audits identified boundary drift where `src/agents` imported `src/host` modules directly.
This increases coupling and makes refactors riskier, because agent runtime behavior becomes tied to host-layer concerns.

## Decision

1. `src/agents/**` must not import from `src/host/**`.
2. Cross-layer utilities needed by both layers are moved to shared modules under `src/core/**`.
3. Compatibility re-exports are allowed in `src/host/**` for incremental migration.
4. A fitness test enforces the boundary: `test/architecture/dependency-boundaries.test.ts`.

## Consequences

- Positive:
  - Cleaner layering between agent orchestration and host runtime.
  - Faster, safer refactors in `host` and `agents`.
  - Explicit guardrail catches regressions automatically.
- Tradeoff:
  - Some shared code now exists behind compatibility re-export paths while migration completes.

## Implementation Notes

- Shared modules introduced:
  - `src/core/compaction.ts`
  - `src/core/logger.ts`
- Host compatibility wrappers:
  - `src/host/compaction.ts`
  - `src/host/logger.ts`
- Agent imports now target `src/core/**` directly.
