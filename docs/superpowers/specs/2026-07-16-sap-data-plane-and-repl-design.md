# Sap: a data plane and REPL for sprout

**Date:** 2026-07-16
**Status:** Approved design, pre-implementation
**Scope:** Value store ("sap"), handle splicing, evaluator/REPL, code-first Act mode, genome programs

## Motivation

Sprout's control plane and data plane are the same channel: the transcript. When a
parent tells a child "write all this content to a file," the content transits an LLM
three or more times — the parent generates it into the `goal` string (output tokens),
the child pays input on it, the child re-generates it into `write_file` args (output
again), and it then sits in both transcripts, re-paid as input on every subsequent
turn. Content that some LLM already paid to produce once should never be re-generated
or re-ingested by any LLM again.

The fix is the environment half of the Recursive Language Models (RLM) scheme. RLM is
three things: (1) a REPL where large context lives as variables instead of prompt, (2)
cheap inspection of those variables (peek/slice/grep), (3) recursive calls to sub-LMs
over pieces of them. Sprout already has (3) as its foundational primitive — delegation,
with a full agent rather than a bare LM on the other end. This design supplies (1) and
(2): a session-scoped value store whose scoping mirrors the delegation tree, plus a
capability-scoped JS evaluator. Sprout : delegations :: RLM : LM calls.

## Goals

- Data produced by one agent flows to another without transiting any LLM context.
- Parallel fan-out, map/reduce, retries, and conditionals become expressible
  (language-level concurrency instead of the multi-delegate-per-turn pattern).
- Deterministic computation (parsing, slicing, grepping, reformatting) becomes free
  instead of costing a delegation to an agent that re-emits data token by token.
- Successful orchestration patterns become evolvable genome artifacts (programs).
- Every phase is measurable: tokens per delegated byte, stumble rate by act mode.

## Non-goals

- **Full RLM** (an agent's own transcript as a manipulable variable). Sprout's
  hierarchy plus compaction already covers context management; deferred.
- **Cross-session store persistence.** Memories and the genome remain the only
  cross-session channels. The store dies with the session.
- **A hard security sandbox.** v1 isolation is capability discipline, the same trust
  model as `exec` on leaf agents today.
- **Observer-granted cross-scope access.** Observers may reference values in messages,
  but referencing does not grant the recipient access outside its scope.
- **Dataflow visualization.** The events make it possible later; no UI in v1.

## The one rule

> **Full content materializes only below the LLM line.** Above the line — goals,
> hints, agent messages, tool results — a reference travels as a preview plus a scope
> binding, and the receiving agent decides how much to ingest via peek/slice/grep.
> Content splices in full only where no model ever sees it: primitive argument
> resolution and store operations.

Without this rule, splicing would merely relocate the token cost from parent to child.

## 1. The sap store

A host-side bus service, sibling to the genome service (`src/sap/`).

**Value model.** Values are utf8 text, JSON, or bytes. Metadata: ULID, name, scope,
type, size, provenance (producing agent handle, cell or delegation, primitive and
args), and a deterministic preview. Values are **immutable once bound** — rebinding a
name creates a new version; a name resolved in a scope pins a version. Immutability
makes previews cacheable, concurrent children race-free, and the journal trustworthy.

**Previews** (~300 chars, computed once at bind, stable forever — prompt-cache
friendly): type, size, line count, head/tail excerpt; for JSON, top-level shape (keys,
array lengths). Rendered in LLM-visible text as `⟦name: preview⟧` on first mention and
`⟦name⟧` thereafter.

**Naming** (names live in prompts; a name is documentation the model reads):

1. Deliberate binds are model-named: `bind('failing_tests', ...)`.
2. Auto-binds get provenance-derived names, deterministically, no LLM in the path:
   `read_file(src/api.ts)` → `file_src_api_ts`; `exec(bun test)` →
   `exec_bun_test_output`; a child result → a goal slug such as
   `implement_endpoints_result`.
3. Collisions take a numeric suffix (`exec_bun_test_output_2`). Consumers may alias
   any name locally via `env`. Global identity is the ULID; names are per-scope.

**Durability.** Append-only JSONL journal per session in the durable log directory:
bind records (metadata plus inline value, or a content-addressed file reference for
large values — sha256, dedup for free), scope records (created at delegation,
publish-at-result), and cell records (code, bindings created, error, compute time).
Resume replays the journal to rehydrate the store and evaluator namespaces. **Cells
are never re-executed on resume; effects do not replay.**

**Lifetime.** Session-scoped. `/clear` drops the store with the rest of session state.
CAS files are pruned with session cleanup.

**Defaults (config-tunable):** preview budget 300 chars; auto-bind threshold 2,000
chars; `get()` materialization budget 1 MB; max value size 256 MB.

## 2. Splicing

**Structured arguments** (primitive args, delegate `env`, payloads): a string argument
may be the whole-arg reference `{"$ref": "name"}` (canonical) or the exact string
`"⟦name⟧"` (accepted sugar). No inline interpolation of full content inside larger
strings. The runtime resolves the reference at execution time, below the model:
`write_file("src/api.ts", {"$ref": "impl"})` writes 48 KB for ~15 output tokens, and
leaf agents need no REPL for this.

**Free text** (goals, hints, agent messages): `⟦name⟧` resolves to the preview and
binds the value into the recipient's scope — never full content.

**Auto-bind (upward).** Any result crossing an LLM boundary over the threshold —
child output, primitive result, cell output — binds automatically (wired into the
existing truncation layer): the value goes producer → store; the LLM sees preview +
handle. A delegate tool result becomes the child's prose summary (judgment, worth
paying for) plus a manifest of published bindings with previews:

```
✓ engineer (brave_otter): "Implemented all 6 endpoints per the schema; two
  required new middleware, noted in ⟦impl_notes⟧."
  published: ⟦impl: 48KB ts, 14 exports⟧ ⟦impl_notes: 2KB md⟧
```

**Delegate tool changes.** `delegate` gains `env` (map of local alias → name/ULID) and
keeps its single-stable-tool shape (prompt-cache decision preserved). `task_payload`'s
64 KiB cap applies to inline payloads only; references bypass it.
`message_agent`/`ContinueMessage` gain optional `env`, so re-engaging an idle
keep-alive agent can hand it new bindings. A handle's scope persists across continues
and rehydrates on respawn via the journal.

## 3. Scopes

Each agent handle owns a scope; the scope tree mirrors the delegation tree.

- **No ambient ancestor visibility.** A child sees exactly what `env` handed it plus
  what it creates. A closure shares its parent's mind; a child agent is a different
  mind with its own context budget. Explicit `env` is goal+hints, typed.
- **Publish is explicit and upward.** The child's result manifest — its auto-bound
  outputs plus anything it deliberately publishes — lands in the parent's scope.
- **Siblings never collide.** They are wired together only by the parent.
- **Observers are read-only over the whole session store**, mirroring their
  event-stream visibility. They gain kernel read primitives `value_peek`,
  `value_grep`, `value_slice` on their tool surface (pure reads; the leaf discipline
  holds). Observers never bind or publish: they advise, they don't mutate data agents
  depend on.

## 4. The evaluator

One evaluator service, co-located with the store in the host process — **code moves to
data, never the reverse** (a one-line grep must not ship 400 KB over the bus). Agents
submit cells over the bus via the `eval` kernel tool; results return as tool results.

- **Namespace:** persistent per agent handle across cells (the agent's working
  memory), rehydrated from the journal on resume.
- **Serialization:** one cell at a time per agent; concurrency happens inside a cell.
- **Placement of agent loops is unchanged:** agents remain subprocesses with the
  existing spawner/handle machinery; only their cells execute host-side.

The entire ambient surface, frozen (this is kernel API; Learn cannot mutate it):

```js
spawn(agent, goal, {env, hints, blocking, shared, model})
  // blocking (default) → Promise<{ok, summary, bindings, handle}>
  // blocking: false    → resolves immediately to {handle}; result via handle.wait()
  // handle.wait(), handle.message(text, {env}) — subsumes wait_agent/message_agent
bind(name, value)                       // deliberate, model-named
peek(name, {head, tail})
slice(name, start, end)
lines(name, from, to)
grep(name, pattern, {context})
parse(name)                             // JSON
size(name)
get(name)                               // full materialize — budgeted; refuses over
                                        // budget with guidance to slice/grep
console.log(...)                        // captured into cell output
// plus the pure JS stdlib. No fs, no fetch, no process, no import/require.
```

**Cell results to the LLM:** captured stdout + final expression value (previewed if
over threshold) + manifest of new bindings + on error, message, offending line, and
the names currently in scope (misspelled references self-heal next turn).

**Budgets and guards:**

- **Compute budget, not wall clock.** The evaluator caps actual JS execution time
  (default 5 s, tunable) to catch runaway loops and pathological regexes; the clock
  stops while the cell is parked on an `await` of a spawn or store op. Children are
  governed by their own constraints (`timeout_ms`, `max_turns`, depth limits), and the
  spawner's waiter-timeout/result-recovery path guarantees every await settles.
- Spawn cap per cell (default 64, tunable); existing `MAX_AGENT_DEPTH` applies inside
  cells.
- A cell killed for exceeding its compute budget cancels its still-running blocking
  children via the spawner; `blocking: false` children detach and survive.
- No bare `llm()` function — that would be a second recursion mechanism (see §5).

**Spawns inside cells reuse `executeSpawnerDelegation`**, so `act_start`/`act_end`,
delegate observers, verification, stumble accounting, and the TUI's active-work
derivation keep working unmodified.

**Tool surface rules:** `eval` is granted to agents with `can_spawn: true`
(delegating agents); tool-mode agents may also be granted it explicitly. Leaves stay
pure tool-callers — `$ref` primitive args cover them. Reserved-name checks extend to
`eval`, `value_peek`, `value_grep`, `value_slice`, and the cell ambient names.

## 5. utility/llm-call

The RLM sub-LM call, materialized as the most primitive possible agent instead of a
kernel function — one recursion mechanism, and Learn can evolve specialized
descendants (summarizer, extractor, judge) while the slim base stays primitive.

```yaml
name: utility/llm-call
model: fast                    # caller may override per-spawn
tools: []
constraints: { can_spawn: false, max_turns: 1 }
subcortical_recall: false
```

System prompt, approximately: "Complete the request in your reply. No preamble."

**Featherweight placement rule.** This agent's workload is fan-out (`Promise.all` over
50 slices = 50 spawns), and a subprocess + bus handshake per call is real overhead at
that scale. Agents that are single-turn, no-tools, no-spawn may execute in-process in
the host rather than as subprocesses — identical semantics, events, and results; only
placement differs.

## 6. Code-first Act mode

Agent specs gain `act: "code" | "tools"` (default `tools` — today's behavior,
untouched). A code-mode agent's Plan emits one `eval` tool call per Act; the cell is
the plan. Tool-mode agents keep `delegate` and may also hold `eval`. Both modes are
one stable tool call per provider (Anthropic/OpenAI/Gemini), preserving the
cache-stability decision. Because `act` is a spec field, which mode wins is an
empirical question the genome answers: mutate it, watch stumble rates.

## 7. Genome programs — the fourth artifact

`programs/` joins agents, memories, and routing rules in the genome:

- **Format:** frontmatter (name, description, typed params, version, provenance) plus
  a JS body that runs against the cell API.
- **Exposure:** injected into code-mode namespaces as `programs.<name>(...)`, listed
  in a `<programs>` system-prompt block. Code-mode only in v1.
- **Evolution:** the quartermaster fabricates programs from recurring cell patterns
  and repairs them from cell stumbles. Eval-mode gates program mutations exactly as it
  gates agent mutations; git provides audit and rollback.
- **The immutability line:** store, splice, scope, and cell semantics (including the
  ambient API) are kernel — Learn cannot touch them. Programs are genome — fully
  evolvable. The kernel list in `docs/architecture.md` grows accordingly.

This is a skill library where the skills are orchestrations of agents, under
selection by stumble rate.

## 8. Events and surfaces

New event kinds:

- `value_bind` — name, size, type, preview, provenance.
- `cell_start` / `cell_end` — code, duration, compute time, bindings created, error.

Spawns inside cells emit the existing delegation events unchanged. Events carry
previews instead of raw content, so observer frames get cheaper and need less
redaction/truncation to fit `max_chars`; metacognitive observers also gain strictly
better signal — dataflow topology ("root re-peeked ⟦test_log⟧ four times; suggest
binding the grep result"; "two siblings each re-parsed the same JSON — this wants to
be a program").

TUI: handles render as dim inline `⟦name: 48KB⟧`. Web: preview on hover.

## 9. Failure handling

- Cell errors are tool-result errors (message, line, names in scope) — they flow
  through the existing verify → stumble → learn-signal pipeline untouched.
  Model-written cells will stumble early; that is the fitness function eating.
- Store misses list the names available in the caller's scope.
- `get()` over budget refuses with guidance to slice/grep.
- A child failure inside `Promise.all` rejects the cell unless the code handles it;
  the error names the failed spawn and its handle so the next cell can `wait()` or
  retry surviving children. (Cells are ordinary JS; `Promise.allSettled` is available
  and the system prompt guidance for code-mode agents recommends it for fan-out.)

## 10. Instrumentation and metrics

All-in must not mean unattributable:

- `act` mode is per-spec; the data plane is a per-session flag — eval-mode can A/B.
- Metrics: tokens per delegated byte moved; stumble rate by act mode; fan-out
  wall-clock; store hit sizes (how much content stayed below the line).
- Success criterion for the canonical scenario ("author a 50 KB file via children"):
  ≥ 80% token reduction versus baseline, no resume/replay regressions.

## 11. Testing

- **Unit:** store bind/scope/journal/rehydrate; splice resolution ($ref, sugar form,
  free-text previews); preview determinism; sandbox surface (assert no ambient
  authority — no fs/fetch/process/import); compute-budget enforcement and
  cancellation; auto-bind thresholds; naming collisions.
- **Integration:** env-passing over the bus; auto-bind of oversized child results;
  fan-out via `Promise.all`; resume with namespace rehydration; keep-alive continue
  with `env`; program load precedence; featherweight placement equivalence (same
  events/results in-process vs subprocess). Keystone assertion: `write_file` via
  `$ref`, verified from recorded provider requests that **the content bytes appear in
  no LLM payload anywhere in the tree**.
- **E2E (eval mode, real models, no mocks):** the canonical 50 KB scenario with
  before/after token measurement; stumble-rate tracking per act mode.

## 12. Build order

One design, sequenced by dependency; each phase lands green before the next starts:

1. **Store** — sap service, journal, previews, auto-bind of oversized results,
   `value_bind` events.
2. **Splice** — `$ref` primitive args, `⟦name⟧`/`env` on delegate, result manifests,
   `env` on continue/message, payload-cap bypass.
3. **Evaluator** — `eval` tool, cell API, per-agent namespaces + rehydration,
   compute budgets, featherweight placement, `utility/llm-call`.
4. **Code-first** — `act` spec field, observer read primitives, TUI/web rendering.
5. **Programs** — genome artifact type, quartermaster fabrication, eval-mode gating,
   metrics dashboards.

## Design decisions log

| Decision | Choice | Why |
|---|---|---|
| REPL role | Orchestration surface + RLM data ops; full RLM deferred | Sprout's pain is inter-agent transport, not single-context rot; hierarchy already manages context |
| Surface language | JS cells via one `eval` tool; handles work with zero JS (structured `$ref`) | Data structure at the core; JS as the wiring power-up; agents write JS well |
| Topology | One evaluator+store in host; agent loops stay subprocesses | Move code to data; keep crash isolation and existing spawner machinery |
| Scoping | Explicit env, no ambient ancestor visibility; publish-up manifests; observers read-only global | Children are different minds; provenance stays explainable; matches private/shared handle discipline |
| Value naming | Model-named > provenance-derived > numeric suffix | Names are prompt-visible documentation |
| Sub-LM calls | `utility/llm-call` genome agent, not a kernel `llm()` | One recursion mechanism; evolvable |
| Cell limits | Compute budget, not wall clock | Cells legitimately await children for minutes; children self-govern |
| Mode choice | `act` per spec; genome decides empirically | Don't decide, evolve |
