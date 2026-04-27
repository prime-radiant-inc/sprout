# Learn Process

The learn process turns agent stumbles into durable improvements. It has two
tracks: factual memory extraction from event evidence and non-memory mutations
such as agent updates, new agents, or routing rules.

## Signals

Verify code creates learn signals for failures, timeouts, retries, errors, and
inefficiency. Signals include agent name, goal, act result details, session id,
and timestamp.

Source of truth:
- `src/kernel/types.ts:LearnSignal`
- `src/agents/verify.ts`
- `src/agents/run-loop-finalize.ts`

## Filtering

Not every stumble triggers mutation. `shouldLearn()` checks repeated patterns,
recent improvements, and signal kind before allowing processing.

Source of truth:
- `src/learn/should-learn.ts`
- `test/learn/should-learn.test.ts`

## Processing Pipeline

The background process loads pending evaluations, evaluates due improvements,
then drains queued signals. For each accepted signal it:
1. Extracts factual memory drafts from event-window evidence.
2. Filters duplicate drafts.
3. Writes embedded memories through the genome.
4. Asks the reasoner for a non-memory mutation.
5. Applies the mutation and records a pending evaluation.

Source of truth:
- `src/learn/learn-process.ts`
- `src/learn/extraction-evidence.ts`
- `src/genome/extraction.ts`
- `src/genome/dedup.ts`

## Mutation Types

Supported mutations:
- create memory
- update existing agent prompt
- create agent
- create routing rule

Routing-rule learning uses the normal `RoutingRule` genome path. Do not replace
routing rules with memories or an alternate rule system.

Source of truth:
- `src/learn/learn-process.ts:LearnMutation`
- `src/genome/genome.ts:addRoutingRule()`

## Metrics

Metrics are JSONL records for stumbles and actions. Stumble rate is computed as
stumbles divided by actions, with period-scoped helpers for before/after
evaluation windows.

Source of truth:
- `src/learn/metrics-store.ts`
- `test/learn/metrics-store.test.ts`

## Evaluation And Rollback

Pending evaluations record target agent, mutation type, timestamp, commit hash,
and description. Once enough post-improvement actions exist, Sprout compares
before and after stumble rates. Harmful mutations are reverted by git commit.

Source of truth:
- `src/learn/learn-process.ts:evaluatePendingImprovements()`
- `src/genome/genome.ts:rollbackCommit()`

## Diagnostic Guidance

Sparse metrics cannot prove improvement. Check action counts before interpreting
rates. For a single bad session, use qm-session-analyst. For repeated patterns
or mutation effectiveness, use qm-session-doctor.
