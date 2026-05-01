# MIRA Memory Port — Implementation Prompt

This is the dispatch prompt for the agent (Claude Code session, sub-agent run, or
similar) that will execute the design at
[`2026-04-25-mira-memory-port-design.md`](./2026-04-25-mira-memory-port-design.md).

Paste the prompt below verbatim into the agent. The supporting docs it references
already exist in this repository.

---

## The prompt

```
You are implementing the MIRA memory port for Sprout. This is a substantial,
multi-phase project. Work the phases in order, gate each on tests, surface
decisions to the user when they actually need to be made.

## Read these in order before doing anything

1. docs/plans/2026-04-25-mira-memory-port-design.md
   — The plan you are executing. The source of truth for what to build, in
     what order, with what tradeoffs. Read in full. The 17 sections matter;
     don't skim.

2. docs/reference/mira-memory-architecture.md
   — The full MIRA architecture spec, including all prompts, the SQL schema,
     algorithm pseudocode, event catalog, function signatures, and a porting
     reference map. This is what you're porting from. When the design doc
     says "see §X.Y of MIRA spec," this is where to look.

3. AGENTS.md at repo root, and CLAUDE.md if present
   — Sprout's coding conventions, build/test commands, and lefthook hooks.
     Follow them. The pre-commit and pre-push hooks are not optional.

4. The relevant existing files the design touches:
   - src/genome/memory-store.ts (current keyword-search implementation)
   - src/genome/recall.ts (current deterministic recall)
   - src/genome/genome.ts (top-level genome object you'll wire into)
   - src/kernel/types.ts (Memory, RoutingRule, RecallResult definitions)
   - src/learn/learn-process.ts (current direct-write creation path)
   - src/llm/anthropic.ts, openai.ts, gemini.ts (cache_control insertion points)

Do not start writing code until you've read all of these. The design is
load-bearing — most of the design choices encode tradeoffs that aren't
obvious from the code alone.

## Working method

Phases are §13 of the design. Each phase has a quality gate. Don't proceed
to phase N+1 until phase N's gate is met.

Within a phase:
- Commit at logical units of work, not at the end of the phase. Several
  commits per phase is normal. Use Sprout's commit convention (see recent
  git log for style; conventional-commit prefixes are enforced by hook).
- Run targeted `bun test test/path/to/file.test.ts` after each meaningful
  change. Don't accumulate failing tests.
- TypeScript strict mode is on. `bun run typecheck` must pass at every
  commit.
- Biome will auto-format on commit. Don't fight it.

Between phases:
- Run the full test suite: `bun test`
- Run the pre-commit suite: `bun run precommit`
- If web UI files changed, run `bun run web:build`
- Update the status tracker (see below)
- Commit a phase-boundary marker commit message: "phase N complete: <name>"
- Then start the next phase

## Status tracking

Create and maintain docs/plans/2026-04-25-mira-memory-port-status.md
starting on your first run. The format:

  # MIRA Memory Port — Status

  ## Current phase
  Phase N — <name> (in progress / blocked / done)

  ## Phase log
  - Phase 1 — Foundation: done 2026-04-26, commit abc1234
  - Phase 2 — Extraction: in progress
  - ...

  ## Open issues
  - <issue> — see design §<N>; awaiting user decision
  - ...

  ## Deviations from design
  - <deviation> — <reasoning>

Update on every phase transition and whenever you hit something worth
noting. The user reads this when checking in on progress.

## Decision policy

HALT AND ASK THE USER WHEN:
- An unresolved open question from §14 of the design actually affects what
  you're about to write. The questions are there because they need answers;
  don't guess. §14.2 (project detection), §14.3 (subagent write permissions),
  and §14.11 (archivist write-tool authorization) have explicit decisions in
  the design; follow them unless the existing code makes them impossible.
  Specifically watch for unresolved §14.5 (qm-reconciler scope) and §14.12
  (recursive archivist).
- You discover an architectural conflict between the design and the
  existing code that wasn't anticipated. Don't paper over; surface it.
- A test you didn't write fails and the fix isn't obvious within ~15
  minutes of investigation.
- You're tempted to deviate from the design's tech choices (§4.3) or
  scope (§3, §15). The temptation is usually a signal that either the
  design is wrong or your understanding is. Either way, escalate.

PROCEED WITHOUT ASKING WHEN:
- Implementation details below the design's level of granularity (file
  paths beyond what §11 specifies, internal module organization within a
  file, function names, type aliases).
- Test cases and fixtures. Write thorough tests; don't ask permission
  for each.
- Field-level normalization paths within the documented memory schema.
- Choice of Bun-compatible package for a well-defined utility (e.g., which
  TF-IDF package). Pick one and note the choice in status.

## Specific guardrails

1. PRESERVE three Sprout primitives. Listed in design §3 "Stays."
   Especially: do not touch RoutingRule, do not bypass the genome git
   audit (every memory mutation commits to JSONL first, index second),
   do not change the learn pipeline's event detection — only how it
   writes.

2. DO NOT add features not in the design. §15 lists out-of-scope items.
   You will be tempted to add a user-model pipeline, sidebar agents,
   batch API integration, etc. — don't. They're explicitly excluded.

3. DO NOT skip phases. They're ordered by dependency. Phase 1's storage
   layer is the foundation for everything else; the link graph (Phase 6)
   genuinely depends on the scoring formula (Phase 7) being absent —
   you'll add scoring as a separate phase so each step is testable.

4. DO NOT replace the existing recall function's deterministic fast-path.
   The expensive surfacing pipeline runs once at session start; the
   per-delegation recall stays sub-millisecond. See design §6.1.

5. DO NOT pollute archivist's prompt with a surfaced memory block.
   Design §7.2 explains why. Surface the answer to the question, not
   the question's neighbors.

6. EMBEDDINGS: default to local MongoDB/mdbr-leaf-ir embeddings (768d)
   through Bun/Transformers.js. Preserve CodeMira's useful shape: fixed model,
   query/document asymmetry, no provider registry. Do not copy CodeMira's Python
   daemon or hnswlib. Do not add alternate production embedding providers or
   fallback behavior.

7. WORKTREES: Sprout has a .worktrees/ pattern. Use it for parallel
   experimental work but commit to main branches when the work is
   merge-ready. Don't accumulate long-lived worktrees.

8. PROMPTS go in genome/prompts/ as plain text files, not embedded
   strings. They're version-controlled with the rest of the genome.

## Phase-specific notes

Phase 1 (Foundation): there are no legacy users, so do not spend time on a
one-shot migration script. The riskiest remaining foundation work is the
production memory write path: every new memory must get a ready local embedding
before it is appended, and index rebuild/search must fail fast if that invariant
is broken.

Phase 2 (Extraction): the extraction prompt is the second-trickiest piece
in the whole project (after the link classifier). Iterate on it against
real session transcripts. Save outputs to data/users/{user_id}/extraction_outputs.jsonl
for debugging, mirror MIRA's pattern from cns/services/subcortical.py.

Phase 3 (Segment collapse): the goal_complete signal already exists in
the kernel; idle-timeout watch is new. Run it from src/core/session-collapse.ts
hooked off the orchestrator's session lifecycle.

Phase 4 (Surfacing pipeline): the per-session caching is critical. Verify
that recall() is sub-millisecond after the first call within a session.
If you accidentally make every delegation pay the surfacing cost, the
agent loops will be unusable.

Phase 5 (memory-tools and archivist): the archivist's system prompt is
the third-trickiest piece. Iterate on it. Quality gate is that a known
synthesis question gets a structured answer with cited memory IDs and
the answer is correct on a held-out eval set.

Phase 6 (Link graph): the relationship classifier prompt is the
trickiest piece. Use the version from MIRA's prompts/memory_relationship_classification.txt
as a starting point; it has 8 worked examples that are load-bearing.
Don't trim them.

Phase 7 (Decay): the per-project clock is the divergence from MIRA's
activity-day clock. Test the formula against a synthetic 90-day timeline
to verify expected decay curves before flipping it on for real data.

Phase 8 (Cache strategy): test cache hit rates on a 10-turn engineer
agent before and after. The numbers should move; if they don't, your
markers aren't where you think they are.

Phase 9 (Consolidation + entity GC): the consolidation rejection counter
is what prevents the same cluster from being repeatedly proposed and
rejected. Don't omit it.

Phase 10 (Subcortical pre-pass, optional): run a side-by-side eval
before merging. If the pre-pass doesn't improve recall measurably on a
30-query test set, leave it out.

## When you're done

When all phases are complete and their gates are met:
1. Run the full test suite one final time
2. Update the status tracker to "all phases complete"
3. Write a brief completion report at docs/plans/2026-04-25-mira-memory-port-completion.md:
   - Total commits, total time, phase-by-phase summary
   - Any deviations from the design
   - Any open issues that survived
   - A recommendation for what to tackle next (consolidation tuning,
     extraction prompt refinement, archivist eval set expansion, etc.)

## When you're stuck

The design doc has the answer for most things. The MIRA spec has the
answer for algorithmic details. CodeMira (https://github.com/taylorsatula/CodeMira)
is the closest precedent for adapting MIRA into a coding-context system —
worth consulting when adapting the extraction prompt, entity types, or
project detection.

For everything else that is unresolved: halt, surface the question to the user
with enough context to answer, wait for guidance.

Begin.
```

---

## Notes for the operator (Jesse)

A few things worth knowing before you dispatch:

- **The agent will be working autonomously over 8–10 weeks.** Plan to check in on
  the status tracker periodically
  (`docs/plans/2026-04-25-mira-memory-port-status.md`) rather than expecting a
  single-session completion.
- **Unresolved open questions from §14 of the design will surface as halts.**
  §14.2 (project detection), §14.3 (subagent writes), and §14.11 (archivist
  write authorization) are already decided in the design. Have answers ready
  for remaining high-likelihood halts, especially §14.5 (qm-reconciler scope)
  and §14.12 (recursive archivist).
- **The riskiest phases are 1, 2, 5, and 6.** Phase 1's write path must enforce
  ready local embeddings with no fallback. Phases 2 and 6 hinge on prompt quality and need real iteration.
  Phase 5 introduces a new agent into the tree. Plan to actually look at outputs
  during these phases rather than trusting the green tests.
- **Embeddings cost.** Local embeddings remove per-token embedding spend but do
  download/cache the local model on first use. Watch disk/cache behavior and
  inference latency instead of `OPENAI_API_KEY` budget.
- **The agent has access to the design doc, this prompt, AGENTS.md, and CLAUDE.md
  if present, but not to this conversation history.** If you've made decisions in
  conversation that aren't in the design doc, write them into the design before
  dispatching.
