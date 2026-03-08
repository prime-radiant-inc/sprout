# Rethinking Genome Agent Overlays

**Status:** Proposal / Future Design  
**Date:** 2026-03-08  
**Author:** Architecture review (post-incident)

---

## 1. Current Architecture

The genome uses a two-layer agent resolution system:

- **Core agents** live in `root/agents/` within the project repository. These are version-controlled, shipped with Sprout, and treated as immutable at runtime.
- **Genome overlays** live in `~/.local/share/sprout-genome/agents/`. These are written by the learning system when it mutates an agent spec to capture operational improvements.

Resolution is name-based and overlay-wins: `genome.getAgent(name)` checks the overlay map first, falling back to core. There is no version comparison for resolution — if an overlay exists, it shadows the core agent unconditionally.

When the learning system decides to improve an agent (e.g., adding guidance to the reader's system prompt), it writes the **entire agent spec** — frontmatter and body — to the overlay directory with the version number incremented. From that point forward, the core version is invisible to the runtime.

### Version management

Versions are monotonically incremented on mutation but are **not used for resolution priority**. A core agent at version 5 will still be shadowed by a genome overlay at version 3 if the overlay exists. Versions exist for conflict detection during `syncRoot()` and for the export-learnings pipeline, not for determining which spec is active.

### Reconciliation mechanisms

Two reconciliation paths exist:

1. **`syncRoot()` in `genome.ts`** — Runs on session start. Uses a bootstrap manifest (`bootstrap-manifest.json`) with content hashes to detect when core agents have changed. If both core and genome have diverged for the same agent, it reports a conflict. It does **not** auto-resolve conflicts for agent body/frontmatter — only for the root agent's `tools` and `agents` lists (via 3-way merge).

2. **`qm-reconciler`** — A quartermaster sub-agent that can be manually invoked to reason about drift between core and genome. It reads both versions and recommends absorb/keep/merge. In practice, this agent is rarely invoked because there's no trigger or reminder to do so.

### Export learnings (reverse flow)

`export-learnings.ts` can stage evolved genome agents for human review and promotion back to core. This is the intended mechanism for "graduating" learned improvements into the canonical codebase. It correctly identifies genome-only agents (new) and evolved agents (version > core version), but skipping agents where genome version ≤ core version silently ignores the staleness problem described below.

---

## 2. The Problems

### 2.1 Silent shadowing with no staleness detection

Once an overlay is created, it shadows the core agent indefinitely. There is no mechanism to detect or warn when:

- The core agent has been significantly updated (new capabilities, restructured prompt, changed constraints)
- The overlay is older than the core version it shadows
- The overlay contains regressions relative to the current core version

The overlay simply wins by virtue of existing. A developer updating `root/agents/reader.md` with important improvements has no way to know those improvements are invisible to any user whose genome contains a reader overlay.

### 2.2 Full-spec replacement creates drift surface

Because overlays store the **complete agent spec** (not a diff or patch), every field becomes a potential drift point. The learning system may have only intended to add a paragraph of guidance to the system prompt, but the overlay also freezes:

- `max_turns` and other constraints
- `model` selection
- `tools` and `agents` lists
- `tags`

Any of these can regress if the core version updates them independently.

### 2.3 Reconciliation doesn't happen in practice

`syncRoot()` detects conflicts but doesn't resolve them — it returns a list of conflict names and relies on downstream code to handle them. The `qm-reconciler` agent can reason about conflicts, but:

- It's not automatically invoked on conflict detection
- There's no session-start warning like "⚠️ 2 agent overlays are stale"
- Users don't know overlays exist unless they go looking

The reconciliation infrastructure exists but sits unused in the common case.

### 2.4 Maintenance overhead compounds

Every core agent update potentially invalidates every genome overlay of that agent, across every user's genome. The combinatorial maintenance burden grows with:

- Number of core agents (currently 6 top-level, plus sub-agents)
- Number of users/genomes
- Frequency of core updates

There's no scalable way to keep overlays synchronized without either eliminating them or fundamentally changing what they store.

---

## 3. Real Examples From This Session

### Reader overlay: `max_turns` regression

The genome contained a `reader.md` overlay that had been created by the learning system to add operational guidance (e.g., better instructions for handling search results). However, the overlay was based on an older core version where `max_turns` was 20. The core `reader.md` had since been updated to `max_turns: 30` to address observed turn-limit issues.

The overlay silently imposed the old 20-turn limit, causing the reader to hit its ceiling more frequently. This was invisible — the system prompt looked reasonable, the guidance additions were genuinely useful, but the constraint regression was harmful.

### Command-runner overlay: diverged system prompt

A `command-runner.md` overlay existed with learned guidance additions. Meanwhile, the core `command-runner.md` had been restructured and improved. The overlay preserved the old prompt structure with the learned additions grafted on, missing the core improvements entirely.

### The discovery was accidental

These overlays were discovered during an unrelated debugging session. Without that accident, they would have continued silently degrading agent performance. There was no warning, no indicator in logs, and no scheduled reconciliation check.

---

## 4. Options

### Option A: Eliminate genome agent overlays entirely

**Mechanism:** The learning system writes improvements directly to `root/agents/*.md` files, creating git commits in the project repository. The genome directory stores only memories, routing rules, and genome-only agents (agents the learning system created from scratch that have no core counterpart).

**Pros:**
- Eliminates the entire category of staleness bugs
- Single source of truth for each agent
- Changes are visible in the project's git history
- No reconciliation needed — there's nothing to reconcile

**Cons:**
- Learned improvements become project-local, not portable across projects (the genome is currently shared)
- Mutations to core files may surprise developers who don't expect `root/agents/` to change outside of their own commits
- Requires write access to the project repo, which the genome directory doesn't
- Loses the "safe experimentation" property — bad mutations directly affect core files (though git makes rollback easy)

**Variant:** Write to a `root/agents/.learned/` directory that layers on top of core, keeping learned changes in the project repo but separated from hand-authored specs. This preserves single-repo visibility while avoiding direct mutation of authored files.

### Option B: Overlays with mandatory expiry (TTL)

**Mechanism:** Every overlay gets a `created_at` or `session_count` field. After N sessions (e.g., 20) or N days, the overlay is automatically retired — the core version resumes. The learning system must re-learn the improvement if it's still relevant.

**Pros:**
- Staleness is bounded in time
- Forces periodic re-evaluation of learned improvements
- Simple to implement (add field to frontmatter, check on load)

**Cons:**
- Good improvements are lost and must be re-learned, wasting tokens
- The right TTL is unknowable — too short loses value, too long doesn't solve staleness
- Doesn't prevent the staleness problem during the TTL window
- Adds operational complexity (users wonder why agent behavior changes)

### Option C: Overlays with drift detection and warnings

**Mechanism:** On session start, compare each overlay's content hash against the current core version's hash (using the bootstrap manifest). If the core has changed since the overlay was created, emit a visible warning. Optionally, auto-invoke `qm-reconciler` for conflicting overlays.

**Pros:**
- Preserves current architecture
- Makes the problem visible rather than silent
- Can be implemented incrementally (warnings first, auto-reconciliation later)

**Cons:**
- Warnings without enforcement become noise (alert fatigue)
- Still requires human or AI judgment to resolve each conflict
- Doesn't address the root cause — full-spec overlays will always drift
- Reconciliation quality depends on the reconciler agent's ability to merge prompt text

### Option D: Overlays only override frontmatter, never body

**Mechanism:** Overlays store only frontmatter overrides (e.g., `max_turns: 35`, `model: best`). The system prompt body always comes from the core version. Frontmatter fields in the overlay are merged on top of core frontmatter.

**Pros:**
- Eliminates prompt drift entirely — core prompt improvements always take effect
- Reduces the surface area of overlay divergence to a small set of typed fields
- Much easier to reconcile (field-level comparison, not text diffing)

**Cons:**
- Most learned improvements ARE prompt changes (added guidance, restructured instructions) — this option would prevent the learning system from improving prompts
- Frontmatter-only overlays have limited value
- Doesn't match the actual use case (the reader overlay's value was its prompt additions, not its frontmatter)

### Option E: Append-only guidance overlays

**Mechanism:** Overlays don't replace agent specs. Instead, the genome stores **supplementary guidance** for agents — additional instructions that are appended to (or injected into) the core agent's system prompt at runtime. The core spec (including all frontmatter) is always authoritative. Guidance overlays contain only the delta: the new paragraphs, rules, or examples the learning system wants to add.

**Pros:**
- Core agent updates take effect immediately — no shadowing
- Learned improvements are preserved and composed with core changes
- No reconciliation needed — guidance is additive by design
- The overlay is small and focused (a few paragraphs, not an entire spec)
- Similar to how `AGENTS.md` project-level guidance already works
- Frontmatter regressions (max_turns, model, etc.) are impossible

**Cons:**
- Cannot fix or override core prompt instructions that are wrong — only add to them
- Prompt length grows monotonically (though pruning/consolidation could address this)
- Requires changes to prompt assembly (inject guidance section) and learning system (emit guidance deltas instead of full specs)
- Some improvements genuinely require restructuring the prompt, not appending to it (though these arguably belong as core changes, not learned overlays)

---

## 5. Recommendation

**Primary recommendation: Option E (append-only guidance overlays)**

The fundamental insight is that the learning system and core development serve different purposes and operate at different cadences:

- **Core development** sets the agent's identity, capabilities, constraints, and base instructions. It changes through deliberate human decisions, reviewed via pull requests, versioned in git.
- **The learning system** discovers operational improvements through experience — "when searching, try grep before find" or "always verify file existence before editing." These are supplementary tips, not structural changes.

The current architecture conflates these by having the learning system produce complete spec replacements. This means a learned tip about search strategy also freezes the turn limit, model selection, tool list, and every other aspect of the spec. The fix is to separate the concerns:

1. **Core specs are always authoritative** for identity, constraints, tools, agents, and base prompt structure.
2. **Genome guidance** is supplementary text appended at runtime, similar to how `AGENTS.md` files inject project-specific context.
3. **The learning system emits guidance fragments**, not full specs. A mutation that would currently rewrite `reader.md` to add a paragraph instead produces a `reader.guidance.md` (or similar) containing just the new paragraph.

This eliminates the entire class of problems we experienced: the core reader can update `max_turns` to 30, restructure its prompt, add new tool instructions — and the genome's learned guidance ("prefer grep over find") composes cleanly on top without conflict.

**Fallback recommendation: Option A (eliminate overlays)** if the learning system's prompt improvements turn out to be low-value in practice. If most learned value lives in memories and routing rules rather than agent prompt changes, the simplest solution is to stop writing agent overlays entirely.

**Not recommended: Options B, C, or D.** TTL and drift detection treat symptoms rather than the root cause. Frontmatter-only overlays don't match the actual use case.

---

## 6. Migration Path

If Option E is adopted:

1. **Add guidance overlay support to prompt assembly.** When building an agent's system prompt, check for `{genomeRoot}/guidance/{agent-name}.md`. If it exists, append its content as a clearly delimited section (e.g., `## Learned Guidance`).

2. **Update the learning system's mutation pipeline.** Change `update_agent` mutations to emit guidance fragments instead of full specs. The `applyMutation()` function writes to `guidance/` instead of `agents/`.

3. **Migrate existing overlays.** For each overlay in `agents/`, diff it against the current core version. Extract the added/changed paragraphs as guidance. Delete the overlay. This can be a one-time script.

4. **Deprecate full-spec overlays.** Remove `updateAgent()` as a learning mutation target (keep it for `addAgent()` which creates genome-only agents). Remove overlay resolution from `getAgent()` for agents that have core counterparts.

5. **Simplify reconciliation.** With no full-spec overlays, `syncRoot()` conflicts become impossible for existing agents. The 3-way merge for root tools/agents lists remains for the root overlay (or is also eliminated if root stops being overlayable).

---

## 7. Open Questions

- **Should guidance have structure?** Free-form markdown is flexible but hard to deduplicate or prune. A structured format (list of rules with IDs) would enable the learning system to update or remove individual rules.

- **How does guidance interact with context limits?** If an agent accumulates extensive guidance over time, it consumes context window budget. Should there be a guidance size limit? Should the learning system consolidate old guidance periodically?

- **Should guidance be per-project or global?** Current genome overlays are global (shared across projects). Some learned guidance is project-specific ("this project uses Jest") while other guidance is universal ("verify files exist before editing"). The guidance system might benefit from both layers.

- **Can the learning system restructure core prompts?** Some improvements genuinely require changing the core prompt's structure, not appending to it. These should flow through the export-learnings pipeline as proposed contributions to core, not as runtime overlays. Is the current export-learnings pipeline sufficient for this, or does it need improvement?
