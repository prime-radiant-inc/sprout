# God-Object Audit and Cleanup Plan

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audits Index](../audits/README.md)
- [Audit Refactor Backlog](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
<!-- DOCS_NAV:END -->

**Date:** 2026-05-20  
**Status:** Draft (documentation-only)  
**Goal:** Reduce runtime and maintenance risk from god-object/kitchen-sink modules with behavior-preserving extraction.

## 0) Contract from conversation (authoritative source)

The clean-up contract is already defined by prior planning context:

- Use a **characterization-first** approach.
- Add **compatibility facades** first.
- Refactor in **small, behavior-preserving seams**.
- Keep existing public entrypoints and event contracts stable where possible.
- Prioritize modules in this order:
  1. `src/genome/genome.ts`
  2. `src/host/session-controller.ts`
  3. `src/host/settings/control-plane.ts`
- Treat follow-up modules as medium-priority follow-ons:
  - `src/host/observer-registry.ts`
  - `src/bus/genome-service.ts`
  - `src/learn/learn-process.ts`

## 1) Current severity assessment (from existing audits)

### High severity

1. **`src/host/settings/control-plane.ts` / settings command boundary**
   - Single module currently responsible for command routing, repository behavior, validation, secret lifecycle, OAuth side effects, model catalog state, and response assembly.
   - This is the largest runtime boundary risk for contract drift, because mutation semantics and snapshot assembly are co-located without clear seams.

2. **`src/host/session-controller.ts` command/state fanout path**
   - Historically identified for command dispatch, child/parent event flow, and session lifecycle orchestration complexity.
   - Previous refactor plans already split command/state concerns, but long-lived robustness risks remain when complexity re-accumulates.

3. **`src/genome/genome.ts` god-object behavior**
   - Audits identified this file as spanning storage + domain model + transaction management + CLI-facing orchestration in one class.
   - High maintenance burden and hard-to-test behavior boundary.

### Medium severity

4. **`src/host/observer-registry.ts`**
   - Runtime observer registration currently mixes lookup, lifecycle, and policy behavior; follow-up extraction should isolate registry + policy evaluation + event wiring concerns.

5. **`src/bus/genome-service.ts`**
   - Mutation path, learn bridge, and bus message translation responsibilities currently sit in one component.

6. **`src/learn/learn-process.ts`**
   - Mixes extraction decisioning, threshold handling, and side-effect queues alongside mutation emission and evidence handling.

## 2) Proposed service/module boundaries

### A) `src/host/settings/control-plane.ts` split targets

Split by seams already identified in the existing cleanup memory:

1. **`CommandRouter`**
   - Parse/dispatch inbound settings commands into typed actions.
   - Keep command-name routing in one place.

2. **`SettingsRepository`**
   - Read/write persisted settings models.
   - Keep file/env/secrets boundaries explicit.

3. **`SettingsValidator`**
   - Pure validation for command payloads and state transition preconditions.
   - Return field-level validation results consistently.

4. **`RuntimeSnapshotBuilder`**
   - Build `SettingsSnapshot` and warning/error surfaces.
   - Keep snapshot shape stable for web/TUI consumers.

5. **`SecretStoreCoordinator`**
   - Secret CRUD orchestration and redaction-safe error propagation.

6. **`OauthCoordinator`**
   - OAuth lifecycle, callback/result handling, and cleanup pathways.

7. **`ModelCatalogService`**
   - Model/catalog discovery and publish of catalog metadata.

8. **`ModelSelectionService` (shared)**
   - Shared selection logic currently duplicated across control-plane/session/agents.
   - Ensure single canonical runtime path.

### B) `src/host/session-controller.ts` stable seams

Build from existing decomposition progress and keep behavior intact:

- Keep public class + eventing contract stable.
- Extract/reinforce:
  - command dispatch map (including guard and fallback semantics)
  - session state transitions
  - metadata side-effects
  - settings/settings-change observers where appropriate

### C) `src/genome/genome.ts` split targets

Define explicit module boundaries for storage-first decomposition:

- `GenomeStore` (I/O, on-disk schema, JSONL/git writes)
- `GenomeCatalog` (agent/prompt/tool registry + discovery)
- `GenomeMutationService`-style mutation adapters
- `GenomeReconciliationService` (reconcile / bootstrap / sync)
- `GenomeTransactionCoordinator` (begin/commit semantics for multi-step writes)

### D) follow-up seams (phase-later)

- `observer-registry.ts`: split registry model, attach/eject policy, and event dispatch policies.
- `bus/genome-service.ts`: split mutation request mapping, contract translation, and persistence calls.
- `learn-process.ts`: split extraction planning, action queueing, threshold decisions, and mutation emission.

## 3) Cleanup phases and first tasks

### Phase 0 — Baseline characterization

- Freeze behavior via tests before edits.
- Add/extend characterizing tests at all public seams for:
  - settings commands + snapshot read paths
  - command controller behavior
  - genome mutations that currently enter from CLI/bus/session
  - learn mutation enqueue / extraction trigger decisions
- Add/verify tests that assert: invalid inputs fail gracefully, unchanged input paths unchanged output.

### Phase 1 — Compatibility façades (no behavior migration yet)

- Introduce façade interfaces for each target module so existing consumers are unchanged.
- Route old callers through new facades (thin delegation only).
- This phase creates the safe rollback point.

### Phase 2 — Control-plane extraction (highest risk first)

- Implement the seam split listed in section 2A.
- Keep command shapes, snapshot field names, and result envelopes unchanged.
- Add deprecation-safe compatibility checks in facade layer:
  - command handling remains stable
  - snapshot consumers remain stable
  - secret and OAuth side effects stay no-widened.

### Phase 3 — `genome.ts` extraction

- Introduce service boundaries from 2C.
- Move persistence, discovery, and mutation behavior into modules with narrow interfaces.
- Maintain current orchestrated public API behavior via compatibility facade.

### Phase 4 — session-controller hardening pass

- Align with current partial decomposition baseline:
  - command map module
  - state transitions module
  - metadata updates module
- Remove any remaining mixed-responsibility logic into helper services.

### Phase 5 — Follow-up extraction pass

- Apply extraction to:
  - `src/host/observer-registry.ts`
  - `src/bus/genome-service.ts`
  - `src/learn/learn-process.ts`
- Keep behavior identical on public mutation + bus events + learn outcomes.

### Phase 6 — Integration lock-in

- Remove temporary compatibility shims once call sites and tests prove seam stability.
- Add boundary tests for cross-module contracts.
- Update documentation for module ownership.

## 4) Milestones by file set

1. `control-plane` seam ownership (phase 2)
2. `genome.ts` seam ownership (phase 3)
3. `session-controller` seam ownership (phase 4)
4. Observer/learn/bus seam ownership (phase 5)

## 5) Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Command contract drift | Web/TUI/API behavior regression | Characterization tests before each seam; façade compatibility in every phase. |
| Partial migration without rollback path | Hard-to-revert regressions | Keep old and new paths behind delegates until full seam parity established. |
| Cross-service cyclic dependencies | Build/test coupling, brittle imports | Define pure interfaces and boundary DTOs first; avoid direct deep imports in phase 2 onward. |
| Test suite noise after behavioral split | False signal | Preserve current event and snapshot shapes; keep existing test fixtures before adding granular tests. |
| Scope creep (extra refactors) | Missed deadlines | Enforce phase gates and finish one file family at a time per priority order. |

## 6) Test strategy

### Gate 1: characterization
- Add or verify focused tests for known public command/API/emit shapes before refactor.

### Gate 2: per-phase regression
- After each phase:
  - run targeted test files touching affected modules
  - run `bun run typecheck`
  - run `bun run lint` / formatting check via `bun run check`
  - run focused integration tests for affected surface.

### Gate 3: cleanup completion
- Ensure complete test and verification list passes:
  - unit/integration coverage around `genome`, `session-controller`, `settings/control-plane`, `observer-registry`, `genome-service`, `learn-process`
  - cross-module command and snapshot invariants remain stable
  - no behavior contract regression in web/TUI control surfaces

### Recommended minimum tests

- `test/host/settings-control-plane.test.ts`
- `test/host/session-controller.test.ts`
- `test/genome/genome.test.ts`
- `test/host/observer-registry.test.ts`
- `test/bus/genome-service.test.ts`
- `test/learn/learn-process.test.ts`
- `test/learn/learn-contract.test.ts` (or equivalent contract-focused learning test suite)

## 7) Definition of done (DoD)

- No public settings/session/genome API contract changed except intentional refactors.
- Shared seams have explicit module boundaries and ownership documented in docs.
- `control-plane` responsibilities are no longer monolithic and include the 8 named seams.
- `genome.ts` no longer centralizes unrelated persistence + domain + orchestration responsibilities.
- `session-controller` no longer blends command dispatch, state orchestration, and metadata persistence in one file block.
- `observer-registry`, `genome-service`, and `learn-process` extracted to narrow service modules.
- Regression coverage includes characterizing tests for each extracted seam.
- Type/lint/test verification is clean for touched module families.
- Documentation tracks remaining risks and confirms no temporary compatibility fallback remains for intentionally removed behavior.

## 8) Immediate next tasks (sprint-start)

1. Create/confirm characterization tests for:
   - settings command dispatch (`control-plane`)
   - mutation and reconcile entrypoints (`genome.ts`)
   - run-loop/session command pathways (`session-controller`)
2. Add compatibility facade layer for the first target (`control-plane`).
3. Split `control-plane` command handling into `CommandRouter` while preserving existing snapshot and response shape.
4. Add boundary tests that prove snapshot shape and mutation effects are unchanged.
