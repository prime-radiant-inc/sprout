# Sap: a data plane and REPL for sprout

**Date:** 2026-07-16
**Status:** Approved design, revised after adversarial review (see §14), pre-implementation
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
- **Observer-granted cross-scope access.** Observers may mention values in messages,
  but mentioning never grants the recipient access outside its scope.
- **Dataflow visualization.** The events make it possible later; no UI in v1.

## The one rule

> **Full content materializes only below the LLM line.** Above the line — goals,
> hints, agent messages, tool results — a reference travels as a preview plus a scope
> binding, and the receiving agent decides how much to ingest via the value-read
> operations. Content splices in full only where no model ever sees it: primitive
> argument resolution and store operations.

Without this rule, splicing would merely relocate the token cost from parent to child.

## 1. The sap store

**Topology.** The store and the evaluator live together in one dedicated **sap
worker** (a Bun `Worker` owned by the host) — *not* on the host main thread. Code
moves to data: peek/grep/slice execute where the bytes live and never ship them.
Isolation cuts the other way too: a pathological cell can freeze only the sap worker,
never the bus server, spawner, UI, or root agent; the host detects it and
`terminate()`s the worker, then respawns it and rehydrates from the journal
(possible because namespaces are bindings-only, §4). The host exposes the store to
agent subprocesses as a bus service, sibling to the genome service (`src/sap/`).

**Value model.** Values are utf8 text, JSON, or bytes. Metadata: ULID, name, scope,
type, size, provenance (producing agent handle, cell or delegation, primitive and
args), and a deterministic preview. Values are **immutable once bound** — rebinding a
name creates a new version; a name resolved in a scope pins a version. Immutability
makes previews cacheable, concurrent children race-free, the journal trustworthy, and
spill-to-disk trivial.

**Previews** (~300 chars, computed once at bind, stable forever — prompt-cache
friendly): type, size, line count, head/tail excerpt; for JSON, top-level shape (keys,
array lengths). **Preview text passes through `redactSensitiveTranscriptContent`
(`src/kernel/redaction.ts`) at bind time** — previews travel into transcripts, events,
observer contexts, and the UI, and must never leak a secret that only ever existed
below the line.

**Naming** (names live in prompts; a name is documentation the model reads):

1. Deliberate binds are model-named: `bind('failing_tests', ...)`.
2. Auto-binds get provenance-derived names, deterministically, no LLM in the path:
   a child result → a goal slug such as `implement_endpoints_result`; a cell output →
   `cell_<n>_output`.
3. Collisions take a numeric suffix (`implement_endpoints_result_2`). Consumers may
   alias any name locally via `env`. Global identity is the ULID; names are per-scope.

**Durability.** Append-only JSONL journal per session in the durable log directory:
bind records (metadata plus inline value, or a content-addressed file reference —
sha256, dedup for free), scope records (created at delegation, publish-at-result), and
cell records (code, bindings created, error, compute time). Resume replays journal
*metadata* and lazy-loads bodies from CAS. **Cells are never re-executed on resume;
effects do not replay.**

**Transport.** Bus frames never carry large bodies. Values over a frame budget
(default 4 MB) transfer by CAS handoff: the producer writes the CAS file and publishes
`{path, sha256}`; the store verifies the hash and adopts the file. The bus server sets
an explicit `maxPayloadLength` accordingly (Bun's default WebSocket frame cap is
16 MB — without this, mid-size values would silently drop the connection).

**Memory management.** The sap worker holds hot values under a memory budget (default
512 MB) with LRU spill to CAS; immutability makes spill/reload safe. Values
unreferenced by any live scope are spill-first. There is no within-session deletion
in v1; session end prunes everything.

**Lifetime.** Session-scoped. `/clear` drops the store with the rest of session state.

**Defaults (config-tunable):** preview budget 300 chars; auto-bind threshold 2,000
chars; result summary budget 4,000 chars; `get()` materialization budget 1 MB; frame
budget 4 MB; worker memory budget 512 MB; max value size 256 MB.

## 2. Splicing

**Reference resolution is explicit and model-authored — never free-text.** Bindings
enter a recipient's scope through exactly two mechanisms, both structured fields the
model authors in its own tool calls, both validated against the *sender's* scope:

1. **`env` on delegate / message / continue** — map of local alias → name or ULID.
2. **`$ref` primitive arguments** — a string argument whose entire value is `⟦name⟧`
   resolves to the full content at execution time, below the model:
   `write_file("src/api.ts", "⟦impl⟧")` writes 48 KB for ~15 output tokens. Leaf
   agents need no REPL for this. The whole-arg string form is canonical because it is
   schema-valid everywhere — primitive parameters stay `type: "string"` for all three
   providers (an object `{"$ref": ...}` form would violate declared schemas and break
   strict-validation providers). Resolution requires the name to exist in the caller's
   scope; otherwise the string passes through as a literal.

**Free-text `⟦name⟧` (goals, hints, messages) is inert notation.** It never resolves,
never binds, never grants. This is deliberate: agents routinely quote untrusted
content (file contents, exec output, fetched pages) into goals, and auto-bind names
are predictable — if quoted text could mint bindings, any content that can influence a
tool result could plant `⟦deploy_key⟧` in a goal and exfiltrate it through a child.
Rendering surfaces (TUI, web) may decorate `⟦name⟧` with a preview when the name is
already in the reader's scope; the runtime attaches no semantics.

**Task payloads are unchanged.** `task_payload` renders inline into the child's goal
prompt (`src/agents/delegation-payload.ts:39-54`) and keeps its 64 KiB cap. There is
no `$ref` bypass — payloads have no below-the-LLM consumer, so a resolved reference
would inject full content into the child's prompt, violating the one rule. Reference
passing is `env`'s job; code-mode guidance discourages payloads.

**Auto-bind (upward, at agent boundaries).** Auto-bind applies to results crossing an
*agent* boundary — child results published upward, and cell outputs — not to a leaf's
own primitive results. A leaf ingesting a file it was asked to read is doing its job
with a disposable context; `read_file`/`exec`/`grep` results keep today's truncation
behavior (`src/kernel/truncation.ts`). A child's `ResultMessage.output` stays inline
up to the **summary budget** (default 4,000 chars — the judgment channel, worth paying
for); overflow auto-binds. Published values beyond the summary arrive as a manifest:

```
✓ engineer (brave_otter): "Implemented all 6 endpoints per the schema; two
  required new middleware, noted in ⟦impl_notes⟧."
  published: ⟦impl: 48KB ts, 14 exports⟧ ⟦impl_notes: 2KB md⟧
```

**Value-read primitives.** `value_peek`, `value_slice`, `value_lines`, `value_grep`,
`value_get` are kernel primitives grantable through the ordinary `tools` list —
default-granted to delegating agents, grantable to any leaf whose work needs them
(log analysis, large-artifact review). Tool-mode agents can therefore always inspect
what a manifest hands them; ingestion never requires the evaluator. These are pure
reads; the leaf discipline holds.

**Delegate tool changes.** `delegate` gains `env` and keeps its single-stable-tool
shape (prompt-cache decision preserved). `message_agent` and `ContinueMessage` gain
optional `env`. Respawn of a completed keep-alive handle goes through a fresh
`StartMessage` (`src/bus/spawner.ts:798-845`) — `StartMessage` gains `env` too, and a
respawned handle's scope rehydrates from the journal. `env` on a message to a
*running* target binds on receipt, when the message is queued.

**Spawnerless mode.** The in-process delegation path (no `AgentSpawner`: unit tests,
library embedding, `executeDelegation` at `src/agents/agent.ts:1038-1186`) gets a
local in-memory store implementation behind the same interface — `env`, `$ref`,
auto-bind, and value-read primitives all work. The evaluator requires the spawner; in
spawnerless mode `eval` is unavailable and `act: "code"` degrades to `"tools"`.

## 3. Scopes

Each agent handle owns a scope; the scope tree mirrors the delegation tree.

- **No ambient ancestor visibility.** A child sees exactly what `env` handed it plus
  what it creates. A closure shares its parent's mind; a child agent is a different
  mind with its own context budget. Explicit `env` is goal+hints, typed.
- **Publish is explicit and upward.** The child's result manifest — its auto-bound
  outputs plus anything it deliberately publishes — binds into the scope of whoever
  receives the result: the owner for a private handle; for a **shared** handle, each
  agent that `wait_agent`s it binds the manifest into its own scope on receipt
  (values are immutable and identified by ULID, so multiple binds are aliases, not
  copies; per-scope name collisions take the numeric suffix).
- **Siblings never collide.** They are wired together only by the parent (or, for
  shared handles, by explicitly waiting on a published handle).
- **The scope manifest lives in the system prompt.** Each planning turn renders a
  `<scope>` block: current bindings with previews, append-ordered (cache-friendly).
  This — not transcript history — is the agent's authoritative knowledge of its
  scope, so history compaction (`src/core/compaction.ts`) can never orphan a
  reference, and tool-mode agents can always enumerate what they hold.
- **Observers are read-only over the whole session store**, mirroring their
  event-stream visibility. Enforcement is by runtime identity, not spec text: the
  store checks the caller's spawner-verified `AgentAddress.role === "observer"`
  (`src/bus/types.ts:5-10`) for whole-store reads; ordinary agents are checked
  against their own scope chain. Observers never bind or publish.

## 4. The evaluator

Cells execute in the sap worker (§1) next to the values they compute over. Agents
submit cells via the `eval` kernel tool; results return as tool results.

**Namespace contract — bindings only.** An agent's persistent namespace *is its
scope*: names bound via `bind()` (or received via `env`/manifests) persist across
cells and rehydrate from the journal on resume. **Plain JS locals die at cell end.**
`const grouped = groupBy(parse('big_json'), 'type')` is gone next cell unless bound.
This is what makes "cells are never re-executed" honest: rehydration is a journal
metadata replay, not a state reconstruction. The eval tool description and code-mode
system prompt guidance state this contract; referencing an unknown name returns an
error listing the names actually in scope.

**Spawn routing — through the owner, not around it.** `spawn()` inside a cell does
not touch the spawner directly. It sends a spawn request from the sap worker back to
the **owning agent's subprocess**, which executes it through the existing
`executeSpawnerDelegation` (`src/agents/agent.ts:1504+`) — the agent process's
message pump services cell spawn requests while its `eval` call is pending (its event
loop is free; today that pump handles steer/agent_message, `src/bus/agent-process.ts:418-436`,
and gains a request/response channel). This is what makes reuse *true* rather than
asserted: the delegation allowlist (`resolveDelegationTarget`), delegate-observer
capture, verification, stumble accounting into the caller's own counters, learn
signals, mnemonic naming, act events, and resume's handle discovery from the owner's
event log all run in the process that owns that state. A handle spawned from a cell
is indistinguishable from one spawned by a tool call — `wait_agent`/`message_agent`
on it work.

The entire ambient surface, frozen (kernel API; Learn cannot mutate it):

```js
spawn(agent, goal, {env, hints, blocking, shared, model})
  // blocking (default) → Promise<{ok, summary, bindings, handle}>
  // blocking: false    → resolves immediately to {handle}; result via handle.wait()
  // handle.wait(), handle.message(text, {env})
bind(name, value)                       // deliberate, model-named; the only persistence
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

**Cell results to the LLM:** captured stdout + final expression value (auto-bound if
over threshold) + manifest of new bindings + on error, message, offending line, and
the names currently in scope.

**Budgets, guards, and cancellation:**

- **Compute budget** (default 5 s of actual JS execution, tunable). All awaitables in
  a cell are ambient-API promises, so the sap runtime knows when a cell parks and
  resumes; the host watches park/resume/heartbeat signals, and a cell that is neither
  parked nor completing within budget gets the worker terminated and respawned
  (bindings-only namespaces make this cheap). No cap on how long a cell waits for
  children — children are governed by their own constraints.
- **The cell's lease is the owner's `eval` call.** If the owning agent is
  interrupted, times out, or its process dies, the host cancels the cell: the eval
  tool result becomes an error (or is moot), and the cell's blocking children — which
  are ordinary delegations *of the owner* via spawn routing — follow the owner's
  existing abort/kill semantics. `blocking: false` children detach and survive, as
  today. No new spawner kill API is needed.
- **Owner inactivity timer.** The caller's `timeout_ms` is a wall-clock inactivity
  timer that would otherwise fire mid-await on long fan-outs
  (`src/agents/agent.ts:2304-2308`). While an `eval` call is pending, cell activity
  signals (park/resume, spawn lifecycle events) reset the owner's timer — a working
  cell is activity, exactly as a streaming primitive is. The same signal path gives
  blocking `spawn()` waits a settlement backstop: `waitForBlockingSpawn` today has no
  timer (`src/bus/spawner.ts:620-636`), so cell-initiated blocking waits get waiter-
  timeout parity with `waitAgent`.
- Spawn cap per cell (default 64, tunable); `MAX_AGENT_DEPTH` applies inside cells
  (enforced by `executeSpawnerDelegation`, since spawns route through it).
- Cells are serialized per agent; concurrency happens inside a cell. One sap worker
  serves the session; cells from different agents interleave on its event loop, and
  the compute budget bounds any one cell's monopolization.
- No bare `llm()` function — that would be a second recursion mechanism (see §5).

**Tool surface rules:** `eval` is granted to agents with `can_spawn: true`; tool-mode
agents may also be granted it explicitly. Leaves stay pure tool-callers — `$ref` args
and value-read primitives cover them. Reserved-name checks extend to `eval`, the
`value_*` primitives, and the cell ambient names.

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

**Two kernel prerequisites** (both discovered in adversarial review):

1. **`hitTurnLimit` bugfix.** `finalizeRunLoopOutcome` marks `hitTurnLimit` whenever
   `turns >= max_turns` (`src/agents/run-loop-outcome.ts:17`), even on clean natural
   completion — a pre-existing latent bug (any agent finishing on exactly its last
   allowed turn is falsely stumbled) that `max_turns: 1` would trip on *every* run.
   Fix: hitting the limit means the loop exited *because of* the limit without
   natural completion. Fixed first, with its own tests; 50-way fan-outs must not
   report 50 spurious failures.
2. **Zero-tool completion agents.** The run loop rejects agents with no tools
   (`src/agents/agent.ts:411-423`, `1939-1950`; only observer-tagged specs are
   exempt via `canRunWithoutTools`). The exemption extends to specs with `tools: []`
   and `max_turns: 1` — a pure completion agent that cannot hallucinate tool calls
   into anything, because none are offered and the run ends after one reply.

**Per-spawn model override** rides `StartMessage` (new optional field), resolved
through the existing model resolver.

**Featherweight placement rule.** This agent's workload is fan-out (`Promise.all`
over 50 slices = 50 spawns); a subprocess + bus handshake per call is real overhead
at that scale. Agents that are single-turn, no-tools, no-spawn may execute in-process
in the host. Scope of the equivalence, stated precisely: identical events, identical
result semantics, and a **synthetic completed handle** registered with the spawner
(so `wait_agent` and result caching work). Featherweight handles are completed-only:
no idle loop, no keep-alive, no per-handle durable log (the session journal records
the result; single-shot by construction, so completed-handle respawn semantics via
`message_agent` apply unchanged). Crash isolation genuinely differs; that is the
trade, and it is why the rule is restricted to single-turn no-tool agents.

## 6. Code-first Act mode

Agent specs gain `act: "code" | "tools"` (default `tools` — today's behavior,
untouched). A code-mode agent's Plan emits one `eval` tool call per Act; the cell is
the plan. Tool-mode agents keep `delegate` and may also hold `eval`. Both modes are
one stable tool call per provider (Anthropic/OpenAI/Gemini), preserving the
cache-stability decision.

**Degradation rule:** when the session's data-plane flag is off (control arm, §10) or
no spawner exists, `act: "code"` degrades to `act: "tools"` — the spec field is a
preference the session honors when the machinery exists, never a way to produce a
zero-tool agent. The genome is shared across sessions; a spec evolved to code-mode
must keep working in every session.

Because `act` is a spec field, which mode wins is an empirical question the genome
answers: mutate it, watch stumble rates.

## 7. Genome programs — the fourth artifact

`programs/` joins agents, memories, and routing rules in the genome:

- **Format:** frontmatter (name, description, typed params, version, provenance) plus
  a JS body that runs against the cell API.
- **Exposure:** injected into code-mode namespaces as `programs.<name>(...)`, listed
  in a `<programs>` system-prompt block. Code-mode only in v1.
- **Evolution:** the quartermaster fabricates programs from recurring cell patterns
  and repairs them from cell stumbles. Cell stumble learn-signals carry the cell code
  (from `cell_end` event data) so the quartermaster has the artifact it is repairing.
  Eval-mode gates program mutations exactly as it gates agent mutations; git provides
  audit and rollback.
- **Sync plumbing:** the genome `DIRS` list, bootstrap manifest, `syncRoot`, and
  `exportLearnings` (`src/genome/`) currently know only agents; each extends to
  programs so evolved programs can be promoted to root through the existing
  staged-review flow.
- **The immutability line:** store, splice, scope, and cell semantics (including the
  ambient API) are kernel — Learn cannot touch them. Programs are genome — fully
  evolvable. The kernel list in `docs/architecture.md` grows accordingly.

This is a skill library where the skills are orchestrations of agents, under
selection by stumble rate.

## 8. Events and surfaces

New event kinds:

- `value_bind` — name, size, type, preview, provenance.
- `cell_start` / `cell_end` — code, duration, compute time, bindings created, error.

Spawns inside cells emit the existing delegation events unchanged (they route through
`executeSpawnerDelegation`, §4). Events carry previews instead of raw content, so
observer frames get cheaper and need less redaction/truncation to fit `max_chars`;
metacognitive observers also gain strictly better signal — dataflow topology ("root
re-peeked ⟦test_log⟧ four times; suggest binding the grep result"; "two siblings each
re-parsed the same JSON — this wants to be a program").

TUI: handles render as dim inline `⟦name: 48KB⟧`. Web: preview on hover.

## 9. Failure handling

- Cell errors are tool-result errors (message, line, names in scope) — they flow
  through the existing verify → stumble → learn-signal pipeline. Model-written cells
  will stumble early; that is the fitness function eating.
- Store misses list the names available in the caller's scope.
- `get()` over budget refuses with guidance to slice/grep.
- A child failure inside `Promise.all` rejects the cell unless the code handles it;
  the error names the failed spawn and its handle so the next cell can `wait()` or
  retry surviving children. Code-mode guidance recommends `Promise.allSettled` for
  fan-out.
- Worker termination (budget overrun) fails the running cell as a tool-result error;
  bindings already journaled survive; the worker respawns before the next cell.

## 10. Instrumentation and metrics

All-in must not mean unattributable:

- `act` mode is per-spec; the data plane is a per-session flag (with §6's degradation
  rule) — eval-mode can A/B.
- Metrics: tokens per delegated byte moved; stumble rate by act mode; fan-out
  wall-clock; store hit sizes (how much content stayed below the line).
- Success criterion for the canonical scenario ("author a 50 KB file via children"):
  ≥ 80% token reduction versus baseline, no resume/replay regressions.

## 11. Testing

- **Unit:** store bind/scope/journal/rehydrate; `$ref` whole-arg resolution
  (in-scope, out-of-scope literal passthrough); free-text inertness (a `⟦name⟧` in a
  goal must *not* bind or resolve); preview determinism and redaction; sandbox
  surface (no fs/fetch/process/import); compute-budget park/resume accounting and
  worker terminate/respawn; auto-bind thresholds and summary budget; naming
  collisions; scope-manifest rendering; `hitTurnLimit` fix; zero-tool exemption;
  CAS handoff over the frame budget; LRU spill/reload.
- **Integration:** env-passing over the bus (delegate, message, continue, respawn
  StartMessage); auto-bind of oversized child results; shared-handle manifest binding
  into multiple waiters; cell spawn routing through the owner (allowlist enforcement,
  delegate observers firing, stumble attribution); owner interrupt/timeout cancelling
  a pending cell; fan-out via `Promise.all`; resume with bindings-only rehydration;
  spawnerless local store parity; featherweight synthetic-handle equivalence; program
  load precedence and root promotion. Keystone assertion: `write_file` via `$ref`,
  verified from recorded provider requests that **the content bytes appear in no LLM
  payload anywhere in the tree**.
- **E2E (eval mode, real models, no mocks):** the canonical 50 KB scenario with
  before/after token measurement; a 50-way llm-call fan-out asserting zero spurious
  failures; stumble-rate tracking per act mode.

## 12. Build order

One design, sequenced by dependency; each phase lands green before the next starts:

0. **Kernel prerequisites** — `hitTurnLimit` fix; zero-tool completion agents.
1. **Store** — sap worker, journal, previews + redaction, CAS transport/spill,
   auto-bind at agent boundaries, `value_bind` events, **value-read primitives**, and
   the `<scope>` prompt block (tool-mode agents are full data-plane citizens from
   day one — no phase gap where content is bound but unreadable).
2. **Splice** — `$ref` whole-arg resolution, `env` on delegate/message/continue/
   StartMessage, result manifests + summary budget, spawnerless local store.
3. **Evaluator** — sap-worker cells, ambient API, spawn routing through the owner,
   bindings-only namespaces + rehydration, compute budgets + cancellation lease,
   featherweight placement, `utility/llm-call`.
4. **Code-first** — `act` spec field + degradation rule, observer store access,
   TUI/web rendering.
5. **Programs** — genome artifact type + sync/export plumbing, quartermaster
   fabrication, eval-mode gating, metrics dashboards.

## 13. Design decisions log

| Decision | Choice | Why |
|---|---|---|
| REPL role | Orchestration surface + RLM data ops; full RLM deferred | Sprout's pain is inter-agent transport, not single-context rot |
| Surface language | JS cells via one `eval` tool; handles work with zero JS | Data structure at the core; JS as the wiring power-up |
| Topology | Store + evaluator in a dedicated sap worker; agent loops stay subprocesses | Code moves to data; a stuck cell can't freeze the bus/UI; terminate+rehydrate is the kill mechanism |
| Spawn routing | Cells spawn through the owning agent's process | Makes existing delegation machinery reuse true: allowlists, observers, stumbles, resume all live there |
| Namespace persistence | Bindings only; locals die at cell end | Makes never-re-execute resume honest |
| Reference semantics | Explicit env/$ref only; free-text ⟦name⟧ inert | Quoted untrusted content must never mint bindings |
| $ref form | Whole-arg string `"⟦name⟧"` | Schema-valid on all providers; object form breaks strict validation |
| Scoping | Explicit env, no ambient ancestor visibility; publish-up manifests; observers read-only global by runtime role | Children are different minds; provenance stays explainable |
| Scope knowledge | `<scope>` system-prompt block, not transcript history | Compaction-proof; tool-mode agents can enumerate |
| Value naming | Model-named > provenance-derived > numeric suffix | Names are prompt-visible documentation |
| Sub-LM calls | `utility/llm-call` genome agent, not a kernel `llm()` | One recursion mechanism; evolvable |
| Cell limits | Compute budget via park/resume accounting; owner's eval call as lease | Cells legitimately await children; owner lifecycle already governs cancellation |
| Auto-bind boundary | Agent boundaries and cell outputs; leaf primitive results keep today's truncation | A leaf ingesting its file is the job; starving it breaks reader-class agents |
| Mode choice | `act` per spec with session degradation rule | Don't decide, evolve — without genome/session coupling crashes |

## 14. Adversarial review log (2026-07-16)

Two independent adversarial reviews ran against the committed first draft; 21 distinct
legitimate findings survived adjudication (6 found by both). All are addressed above.
The most consequential: evaluator-on-host-thread was unimplementable (→ sap worker);
`executeSpawnerDelegation` reuse was asserted but unreachable from host-side cells
(→ spawn routing through the owner); auto-bind starved tool-mode/leaf agents that had
no read ops (→ value-read primitives, agent-boundary auto-bind, build-order fix);
namespace rehydration contradicted never-re-execute (→ bindings-only contract);
payload `$ref` bypass violated the one rule (→ dropped); free-text splicing was an
injection channel (→ inert); `max_turns: 1` and `tools: []` were both rejected or
mis-scored by existing kernel code (→ §5 prerequisites, incl. one pre-existing bug);
plus previews-vs-redaction, compaction-vs-references, WS frame caps, GC, shared-handle
scope semantics, spawnerless mode, featherweight equivalence, and flag/genome
coherence — each now specified.
