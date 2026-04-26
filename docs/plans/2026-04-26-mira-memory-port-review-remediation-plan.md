# MIRA Memory Port Review Remediation Plan

> **For agentic workers:** Execute task-by-task. Do not start implementation until
> you have read this plan, `docs/plans/2026-04-25-mira-memory-port-design.md`,
> `docs/plans/2026-04-25-mira-memory-port-execution-plan.md`,
> `docs/reference/mira-memory-architecture.md`, and `AGENTS.md`.

**Goal:** Close the behavioral and quality-gate gaps found in the fresh branch
review without adding new memory features or broad refactors.

**Architecture:** Keep JSONL as source of truth, SQLite as rebuildable cache, and
local embeddings as the only production embedding path. Fix memory creation by
routing all automatic creation through the same extraction pipeline over real
evidence slices. Fix segment collapse by giving summary/extraction the context
the design requires and by triggering collapse at the correct lifecycle points.

**Tech Stack:** TypeScript on Bun, Bun test runner, Biome, existing Sprout genome,
host, bus, and learn modules.

---

## Scope

This plan addresses exactly these review findings:

1. Session-collapse extraction excludes root/assistant evidence and the prompt
   forbids using it.
2. `LearnProcess` still creates memory through an old LLM-selected
   `create_memory` mutation before extraction.
3. Bus learn signals still write raw `Learn signal (...)` memories.
4. Segment summary lacks previous summaries, and extraction lacks summary
   context.
5. Collapse trigger is success-only and lacks the designed goal-complete/idle
   semantics.
6. Relationship classifier has no real 50-pair eval/gate.

## Non-Goals

- Do not add Postgres, vector extensions, dynamic embedding providers, or
  embedding fallbacks.
- Do not change `RoutingRule` behavior.
- Do not rewrite memory storage, recall ranking, maintenance, or archivist
  authorization unless directly required by these fixes.
- Do not add a user portrait, UI, dashboard, batch API flow, or background daemon.
- Do not replace existing tests wholesale; update the tests that encode wrong
  behavior and add focused regression coverage.

## File Map

- `root/prompts/memory_extraction_system.txt`: source-grounding rule for user
  messages plus root-agent evidence.
- `src/genome/prompts.ts`: default extraction prompt mirror.
- `src/generated/embedded-root.ts`: regenerated embedded root after prompt edits.
- `src/genome/extraction.ts`: optional prompt rendering support for summary
  context if implemented there.
- `src/core/session-collapse.ts`: transcript selection, previous-summary context,
  bounded tool/delegation outcome text, extraction input, and collapse result
  shape if needed.
- `src/host/session-controller.ts`: lifecycle trigger policy for completed and
  idle collapses, including thrown terminal failures.
- `src/learn/learn-process.ts`: direct extraction from learn event-window
  evidence.
- `src/learn/extraction-evidence.ts`: shared learn evidence-window rendering if
  this keeps host and bus code DRY.
- `src/bus/learn-contract.ts`: stop converting signal requests into raw memory
  content.
- `src/bus/genome-service.ts`: route signal requests through extraction or back
  to the host learn process. Do not accept permanently unsupported signal writes.
- `test/host/session-collapse.test.ts`: update wrong user-only expectation and
  add previous-summary/summary-context coverage.
- `test/host/session-controller.test.ts`: lifecycle trigger coverage.
- `test/learn/learn-process.test.ts`: extraction input should be event-window
  evidence, not an LLM-created memory proposal.
- `test/bus/learn-contract.test.ts`: signal request stays a signal, not a raw
  `create_memory` mutation.
- `test/bus/genome-service.test.ts`: bus signal path produces extracted memory
  through the production learn/extraction path.
- `test/fixtures/memory/relationship-pairs.jsonl`: expand to 50 labeled pairs.
- `test/genome/relationship-classifier-eval.test.ts`: new fixture-driven eval
  gate.

## Design Decisions

### D1. Source-grounding policy

Use root-agent evidence as a memory source only when it is trace evidence from
the session: root plan summaries, root final output, tool outcomes, and
delegation outcomes. Do not treat arbitrary assistant speculation as durable
truth. This keeps the design's "Sprout sessions are mostly root narrating" rule
without storing hallucinated implications.

### D2. Learn memory creation

Automatic learn memory creation should not require an LLM to first choose
`create_memory`. The learn signal is already the trigger. For memory writes, the
implementation should synthesize an extraction evidence window from the relevant
session events: failed attempts, retries, tool errors, eventual success, or the
terminal state. A bare `LearnSignal` is useful metadata, not sufficient evidence
when the durable fact lives in tool output or retry history.

Keep the old mutation reasoning for non-memory actions only: `update_agent`,
`create_agent`, and `create_routing_rule`. Remove `create_memory` from that
reasoner prompt. Memory extraction and non-memory reasoning are separate
concerns: a signal may produce extracted memories and still justify a routing
rule or agent update.

### D3. Bus learn behavior

Route signal-style bus learn requests through the same extraction implementation
as host-side learn, or route them back into the host `LearnProcess`. Manual
mutation-style requests may continue to apply direct mutations because the
design explicitly keeps already-formed manual memory creation. Signal-derived
memory writes must not persist raw `Learn signal (...)` content, and they must
not become a permanent "unsupported" path in production.

### D4. Collapse lifecycle

Use the smallest lifecycle semantics that match the design:

- Collapse after a successful root run, as today.
- Collapse after timed-out or failed root runs when a `session_end` event exists
  and the run was not user-aborted. These sessions often contain durable failure
  lessons.
- Collapse after non-aborted thrown terminal failures when the agent already
  emitted and logged `session_end` before rethrowing.
- Do not collapse after user abort/interruption.
- Add an idle collapse hook only for sessions that can remain open after user
  turns. If the current controller always emits `session_end` per root run, this
  can be a small explicit helper and tests rather than a scheduler/daemon.

This is intentionally not a general background job system.

### D5. Relationship classifier eval

Use a two-layer gate. Unit tests should validate fixture shape and parser/prompt
plumbing without network access. A real classifier-quality gate must use recorded
VCR responses or an opt-in live eval against the actual classifier prompt. If no
recorded/live eval is added in this remediation pass, the completion report must
explicitly state that Phase 6's 50-pair, 80% quality gate remains unsatisfied.
Do not claim the gate is met with a mock that returns the expected label.

## Task 1: Fix Extraction Prompt Source Policy

**Files:**
- Modify: `root/prompts/memory_extraction_system.txt`
- Modify: `src/genome/prompts.ts`
- Modify: `src/generated/embedded-root.ts`
- Test: `test/genome/prompts.test.ts`

- [ ] Update the extraction system prompt to allow durable facts from
  user-authored content and root-agent evidence.

Expected rule shape:

```text
- Extract from user-authored content and from root-agent session evidence:
  plan summaries, final outputs, tool outcomes, and delegation outcomes.
- Assistant/root evidence is a source only for what happened, what was decided,
  what failed, or what was verified. Do not store unsupported speculation.
```

- [ ] Mirror the same default prompt text in `src/genome/prompts.ts`.

- [ ] Regenerate or update `src/generated/embedded-root.ts` using the repo's
  existing embedded-root generation path. If no generator exists, update the
  embedded prompt string mechanically and note that in the commit.

- [ ] Add/update prompt tests to assert the default extraction prompt mentions
  root-agent evidence and no longer says "only from user-authored content."

Run:

```bash
bun test test/genome/prompts.test.ts
```

Expected: prompt tests pass.

Commit:

```bash
git add root/prompts/memory_extraction_system.txt src/genome/prompts.ts src/generated/embedded-root.ts test/genome/prompts.test.ts
git commit -m "fix: allow root evidence in memory extraction prompt"
```

## Task 2: Pass Full Collapse Evidence Into Extraction

**Files:**
- Modify: `src/core/session-collapse.ts`
- Modify: `test/host/session-collapse.test.ts`

- [ ] Replace the user-only extraction filter with the same redacted transcript
  evidence used for segment summary.

Current wrong shape:

```ts
const extractionMessages = transcript.filter((message) => message.role === "user");
```

Target shape:

```ts
const extractionMessages = transcript.map((message) => ({
	role: message.role,
	content: message.content,
	timestamp: message.timestamp,
}));
```

- [ ] Update the existing user-grounding test so it expects root plan/final
  evidence to be available to extraction.

- [ ] Keep redaction coverage: secrets must still be redacted before both summary
  and extraction prompts.

- [ ] Add a regression test where a durable implementation detail appears only in
  a `plan_end` or `session_end` event and reaches the extraction prompt.

- [ ] Expand `act_end` transcript rendering to include bounded, redacted
  delegation result text. The design asks for delegation outcomes, not just
  "completed successfully." Include enough output to preserve durable facts while
  keeping collapse prompts compact.

Target behavior:

```text
Delegated agent engineer completed successfully.
Goal: stabilize local embeddings
Output: Fixed mdbr dense layer loading by using model2vec.safetensors.
```

- [ ] Expand `primitive_end` transcript rendering to include bounded, redacted
  tool result text when present. Preserve existing metadata, but do not reduce
  every tool result to "Tool X completed successfully."

- [ ] Add tests where the only durable fact appears in:
  - `act_end.data.tool_result_message` or `act_end.data.output`
  - `primitive_end.data.tool_result_message` or equivalent output field

- [ ] Bound long outcome text with a small local helper. Do not add a generic
  summarizer or another LLM call.

Run:

```bash
bun test test/host/session-collapse.test.ts
```

Expected: the old user-only expectation fails before implementation and passes
after the filter is removed.

Commit:

```bash
git add src/core/session-collapse.ts test/host/session-collapse.test.ts
git commit -m "fix: extract collapse memories from root evidence"
```

## Task 3: Add Previous Summaries and Summary Context to Collapse

**Files:**
- Modify: `root/prompts/segment_summary_user.txt`
- Modify: `src/genome/prompts.ts`
- Modify: `src/generated/embedded-root.ts`
- Modify: `src/core/session-collapse.ts`
- Test: `test/host/session-collapse.test.ts`

- [ ] Extend the segment summary user prompt with a previous-summary placeholder.

Target prompt shape:

```text
<previous_segment_summaries>
{previous_summaries}
</previous_segment_summaries>

<session_transcript>
{formatted_messages}
</session_transcript>
```

- [ ] Add a helper in `session-collapse.ts` that reads the latest five segment
  summaries for narrative continuity.

Minimal helper shape:

```ts
function recentSegmentSummaries(genome: Pick<Genome, "segments">): string {
	return genome.segments
		.all()
		.slice(-5)
		.map((segment) => `- ${segment.summary}`)
		.join("\n");
}
```

Use the actual local types and avoid broad `Genome` imports if a smaller input
type already exists.

- [ ] Update summary prompt rendering to replace both `{formatted_messages}` and
  `{previous_summaries}`. Missing previous summaries should render `(none)` or an
  empty string consistently; tests should lock the choice.

- [ ] Pass segment summary context into extraction without changing the extraction
  JSON schema. Do not inject the LLM-generated summary as an `assistant` message,
  because that makes generated text look like source evidence. Instead, add an
  explicit non-authoritative summary context placeholder to the extraction user
  prompt.

Target extraction prompt shape:

```text
<segment_summary_context>
{segment_summary}
</segment_summary_context>

<conversation>
{formatted_messages}
</conversation>
```

- [ ] Add prompt rules saying summary context helps interpretation, but extracted
  facts must be grounded in transcript messages. This keeps summary useful for
  continuity without letting summary hallucinations become durable memories.

- [ ] Update extraction prompt rendering to replace `{segment_summary}` when the
  caller provides it and to render `(none)` or an empty string consistently when
  omitted. Keep existing callers working.

Do this only after the extraction prompt permits root evidence. Keep
`source_segment_id` creation unchanged.

- [ ] Add tests proving:
  - summary prompt receives the previous five summaries, not all summaries
  - extraction prompt includes the current segment summary in the non-authoritative
    context block
  - extraction memories still receive `source_segment_id`

Run:

```bash
bun test test/host/session-collapse.test.ts test/genome/prompts.test.ts
```

Expected: summary/extraction context tests pass.

Commit:

```bash
git add root/prompts/segment_summary_user.txt root/prompts/memory_extraction_user.txt src/genome/prompts.ts src/generated/embedded-root.ts src/genome/extraction.ts src/core/session-collapse.ts test/host/session-collapse.test.ts test/genome/prompts.test.ts test/genome/extraction.test.ts
git commit -m "fix: include segment continuity in collapse prompts"
```

## Task 4: Extract Learn Memories Directly From Event-Window Evidence

**Files:**
- Modify: `src/learn/learn-process.ts`
- Optional Create: `src/learn/extraction-evidence.ts`
- Test: `test/learn/learn-process.test.ts`

- [ ] Add a small evidence builder that turns a `LearnSignal` plus available
  session events into extraction messages.

The evidence window should include the signal metadata and, when available, the
relevant root-session events around the failure/retry/timeout: tool calls,
errors, warnings, delegation outcomes, and terminal output. If session events
are not available at this call site, add the minimum plumbing needed to supply
them from the existing event log/session controller. Do not silently downgrade to
signal-only evidence for production behavior.

Target shape:

```ts
function learnSignalExtractionMessages(input: {
	signal: LearnSignal;
	events: readonly SessionEvent[];
}): ExtractionMessage[] {
	return [
		{
			role: "user",
			content: [
				"The following is a learn-pipeline observation.",
				`Signal kind: ${input.signal.kind}`,
				`Agent: ${input.signal.agent_name}`,
				`Goal: ${input.signal.goal}`,
				"Relevant event window:",
				renderLearnEvidenceEvents(input.events),
			].join("\n"),
			timestamp: input.signal.timestamp,
		},
	];
}
```

- [ ] Change memory creation so it calls `extractMemoryDrafts()` on this evidence
  slice. Do not first ask the LLM to write memory content.

- [ ] Run memory extraction and non-memory mutation reasoning as separate
  concerns:
  1. Run extraction from the event-window evidence and persist any memory drafts.
  2. Run the existing reasoner with `create_memory` removed from its prompt.
  3. Apply any returned `update_agent`, `create_agent`, or `create_routing_rule`
     mutation.
  4. Return `applied` if either path applied a change.

This keeps factual memories unified while preserving routing/agent mutation
behavior even when a signal also yields durable memory.

- [ ] Remove `create_memory` from the reasoner prompt or make its branch
  unreachable. This prevents future tests from depending on LLM-authored memory
  content.

- [ ] Update tests so the mock client's first completion is the extraction
  response, not a `create_memory` mutation response.

- [ ] Add a regression test that captures the extraction prompt and asserts it
  contains signal details and event-window evidence such as tool errors,
  delegation output, retries, and terminal state.

- [ ] Add a regression test where extraction returns a memory draft and the
  non-memory reasoner still creates a routing rule or agent update.

Run:

```bash
bun test test/learn/learn-process.test.ts test/genome/extraction.test.ts test/genome/dedup.test.ts
```

Expected: learn-generated memories still have entities and ready embeddings, and
the mock no longer needs a handcrafted `create_memory` response.

Commit:

```bash
git add src/learn/learn-process.ts src/learn/extraction-evidence.ts test/learn/learn-process.test.ts
git commit -m "fix: extract learn memories from event evidence"
```

If no shared helper module is created, omit `src/learn/extraction-evidence.ts`
from `git add`.

## Task 5: Unify Bus Learn Signal Writes With Extraction

**Files:**
- Modify: `src/bus/learn-contract.ts`
- Modify: `src/bus/genome-service.ts`
- Test: `test/bus/learn-contract.test.ts`
- Test: `test/bus/genome-service.test.ts`

- [ ] Stop resolving signal requests into raw `create_memory` mutations.

Target contract shape:

```ts
export function resolveLearnMutation(request: LearnRequest): LearnMutation | null {
	if (request.payload.kind === "mutation") return request.payload.mutation;
	return null;
}
```

Only use this exact shape if the existing callers can handle `null`; otherwise
split into `resolveExplicitLearnMutation()` and `isSignalLearnRequest()` to keep
types clear.

- [ ] Pick one production path and implement it fully:
  - Preferred: route bus signal requests back into the host-side `LearnProcess`
    so signal filtering, event-window evidence, extraction, and non-memory
    reasoning stay in one place.
  - Acceptable: give `GenomeMutationService` the same real extraction
    dependencies used by `LearnProcess`: client, model, provider, prompt loading,
    and event-window access.

Do not leave signal requests as permanently unsupported. A failed confirmation is
acceptable only for truly malformed requests or transient extraction errors, not
for normal bus-spawned learn signals.

Implementation shape if dependencies are already available:

```ts
if (req.payload.kind === "signal") {
	const drafts = await extractMemoryDrafts({
		client: this.client,
		model: this.model,
		provider: this.provider,
		prompts: await this.genome.loadMemoryExtractionPrompts(),
		messages: learnSignalExtractionMessages({
			signal: req.payload.signal,
			events: relevantEvents,
		}),
	});
	// dedup, memoryFromDraft, addMemories exactly like LearnProcess
}
```

- [ ] DRY the signal-to-extraction-message helper by exporting it from
  `src/learn/learn-process.ts` or moving it to a tiny shared module such as
  `src/learn/extraction-evidence.ts`. Prefer the shared module if exporting from
  `LearnProcess` would expose unrelated internals.

- [ ] Keep manual mutation requests working. Manual `create_memory` is allowed
  because the design keeps already-formed manual memory creation.

- [ ] Update bus tests:
  - signal request parsing still works
  - signal request no longer resolves to raw `Learn signal (...)` content
  - bus-spawned signal path extracts and persists a memory through the production
    path
  - missing extraction dependencies are not accepted as the normal production
    path
  - manual mutation request still persists an embedded memory

- [ ] Add an end-to-end test through the existing bus infrastructure where a
  `BusLearnForwarder` publishes a signal and the host path extracts a memory.
  Keep the LLM mocked/VCR-backed according to existing test patterns.

Run:

```bash
bun test test/bus/learn-contract.test.ts test/bus/genome-service.test.ts test/learn/learn-process.test.ts
```

Expected: no test asserts raw `Learn signal (...)` memory content.

Commit:

```bash
git add src/bus/learn-contract.ts src/bus/genome-service.ts src/learn/learn-process.ts src/learn/extraction-evidence.ts test/bus/learn-contract.test.ts test/bus/genome-service.test.ts test/learn/learn-process.test.ts
git commit -m "fix: route bus learn signals through extraction"
```

If no new shared module is created, omit it from `git add`.

## Task 6: Correct Collapse Trigger Semantics

**Files:**
- Modify: `src/host/session-controller.ts`
- Test: `test/host/session-controller.test.ts`
- Optional Modify: `src/core/session-collapse.ts`

- [ ] Replace success-only collapse gating with a small named predicate.

Target shape:

```ts
function shouldCollapseRun(result: AgentRunResult, signal: AbortSignal): boolean {
	if (signal.aborted) return false;
	return true;
}
```

Use the existing concrete result type in this file. If the controller can
distinguish user interruptions from agent timeouts, keep user interruptions
excluded and allow failed/timed-out terminal sessions.

- [ ] Add tests proving:
  - successful run collapses
  - failed terminal run collapses
  - timed-out terminal run collapses
  - non-aborted thrown terminal error collapses when `session_end` was already
    emitted/logged
  - user-interrupted run does not collapse

- [ ] Add controller error handling around `result.agent.run()` so terminal
  thrown errors can still trigger collapse before the error is rethrown or
  surfaced. Do not swallow the original error. The catch path must first verify
  that a terminal `session_end` event exists for the session; setup/runtime
  exceptions before terminal evidence must not collapse.

Target shape:

```ts
try {
	const runResult = await result.agent.run(goal, signal);
	if (shouldCollapseRun(runResult, signal)) {
		await stopLearnProcess();
		await this.collapseMemoryAfterRun(result);
	}
	return toSessionRunResult(runResult);
} catch (error) {
	if (!signal.aborted && hasTerminalSessionEnd(this._sessionId)) {
		await stopLearnProcess();
		await this.collapseMemoryAfterRun(result);
	}
	throw error;
}
```

Use existing local helpers/types if they exist; the example is shape, not exact
code. If `collapseMemoryAfterRun()` is the cleaner place for this guard, make it
a no-op unless the event log contains terminal `session_end`.

- [ ] Evaluate whether an actual idle watcher is necessary. If Sprout's current
  root run model emits `session_end` for every terminal run and does not keep a
  mutable open segment between runs, do not add a scheduler. Instead, document in
  the test name or local comment that terminal `session_end` is the current
  Sprout equivalent of `goal_complete`.

- [ ] If there is a real open-idle session path, add a tiny helper that can be
  called by that path. Do not add a process-wide background daemon.

Run:

```bash
bun test test/host/session-controller.test.ts test/host/session-collapse.test.ts
```

Expected: collapse runs for all non-aborted terminal sessions and remains skipped
for user interruption.

Commit:

```bash
git add src/host/session-controller.ts test/host/session-controller.test.ts
git commit -m "fix: collapse non-aborted terminal sessions"
```

Include `src/core/session-collapse.ts` only if changed.

## Task 7: Add the Relationship Classifier Eval Gate

**Files:**
- Modify: `test/fixtures/memory/relationship-pairs.jsonl`
- Create: `test/genome/relationship-classifier-eval.test.ts`
- Optional Modify: `test/genome/relationship-classifier.test.ts`
- Optional Create/Modify: VCR cassette or opt-in live eval helper following
  existing repo patterns

- [ ] Expand `relationship-pairs.jsonl` to exactly 50 labeled examples.

Coverage requirements:

```text
conflicts: at least 5
supersedes: at least 5
corroborates: at least 5
refines: at least 5
precedes: at least 5
contextualizes: at least 5
exemplifies: at least 5
null: at least 10
```

- [ ] Explicitly decide how to handle `extraction_ref`. It is a persisted
  relationship type in `RelationshipType`, but the classifier currently excludes
  it. Either add fixture coverage if the classifier should produce it, or document
  in the test that `extraction_ref` is system-generated and excluded from the
  classifier eval.

- [ ] Include hard nulls: same project/topic but no actionable relationship.

- [ ] Include MIRA/Sprout-specific examples for local embeddings, SQLite vs
  Postgres, no fallbacks, archivist authorization, collapse extraction, bus learn
  signals, relationship healing, and subcortical opt-in.

- [ ] Add a fixture loader that validates every JSONL row has source, target,
  expected relationship type, and either recorded classifier output or a stable
  key used by the VCR/live-eval harness.

- [ ] Add a deterministic no-network test for fixture shape and parser/prompt
  plumbing:
  - build `Memory` objects from each fixture row
  - render classifier prompts for each pair
  - assert every label is represented and prompt rendering includes pair content
  - normalize recorded classifier JSON if recorded outputs exist

This test does not satisfy the quality gate by itself.

- [ ] Add one real classifier-quality path:
  - Preferred: VCR replay test with recorded outputs from the actual
    `classifyMemoryRelationship()` prompt over all 50 pairs.
  - Acceptable: opt-in live eval command/test that is skipped by default and
    clearly reports agreement.

- [ ] The quality gate is satisfied only if the real classifier-quality path
  reaches at least 80% agreement. If this remediation pass only adds the fixture
  and no real classifier output, update docs to say Phase 6 quality remains
  unsatisfied.

Run:

```bash
bun test test/genome/relationship-classifier.test.ts test/genome/relationship-classifier-eval.test.ts
```

Expected: fixture tests cover 50 pairs without network. If VCR replay is added,
the replayed classifier agreement is at least 80%. If only an opt-in live eval is
added, the default test suite must not claim the live quality gate has passed.

Commit:

```bash
git add test/fixtures/memory/relationship-pairs.jsonl test/genome/relationship-classifier-eval.test.ts test/genome/relationship-classifier.test.ts
git commit -m "test: add relationship classifier eval fixture"
```

If `relationship-classifier.test.ts` is unchanged, omit it.

## Task 8: Integration Sweep

**Files:**
- Modify as needed only for test fallout from prior tasks.
- Modify: `docs/plans/2026-04-25-mira-memory-port-status.md`
- Modify: `docs/plans/2026-04-25-mira-memory-port-completion-report.md`

- [ ] Run the focused memory suite:

```bash
bun test test/host/session-collapse.test.ts test/host/session-controller.test.ts test/learn/learn-process.test.ts test/bus/learn-contract.test.ts test/bus/genome-service.test.ts test/genome/extraction.test.ts test/genome/dedup.test.ts test/genome/prompts.test.ts test/genome/relationship-classifier.test.ts test/genome/relationship-classifier-eval.test.ts
```

- [ ] Run typecheck:

```bash
bun run typecheck
```

- [ ] Run check:

```bash
bun run check
```

- [ ] Run full precommit:

```bash
bun run precommit
```

- [ ] Update the MIRA status doc with the remediation pass:
  - extraction source policy fixed
  - learn signal extraction unified
  - bus signal raw-memory path removed or explicitly blocked without dependencies
  - segment continuity context added
  - collapse lifecycle predicate corrected
  - relationship eval fixture added

- [ ] Update the completion report residual risks. Remove claims that are no
  longer accurate, especially any claim that Phase 6's eval gate is satisfied
  unless the new 50-pair gate exists and passes.

- [ ] Commit docs and any final fallout:

```bash
git add docs/plans/2026-04-25-mira-memory-port-status.md docs/plans/2026-04-25-mira-memory-port-completion-report.md
git commit -m "docs: record mira memory remediation pass"
```

## Final Verification Checklist

- [ ] No extraction prompt says memories must come only from user-authored text.
- [ ] Collapse extraction prompt includes root plan/final/delegation evidence.
- [ ] Collapse transcript includes bounded, redacted tool and delegation result
  text, not only generic completion strings.
- [ ] Collapse summary prompt includes only the latest five previous segment
  summaries.
- [ ] Collapse extraction prompt includes the current segment summary as
  non-authoritative context.
- [ ] LearnProcess memory creation uses event-window evidence, not a bare
  `LearnSignal` summary and not an LLM-created `create_memory` draft.
- [ ] LearnProcess can apply extracted memories and non-memory mutations for the
  same signal when both are warranted.
- [ ] Bus signal learn requests do not persist raw `Learn signal (...)` memories.
- [ ] Bus signal learn requests are supported through the production extraction
  path or host `LearnProcess`; they are not permanently unsupported.
- [ ] Manual direct memory creation still works and still embeds.
- [ ] Non-memory learn mutations still work where tests cover them.
- [ ] Non-aborted failed/timed-out terminal sessions collapse.
- [ ] Non-aborted thrown terminal failures collapse when `session_end` exists.
- [ ] User-aborted sessions do not collapse.
- [ ] Relationship eval fixture has 50 rows and covers every relationship type.
- [ ] Phase 6 classifier quality is either proven with recorded/live actual
  classifier output or explicitly marked unsatisfied in the completion report.
- [ ] `bun run precommit` passes.

## Expected Commit Order

1. `fix: allow root evidence in memory extraction prompt`
2. `fix: extract collapse memories from root evidence`
3. `fix: include segment continuity in collapse prompts`
4. `fix: extract learn memories from event evidence`
5. `fix: route bus learn signals through extraction`
6. `fix: collapse non-aborted terminal sessions`
7. `test: add relationship classifier eval fixture`
8. `docs: record mira memory remediation pass`

Keep commits this small. If any task uncovers a deeper architectural surprise,
stop and update this plan before continuing.
