# Automatic memory maintenance — spec v2

Status: APPROVED — Jesse's rulings 2026-07-22: AUTO from day one
(default "auto"); provenance by ORDERING ONLY (no compaction grace
period); AGGRESSIVE limits (8+8 per run; cadences/throttle as spec'd);
IMPLEMENT NOW onto sap-completion-roadmap / PR #2.
Date: 2026-07-22 (v2 after two-reviewer adversarial pass; v1's central safety
mechanism was wrong — see "What v1 got wrong")
Context: the kill-with-judgment sweep (d02d02e) deleted the automated
maintenance-decision lane because nothing wired it. This specs wiring
consolidation + entity GC to run unattended.

## Goal

Memory consolidation (merge near-duplicate memories) and entity GC (alias
cleanup) run unattended on their existing activity-day cadences, with LLM
decisions replacing the human decision file — without weakening any
protection the manual flow enforces, and without the failure modes below.

## Non-goals

- No new discovery/clustering/validation logic beyond the hardening listed.
- The manual CLI flow stays intact and remains the escape hatch.
- Not routed through the frozen adoption gate (see "Immutability line").

## What v1 got wrong (verified findings; the design constraints of v2)

1. **Rejects are destructive state, not no-ops.** `rejectConsolidationCluster`
   mutates EVERY cluster member (annotation, `updated_at`,
   `consolidation_rejection_count`) and discovery drops a cluster at 2
   rejections — for the manual flow too. Entity-GC rejection is worse: one
   reject annotation suppresses the group from all future discovery, forever.
   So v1's "auto-reject protected clusters" would have WRITTEN to protected
   memories and then permanently buried their clusters, and v1's "LLM failure
   degrades to reject" would let one transient API error permanently suppress
   maintenance candidates.
2. **Entity GC has no protected-memory checks at all** — it rewrites
   `entity_links`/`annotations` on any memory.
3. **The restored normalizers are too lenient for unattended use**: a merge
   reply with no `aliases` field merges the whole group; canonical NAME is
   unvalidated (LLM can rename entities to arbitrary text); a consolidation
   draft's `entities` REPLACE the source union with arbitrary uuids;
   `draft.confidence` is accepted verbatim; draft text is uncapped.
4. **C8 fallback is not automatic**: `resolveMemoryModel` throws on a missing
   tier; the best-available fallback is local to LearnProcess. A bare restore
   would turn a settings gap into thrown decisions.
5. **Entity-GC cadence is 30 active days** (consolidation is 14); v1 said 14
   for both and priced the cost envelope off the wrong number.
6. **Apply embeds under the memory write lock**: `applyConsolidationMerge` →
   `stageMemoryForMutation` → network embedding call inside the
   commit-or-restore envelope — the starvation class A-F3 (9046235) just
   removed from incorporation.
7. **The prompts don't exist as loadable artifacts**: `MEMORY_CONSOLIDATION_PROMPT`
   exists but its loader was deleted as dead; an entity-GC system prompt
   exists nowhere (the old lane took it as a caller argument no caller built).
8. **Same-shutdown compaction can delete merged sources immediately** (no
   grace period in `removeArchivedOrSuperseded`), stripping the consolidated
   memory's `supersedes` links and live memories' links to the sources.
9. **Machine-merged memories re-enter clustering** — paraphrase-of-paraphrase
   drift with no generation cap while originals age out of the JSONL.
10. Throttle stamping/concurrency, hook placement details, and the CLI
    bootstrap cost were unspecified or wrong (details inline below).

## What already exists and is verified sound

- `discoverMemoryMaintenancePlan`: per-project cadence (consolidation ≥14,
  entity GC ≥30 active days), global-project handling, top-N limit.
- `applyMemoryMaintenanceDecisions`: atomic commit-or-restore envelope,
  full validation, protected-merge throw (unless explicitly confirmed),
  `markConsolidated`/`markEntityGc` cadence stamping.
- Settings fields `memoryModels.consolidation` (balanced) / `entityGc`
  (fast), currently consumer-less.
- The post-session sequence: `session-controller.collapseMemoryAfterRun`
  (root, non-eval, collapse-models-configured sessions only) → project
  activity → collapse → conditional `recomputeMemoryScores` →
  `compactMemoryLogIfDue` (a sibling factory field, not part of the
  collapse closure).

## Design (v2)

### Protected memories: filtered, never decided

Protected manual/user memories are removed from the DISCOVERY INPUT POOL
before clustering (the F2 posture: skip, not reject). They never appear in
clusters or entity-GC groups, are never written to, never consume limit
slots, and their clusters remain formable by the manual flow (which passes
an unfiltered pool). Entity GC gets the same pre-filter — closing the
existing "no protection in entity GC" hole for the automatic path. The
"structurally incapable" claim then holds by construction: protected
memories are simply not in the data the automatic flow operates on.

### Three-way decision semantics

- LLM decides MERGE → validated, applied.
- LLM decides REJECT (a genuine judgment) → persisted rejection: the
  existing 2-strike (consolidation) / permanent (entity GC) suppression is
  the system working as designed.
- DRIVER OR LLM FAILURE (throw, timeout, unparseable) → SKIP: no decision
  recorded, nothing mutated, the item stays discoverable next run.

### Normalizer hardening (restored code is modified, not verbatim)

- Entity GC: absent/empty `aliases` on a merge → REJECT-decision refused →
  treated as unparseable → SKIP. Canonical `name` must exactly match one of
  the group's occurrence names (no renames). Alias uuids already validate
  against the group.
- Consolidation: `draft.entities` is IGNORED — the merged memory's
  `entity_links` are always the union of source links (the LLM's job is the
  text, not entity rewiring). `draft.confidence` is ignored — derived as
  today's fallback (max source effective importance). Draft text hard-capped
  (2,000 chars; over-cap → skip). Invalid tags dropped as today.

### Model resolution

The driver preflights BOTH models before discovery, implementing the C8
fallback itself (try `resolveMemoryModel`, catch → `resolveModel("best")`,
catch → the run is skipped with a logged warning). No decision path can
throw on settings gaps.

### Prompts

Phase 1 adds a `loadMemoryConsolidationPrompt` loader (the overridable
prompt file already exists) and WRITES the missing entity-GC system prompt
(root prompt file + overridable map entry + loader). Genuinely new content.

### Lock hygiene (A-F3 pattern)

The driver pre-embeds each accepted merged draft OUTSIDE the write lock
(same throwaway-snapshot pattern as incorporation), and
`applyConsolidationMerge` gains an optional pre-embedded memory input so
no network call runs under the lock on the automatic path. The manual flow
keeps its current behavior (existing exposure, unchanged, noted).

### Trigger, throttle, ordering

- New sibling step in `collapseMemoryAfterRun`, invoked AFTER
  `compactMemoryLogIfDue`: newly archived merge-sources then survive in the
  JSONL until at least the NEXT weekly compaction (~a week of review
  window) instead of being deletable in the same shutdown. Provenance
  beyond that window: `consolidates_memory_ids` (survives compaction) and
  git history (every apply is one commit).
- Runs only when: setting is `"auto"` AND not evalMode AND collapse models
  are configured. Child/bus/eval/VCR sessions never reach this hook —
  enumerated as intended behavior.
- Throttle: `.cache/memory-maintenance-state.json`; the driver stamps
  `lastCheckedAt` BEFORE deciding (cost-bounding beats retry eagerness — a
  failed run waits out the 24h window). Read-check-write race between two
  same-moment shutdowns is accepted: stamp-first shrinks the window to
  milliseconds, and the loser's apply aborts atomically on the envelope.
- Generation cap: memories with source `"memory-consolidation"` are
  excluded from the clustering input (cap = 1). Merged-of-merged drift
  doesn't happen; revisit only if hygiene visibly suffers.
- A run whose applies yield merged=0 across 3 consecutive runs logs a
  warning naming the streak (silent-failure tripwire).

### Setting, kill switch, observability

- `memoryMaintenance: "manual" | "auto"` in the settings control plane,
  default `"auto"` (Jesse's ruling; "manual" is the opt-out). Checked once at run start; a mid-run flip does not
  abort (runs are seconds).
- Observability: the apply commit message carries merged/rejected counts;
  the state file records the last run's counts; failures log warnings via
  the session logger. No new event kinds until dogfooding demands them.

### Cost envelope (corrected)

Per project: ≤8 consolidation calls (balanced) per 14 active days and ≤8
entity-GC calls (fast) per 30 active days (Jesse: aggressive limit), gated additionally by the 24h
global throttle. Skipped items retry next run; genuine rejects don't repay.

## Immutability line

Hygiene ops join the ungated-but-protected lifecycle class (scoring
auto-archive, weekly compaction). Distinct from those, consolidation
CREATES content — the specific risks (hallucinated merges, drift,
provenance loss) are addressed above by strict validation, the generation
cap, entity/confidence derivation from sources, the compaction-ordering
review window, and git-revert rollback — not by the A/B gate, whose ~100
live sessions per decision is disproportionate to content hygiene.

## Phases (TDD each; loc estimates)

1. **Restore + harden the decision lane** from d02d02e^ (~250 restored, ~80
   modified: normalizer strictness, entity/confidence derivation) + restore
   the consolidation prompt loader + write the entity-GC prompt (~60).
   Tests: restored suites re-pointed + new strictness pins (~300).
2. **Driver** `runMemoryMaintenanceIfDue`: preflight/fallback, protected +
   generation pre-filters, three-way semantics, stamp-first throttle,
   pre-embedding, merged=0 streak warning (~200 src + ~350 test).
3. **Setting + trigger wiring** in `collapseMemoryAfterRun` after
   compaction (~60 src + tests incl. ordering + never-in-eval).
4. **CLI `--auto`**: reuses the cli bootstrap for client/settings/catalog
   (~80 loc + test — v1's 30-loc estimate ignored mandatory bootstrap).

## Rulings (2026-07-22)

1. Default `"auto"` from day one.
2. Ordering-only provenance window (no compaction grace period).
3. Aggressive per-run limit: 8 clusters + 8 groups; cadences 14/30 active
   days and the 24h global throttle unchanged.
4. Implement now, all four phases, onto this branch/PR.
