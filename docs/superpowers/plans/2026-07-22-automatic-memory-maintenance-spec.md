# Automatic memory maintenance — spec

Status: PROPOSED (discussion doc — nothing implemented)
Date: 2026-07-22
Context: the kill-with-judgment sweep (d02d02e) deleted the automated
maintenance-decision lane because nothing wired it. Jesse asked what making
maintenance automatic would take. This spec is the answer.

## Goal

Memory consolidation (merge near-duplicate memories) and entity GC (alias
cleanup) run unattended on their existing activity-day cadence, with LLM
decisions replacing the human decision file — without weakening any of the
protections the manual flow enforces.

## Non-goals

- No new discovery, clustering, validation, or apply logic. The surviving
  production flow (discover → validate → apply) is untouched; only the
  DECISION step becomes automatic.
- No change to the manual CLI flow — `--genome maintain` with a decision
  file keeps working and stays the escape hatch.
- Not routed through the frozen adoption gate (see "Immutability line").

## What already exists (survived the sweep)

- `discoverMemoryMaintenancePlan` — per-project cadence built in
  (`projectDueForConsolidation` ≥14 active days, `projectDueForEntityGc`
  likewise), cluster/group limits, global-project handling.
- `applyMemoryMaintenanceDecisions` — atomic (commit-or-restore envelope via
  `applyMemoryAndProjectActivityMutation`), validates every decision,
  THROWS on consolidating a protected manual/user memory without explicit
  confirmation, stamps `markConsolidated`/`markEntityGc` cadence.
- The post-session maintenance hook (session-agent-factory `collapseMemory`
  closure): already runs project-activity recording, session collapse,
  score recompute, and `compactMemoryLogIfDue` — the natural trigger site.
- Settings plumbing: `memoryModels.consolidation` (default tier: balanced)
  and `memoryModels.entityGc` (default: fast) exist and are currently
  consumer-less; this feature re-consumes them. C8 ruling applies: a
  missing tier falls back to the best available model.

## What comes back from git (commit d02d02e^)

Restored verbatim with their tests, no redesign:
- `requestConsolidationDecision` / `requestConsolidationDecisionWithSettings`
- `requestEntityGcDecision` / `requestEntityGcDecisionWithSettings`
- `renderMemoryConsolidationUserPrompt`, `renderEntityGcReviewUserPrompt`
- `normalizeConsolidationDecisionPayload`, `normalizeEntityGcDecisionPayload`

NOT restored: `reviewMemoryMaintenancePlanWithSettings` — replaced by the
driver below (the old aggregator had no protected-memory filtering and no
fail-safe semantics).

## Design

### Driver (new): `runMemoryMaintenanceIfDue`

Home: `src/genome/maintenance.ts` (beside discover/apply).

```
runMemoryMaintenanceIfDue(genome, {
  client, resolverSettings, modelsByProvider,
  now?, limit?,            // limit default 4 clusters + 4 groups per run
  statePath?,              // .cache/memory-maintenance-state.json
}): Promise<MaintenanceRunResult | { due: false } | { failed: string }>
```

1. **Throttle**: state file records `lastCheckedAt`; return `{due:false}`
   inside 24h (mirrors `compactMemoryLogIfDue`'s weekly pattern — the
   per-PROJECT 14-active-day cadence stays inside discovery; this global
   throttle only stops multiple same-day sessions from re-discovering).
2. **Discover** with the run limit. Empty plan → stamp state, done.
3. **Protected filter**: any consolidation cluster containing an
   `isProtectedManualMemory` member is AUTO-REJECTED (recorded in the
   decision file as a rejection, so cadence still advances). The automatic
   flow never populates `confirmed_memory_ids` — structurally incapable of
   touching user memories, same posture as the F2 scoring fix.
4. **Decide**: one LLM call per cluster (consolidation model, balanced
   default) and per group (entityGc model, fast default) via the restored
   requesters. A failed/unparseable decision degrades to REJECT for that
   item — never aborts the run, never merges by default.
5. **Apply** via the untouched `applyMemoryMaintenanceDecisions` (atomic,
   git-committed, cadence-stamped). Validation errors abort the apply
   atomically (restore envelope) and the run reports `{failed}`.
6. The whole driver is wrapped so the CALLER (session shutdown) can never
   be failed by maintenance: outer catch → log warning, return `{failed}`.

### Trigger

The post-session hook in `session-agent-factory`, after `recomputeMemoryScores`,
gated on: setting enabled AND NOT evalMode AND collapse models configured.
Same placement class as `compactMemoryLogIfDue`. No new scheduler, no
background process.

### Setting

`memoryMaintenance: "manual" | "auto"` in the settings control plane
(SettingsSnapshot), default `"manual"`. No env var. The CLI gains
`--genome maintain --auto` running the same driver ignoring the 24h
throttle — the dogfooding/diagnostic path before anyone flips the default.

### Cost envelope

Worst case per run: 4 balanced calls + 4 fast calls. Runs at most once per
24h per genome, and only when a project crosses 14 active days since its
last pass — amortized, a few balanced-tier calls per project per two weeks.
No A/B, no canaries, no sessions spawned.

### Immutability line

Consolidation/entity GC are memory HYGIENE, joining the existing
ungated-but-protected lifecycle class (scoring auto-archive, weekly
compaction) — not behavior evolution, so the frozen adoption chokepoint
does not apply. Routing each merge through the gate (~100 live sessions
per decision) was considered and rejected. The safety story is instead:
protected memories structurally unreachable, reject-by-default on any
uncertainty, atomic git-committed applies, `git revert` as rollback.

### Observability

Each apply is one git commit whose message carries the counts (extend
`applyMemoryMaintenanceDecisions`' commit message with merged/rejected
numbers). Driver failures log a warning through the session logger. No new
event kinds unless dogfooding shows we miss them.

## Phases (TDD each; loc estimates)

1. **Restore the decision lane** from d02d02e^ + its deleted tests
   (~250 loc, mechanical; re-point the two WithSettings tests at the
   restored functions).
2. **Driver** with throttle/protected-filter/reject-on-failure semantics
   (~150 src + ~250 test: due/not-due, protected cluster auto-reject,
   LLM-failure→reject, apply-failure atomicity, state stamping).
3. **Setting + trigger wiring** (~60 src + tests: auto runs post-session,
   manual doesn't, evalMode never).
4. **CLI `--auto`** (~30 loc + test).

## Open questions (Jesse)

1. **Entity GC on protected memories**: alias merges touch entity metadata
   on memories but never content. Allow on protected memories (aliases keep
   a full archive trail) or exclude them like consolidation? Spec currently
   ALLOWS; flipping to exclude is a two-line filter.
2. **Default**: ship `"manual"` and flip to `"auto"` after dogfooding via
   CLI `--auto`, or ship `"auto"` directly?
3. **Throttle**: 24h global + 14-active-day per project acceptable?
