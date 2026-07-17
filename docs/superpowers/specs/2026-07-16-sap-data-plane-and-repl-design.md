# Sap: a data plane and REPL for sprout

**Date:** 2026-07-16
**Status:** Approved design, revised after two adversarial review rounds (§14), pre-implementation
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
  model as `exec` on leaf agents today. The store's access checks (§3) are enforced
  server-side by token, but the bus itself remains unauthenticated pub/sub in v1.
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

**Topology.** Two kinds of workers, owned by the host, neither on the host main
thread:

- **One store worker per session.** Holds the values, executes the value operations
  (peek/slice/grep/parse/previews), owns the journal. Code moves to data: a grep over
  a 400 MB value executes here and returns matches, never shipping the bytes. The
  store worker runs no model-authored code and is never terminated by budget
  enforcement.
- **One cell worker per agent** (lazy-created on first `eval`, destroyed when the
  agent completes). Runs that agent's cell JS and holds its namespace. Cells call
  value ops through a message channel to the store worker; results of value ops are
  small by construction (bounded reads), and `get()` materialization is budgeted.
  Arbitrary heavy JS over full contents beyond the `get()` budget is unsupported —
  use value ops or delegate.

This split is what makes budget enforcement surgical: terminating a runaway cell
kills *only that agent's* cell worker (§4, §9) — never another agent's in-flight
cell, never the store, never the bus/UI/spawner. Bindings-only namespaces (§4) make
cell workers disposable. The host exposes the store to agent subprocesses as a bus
service, sibling to the genome service (`src/sap/`).

**Value model.** Values are utf8 text, JSON, or bytes. Metadata: ULID, name, scope,
type, size, provenance (producing agent handle, cell or delegation, primitive and
args), and a deterministic preview. Values are **immutable once bound** — rebinding a
name creates a new version; a name resolved in a scope pins a version. Immutability
makes previews cacheable, concurrent children race-free, the journal trustworthy, and
spill-to-disk trivial.

**Previews** (~300 chars, computed once at bind, stable forever): type, size, line
count, head/tail excerpt; for JSON, top-level shape (keys, array lengths).

**Redaction.** Anything the store returns *above the LLM line* passes through
`redactSensitiveTranscriptContent` (`src/kernel/redaction.ts`): previews at bind
time, and the results of every value-read that lands in a transcript, event, or UI
surface (`value_peek`/`slice`/`grep`/`get` results, cell outputs). Below-the-line
consumers — `$ref` splice into primitive args, store-internal ops — get raw bytes.
Without the read-side rule, bind-time preview redaction would be theater: the first
`value_peek` would put the raw secret in a transcript anyway.

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

**Memory management.** The store worker holds hot values under a memory budget
(default 512 MB) with LRU spill to CAS; immutability makes spill/reload safe. Values
unreferenced by any live scope are spill-first. No within-session deletion in v1;
session end prunes everything.

**Lifetime.** Session-scoped. `/clear` drops the store with the rest of session state.

**Defaults (config-tunable):** preview budget 300 chars; auto-bind threshold 2,000
chars; result summary budget 4,000 chars; cell `get()` budget 1 MB; `value_get`
primitive budget 50,000 chars (read_file parity); frame budget 4 MB; store memory
budget 512 MB; max value size 256 MB.

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
   strict-validation providers).

**A `$ref` miss is a loud tool error, never a silent literal.** A whole-arg `⟦name⟧`
is unambiguous model-authored intent to splice; on a typo or stale name the primitive
fails with an error listing the names actually in scope. Silent passthrough would
write the literal `⟦impl⟧` as file content, succeed, and surface as corruption much
later — the free-text injection rationale (below) does not apply here, because a
*failing* ref grants nothing. (To write a literal `⟦name⟧` string that is also a
scope name: bind the literal and `$ref` it. Degenerate and rare.)

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
default-granted to delegating agents, implicitly granted to any `eval` holder (§6),
and grantable to any leaf whose work needs them. Tool-mode agents can therefore
always inspect what a manifest hands them; ingestion never requires the evaluator.
These are pure reads; the leaf discipline holds. **They bypass the registry's
`truncateToolOutput` layer** (`src/kernel/primitives.ts:72-83` applies a 30,000-char
middle-cut with a banner falsely pointing at the event stream): a value-read is a
precision instrument whose own budgets *are* the truncation policy. `value_get` over
its 50,000-char primitive budget refuses with guidance to slice/grep — never a silent
middle-cut.

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
spawnerless mode `eval` is unavailable and `act: "code"` degrades to `"tools"` (§6).

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

**Scope knowledge lives in the message stream, not the system prompt.** When
bindings enter an agent's scope (env at start, manifests on results, binds from
cells), the runtime appends a compact scope announcement to history as a user-role
message — the mechanism already used for steering and new-agent announcements
(`src/agents/agent.ts:2338-2345`): `New bindings: ⟦impl: 48KB ts, 14 exports⟧ ...`.
After **compaction**, the runtime injects a fresh consolidated scope manifest as the
first post-compaction message, so compaction can never orphan a reference and
tool-mode agents can always enumerate what they hold. System-prompt placement was
considered and rejected: the system block sits at the head of every provider's cache
prefix (`src/llm/anthropic.ts:187-195`), so a scope block there would invalidate the
entire conversation cache on every bind — the steady-state operation of this design.
Message-stream appends preserve the prefix; cached history stays cached.

**Store access control — token-verified, host-enforced.** §14's round-2 review
established that the bus has no caller identity: connections are anonymous, topics
are open, and `AgentAddress` is self-reported message content. The store therefore
does not trust addresses. At spawn, the spawner mints a **per-handle secret token**,
delivered to the subprocess in its environment alongside `SPROUT_HANDLE_ID`
(`src/bus/spawner.ts:539-548`) and **filtered from `exec` child environments** the
same way API keys are (`src/kernel/execution-env.ts`). Store requests carry the
token; the host holds the token → address map and stamps the verified identity
server-side before forwarding to the store worker. Root and host facilities use an
in-process trusted path. Scope rules enforced on that verified identity:

- Ordinary agents read their own scope chain only.
- **Observers** (verified `role: "observer"`, assigned by the spawner at observer
  spawn) are read-only over the whole session store, mirroring their event-stream
  visibility. Observers never bind or publish.

The bus itself remains unauthenticated in v1 (non-goal); the store is the
enforcement point for data access, and the token never reaches model-visible text or
exec'd children.

## 4. The evaluator

Cells execute in the owning agent's cell worker (§1); value ops execute in the store
worker. Agents submit cells via the `eval` kernel tool; results return as tool
results.

**Namespace contract — bindings only.** An agent's persistent namespace *is its
scope*: names bound via `bind()` (or received via `env`/manifests) persist across
cells and rehydrate from the journal on resume. **Plain JS locals die at cell end.**
`const grouped = groupBy(parse('big_json'), 'type')` is gone next cell unless bound.
This is what makes "cells are never re-executed" honest: rehydration is a journal
metadata replay, not a state reconstruction. The eval tool description and code-mode
system prompt guidance state this contract; referencing an unknown name returns an
error listing the names actually in scope.

**Handles are strings, and re-acquirable.** `spawn()` returns a handle object whose
`.id` is the spawner handle ID; the ambient `handle(id)` re-wraps any ID into a live
handle in a later cell (backed by the owner's spawner state, which is where handles
actually live). Handle IDs appear in cell results and error messages, and are
ordinary strings — bindable, loggable. This is what makes §9's recovery contract
implementable: after a failed `Promise.all`, the next cell calls
`handle(id).wait()` on survivors. Without it, bindings-only persistence would strand
every `blocking: false` child at cell end.

**Spawn routing — through the owner, not around it.** `spawn()` inside a cell does
not touch the spawner directly. It issues a spawn request to the **owning agent's
process**, which executes it through the existing `executeSpawnerDelegation`
(`src/agents/agent.ts:1504+`) — the process that owns the delegation allowlist,
delegate-observer config, verification, learn signals, and resume state. Two
delivery paths, because root is special:

- **Subprocess owners:** the agent process's message pump — which already services
  steer/agent_message during a run (`src/bus/agent-process.ts:418-436`) — gains a
  request/response channel for cell spawn requests while the `eval` call is pending
  (the process's event loop is free; it is awaiting a bus response).
- **Root:** root runs in-process in the host with no pump
  (`src/host/session-controller.ts`); its cell spawn requests are delivered through
  the SessionController bridge — the same trusted path that delivers root's agent
  messages (`src/bus/spawner.ts:401-409`) — directly to the root `Agent` instance.
  Root's spawn machinery is await-heavy I/O, not compute, so servicing it on the
  host loop is acceptable; cell *JS* still runs in root's cell worker.

A handle spawned from a cell is indistinguishable from one spawned by a tool call —
`wait_agent`/`message_agent` on it work.

**Cell spawns deviate from tool-call delegation in three specified ways** (the
machinery was built for one-at-a-time tool calls; fan-out changes the economics):

1. **No mnemonic LLM call.** `executeSpawnerDelegation` today awaits a
   model-generated mnemonic per delegation (`src/agents/agent.ts:1522-1533`) — 50
   owner-model completions before a 50-way fan-out starts, plus a name-collision
   race under concurrency. Cell spawns use deterministic names (goal slug + index).
   Tool-call delegations keep mnemonics.
2. **Delegate-observer frames batch per cell.** Per-spawn frames would serialize a
   fan-out behind ~N sequential observer turns (`src/bus/spawner.ts:848-863`). A
   cell delivers one frame summarizing all its delegations at cell end.
3. **History replay excludes cell-spawn act events.** `act_end` events from
   tool-call delegations carry `tool_result_message` payloads that event replay
   pushes into reconstructed history (`src/kernel/event-replay.ts:76-80`) — correct
   there, because a matching `tool_use` exists in the transcript. A cell spawn has
   *no* transcript tool call; replaying its result message would produce orphaned
   tool-results that all three providers reject as malformed. Cell-spawn act events
   are marked `cell_spawn: true`; replay skips them for history reconstruction
   (telemetry consumers keep them). Child results reach the owner's transcript only
   through the eval tool result. If replay finds a `plan_end` whose pending `eval`
   tool_use has no recorded result (process died mid-cell), it synthesizes an error
   tool result naming the journaled bindings and the handle IDs of children that
   were in flight — closing the transcript validly and giving the resumed agent its
   recovery handles.

**Stumble accounting for cell spawns — counted once, attributed to the owner.**
Per-spawn verify results fold into the cell result as counts; the `eval` primitive's
verify contributes `(failed-child count) + (1 if the cell itself errored for a
non-child reason)` to the owner's run counters via the existing tool-result path. A
cell error *caused by* a child failure is the same stumble, not a second one. Child
agents' own internal stumbles remain their own, as today. This keeps the §10
code-vs-tools comparison honest: neither double-counting (child failure + eval error)
nor undercounting (pump-driven spawns bypassing the run loop's closure-local
counters, `src/agents/agent.ts:2293`).

The entire ambient surface, frozen (kernel API; Learn cannot mutate it):

```js
spawn(agent, goal, {env, hints, blocking, shared, model})
  // blocking (default) → Promise<{ok, summary, bindings, handle}>
  // blocking: false    → resolves immediately to {handle}; result via handle.wait()
handle(id)                              // re-acquire a live handle in a later cell
  // handle.id, handle.wait(), handle.message(text, {env})
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
over threshold) + manifest of new bindings + on error, message, offending line, the
names currently in scope, and the handle IDs of spawns still in flight.

**Budgets, guards, and cancellation:**

- **Compute budget** (default 5 s of actual JS execution, tunable). All awaitables in
  a cell are ambient-API promises, so the cell runtime knows when a cell parks and
  resumes; the host watches park/resume/heartbeat signals, and a cell that is neither
  parked nor completing within budget gets **its own cell worker** terminated and
  respawned (bindings-only namespaces make this cheap). Other agents' cells run in
  their own workers and are unaffected; the store worker is never terminated.
- **The cell's lease is the owner's `eval` call.** If the owning agent is
  interrupted, times out, or its process dies, the host cancels the cell; the cell's
  blocking children — ordinary delegations *of the owner* via spawn routing — follow
  the owner's existing abort/kill semantics.
- **Detached (`blocking: false`) children live exactly as long as their owner's
  process — as today.** When an agent process ends, its child spawner SIGTERMs
  running children (`src/bus/agent-process.ts:486-491`) and orphaned children
  self-abort via parent-pid monitoring. Cells do not change process lifecycle:
  "detach" means *outlive the cell*, not *outlive the owner*. Work that must outlive
  a mid-tree agent belongs in a `shared` handle owned higher in the tree — root-owned
  handles live in the host spawner and survive.
- **Owner inactivity timer: suspended while a cell is pending.** The owner's
  `timeout_ms` is a wall-clock inactivity timer (`src/agents/agent.ts:2304-2308`)
  that would otherwise fire mid-fan-out — cell activity signals are edge-triggered
  (park/resume, spawn lifecycle), so a single child running longer than the timeout
  (routine for an engineer authoring a file — the canonical §10 scenario) would leave
  a silence that kills the cell. Instead: while an `eval` call is pending, the
  owner's inactivity timer is suspended, and the sap host sends the owner a liveness
  heartbeat for the cell (every 30 s); missed heartbeats (dead worker, dead host
  channel) resume the timer. Children remain governed by their own constraints; the
  compute budget governs the cell's own JS; the lease governs owner death. The
  run-loop timer becomes controllable (today it is a closure local; implementation
  threads a pause/resume handle).
- **Blocking spawn waits have no fixed timeout** — parity with today's tool-call
  delegation (`waitForBlockingSpawn` is deliberately timer-less,
  `src/bus/spawner.ts:620-637`), *not* with `waitAgent`'s 900 s waiter cap, which
  would spuriously fail any fan-out containing one slow child. Settlement is
  guaranteed by process-exit result recovery (`src/bus/spawner.ts:247-296`) plus the
  owner lease; "no cap on how long a cell waits for children" stands.
- Spawn cap per cell (default 64, tunable); `MAX_AGENT_DEPTH` applies inside cells
  (enforced by `executeSpawnerDelegation`, since spawns route through it).
- Cells are serialized per agent; concurrency happens inside a cell.
- No bare `llm()` function — that would be a second recursion mechanism (see §5).

**Tool surface rules:** `eval` is granted to agents with `can_spawn: true`; tool-mode
agents may also be granted it explicitly. Granting `eval` implicitly grants the
value-read primitives (§6). Leaves stay pure tool-callers — `$ref` args and
value-read primitives cover them. Reserved-name checks extend to `eval`, the
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

**Per-spawn model override** travels on the spawn request and on `StartMessage` (new
optional field), resolved through the existing model resolver; the spawner records it
on the handle so completed-handle respawn re-applies it.

**Featherweight placement rule.** This agent's workload is fan-out (`Promise.all`
over 50 slices = 50 spawns); a subprocess + bus handshake per call is real overhead
at that scale. Agents that are single-turn, no-tools, no-spawn may execute
in-process **in the owning agent's process** — the process that holds the LLM client
and, critically, the spawner whose handle table `wait_agent`/`message_agent` resolve
against (`src/agents/agent.ts:1743-1763`; handles registered anywhere else throw
`Unknown handle`). Equivalence, stated precisely:

- Identical events and result semantics; a **synthetic completed handle** registers
  in the owner's spawner so `wait_agent` and result caching work.
- **A synthetic per-handle log is written** (a start record and a result record —
  two lines). This is not optional: resume registration drops any handle whose log
  has no result (`src/bus/resume.ts:199-213`), and completed-handle respawn
  rehydrates history by replaying the per-handle log (`src/bus/spawner.ts:798-845`)
  — a follow-up `message_agent` to an llm-call ("refine your answer") must arrive
  with the original request/response as context, as the tool description promises.
- No idle loop, no keep-alive. Crash isolation genuinely differs; that is the trade,
  and why the rule is restricted to single-turn no-tool agents.

## 6. Code-first Act mode

Agent specs gain `act: "code" | "tools"` (default `tools` — today's behavior,
untouched). A code-mode agent's Plan emits one `eval` tool call per Act; the cell is
the plan. Tool-mode agents keep `delegate` and may also hold `eval`. Both modes are
one stable tool call per provider (Anthropic/OpenAI/Gemini), preserving the
cache-stability decision.

**Degradation rule:** when the session's data-plane flag is off (control arm, §10) or
no spawner exists, `act: "code"` degrades to `act: "tools"` — the spec field is a
preference the session honors when the machinery exists, never a way to produce a
zero-tool agent. Because a genome-evolved spec could otherwise reach a degraded
session holding only `eval` in its tools list (and `can_spawn: false`), **granting
`eval` implicitly grants the value-read primitives**: the degraded agent still holds
`value_*` and runs. The genome is shared across sessions; a spec evolved to code-mode
must keep working in every session, and this closes the last zero-tool path.

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
- `cell_start` / `cell_end` — code, duration, compute time, bindings created, error,
  in-flight handle IDs.

Spawns inside cells emit the existing delegation events with `cell_spawn: true`;
history replay skips them (§4), all other consumers (TUI, observers, learn) see them
unchanged. Events carry previews instead of raw content, so observer frames get
cheaper and need less redaction/truncation to fit `max_chars`; metacognitive
observers also gain strictly better signal — dataflow topology ("root re-peeked
⟦test_log⟧ four times; suggest binding the grep result"; "two siblings each re-parsed
the same JSON — this wants to be a program").

TUI: handles render as dim inline `⟦name: 48KB⟧`. Web: preview on hover.

## 9. Failure handling

- Cell errors are tool-result errors (message, line, names in scope, in-flight
  handle IDs) — they flow through the verify → stumble → learn-signal pipeline with
  §4's counting rule. Model-written cells will stumble early; that is the fitness
  function eating.
- Store misses list the names available in the caller's scope; `$ref` misses are
  tool errors (§2).
- `get()`/`value_get` over budget refuse with guidance to slice/grep.
- A child failure inside `Promise.all` rejects the cell unless the code handles it;
  the error names the failed spawn and the surviving handle IDs so the next cell can
  `handle(id).wait()` or retry. Code-mode guidance recommends `Promise.allSettled`
  for fan-out.
- Cell-worker termination (budget overrun) fails that agent's running cell as a
  tool-result error; journaled bindings survive; the worker respawns before the
  agent's next cell. Other agents' cells, in their own workers, are untouched.

## 10. Instrumentation and metrics

All-in must not mean unattributable:

- `act` mode is per-spec; the data plane is a per-session flag (with §6's degradation
  rule) — eval-mode can A/B.
- Metrics: tokens per delegated byte moved; stumble rate by act mode; fan-out
  wall-clock; store hit sizes (how much content stayed below the line); **prompt-
  cache hit rate by arm** (the scope-announcement design (§3) exists to protect it;
  measure that it does).
- Success criterion for the canonical scenario ("author a 50 KB file via children"):
  ≥ 80% token reduction versus baseline, no resume/replay regressions.

## 11. Testing

- **Unit:** store bind/scope/journal/rehydrate; `$ref` whole-arg resolution and
  loud-miss errors; free-text inertness (a `⟦name⟧` in a goal must *not* bind or
  resolve); preview determinism; redaction of previews *and* value-read results;
  value-read truncation bypass and `value_get` refusal; sandbox surface (no
  fs/fetch/process/import); compute-budget park/resume accounting; per-agent
  cell-worker terminate/respawn isolation (guilty cell fails, innocent agent's
  in-flight cell unaffected); auto-bind thresholds and summary budget; naming
  collisions; deterministic cell-spawn names; scope-announcement rendering and
  post-compaction manifest injection; `hitTurnLimit` fix; zero-tool exemption;
  eval-implies-value-reads; CAS handoff over the frame budget; LRU spill/reload;
  store token verification and exec-env token filtering.
- **Integration:** env-passing over the bus (delegate, message, continue, respawn
  StartMessage); auto-bind of oversized child results; shared-handle manifest binding
  into multiple waiters; cell spawn routing through both owner paths (subprocess
  pump and root's SessionController bridge) with allowlist enforcement and stumble
  attribution per §4's counting rule; batched delegate-observer frames; owner
  interrupt/timeout cancelling a pending cell; inactivity-timer suspension across a
  10-minute single-child cell; **resume of an owner whose cell spawned children**
  (replayed history must be provider-valid: no orphaned tool results; dangling eval
  closed with synthesized error carrying in-flight handle IDs); `handle(id)`
  recovery in a post-resume cell; fan-out via `Promise.all`; bindings-only
  rehydration; spawnerless local store parity; featherweight synthetic handle +
  synthetic log surviving resume and respawn-with-history; per-spawn model override
  incl. respawn; program load precedence and root promotion. Keystone assertion:
  `write_file` via `$ref`, verified from recorded provider requests that **the
  content bytes appear in no LLM payload anywhere in the tree**.
- **E2E (eval mode, real models, no mocks):** the canonical 50 KB scenario with
  before/after token measurement; a 50-way llm-call fan-out asserting zero spurious
  failures; prompt-cache hit-rate comparison across arms; stumble-rate tracking per
  act mode.

## 12. Build order

One design, sequenced by dependency; each phase lands green before the next starts:

0. **Kernel prerequisites** — `hitTurnLimit` fix; zero-tool completion agents;
   run-loop inactivity timer made pausable.
1. **Store** — store worker, journal, previews + redaction (bind and read side),
   CAS transport/spill, per-handle store tokens + exec-env filtering, auto-bind at
   agent boundaries, `value_bind` events, value-read primitives (with truncation
   bypass), scope announcements + post-compaction manifest (tool-mode agents are
   full data-plane citizens from day one — no phase gap where content is bound but
   unreadable).
2. **Splice** — `$ref` whole-arg resolution with loud-miss errors, `env` on
   delegate/message/continue/StartMessage, result manifests + summary budget,
   spawnerless local store.
3. **Evaluator** — per-agent cell workers, ambient API incl. `handle(id)`, spawn
   routing (subprocess pump + root bridge) with cell-spawn deviations (deterministic
   names, batched observer frames, replay-excluded act events, dangling-eval
   closure), stumble counting rule, timer suspension + heartbeats, cancellation
   lease, featherweight placement + synthetic logs, `utility/llm-call`.
4. **Code-first** — `act` spec field + degradation rule, eval-implies-value-reads,
   observer store access, TUI/web rendering.
5. **Programs** — genome artifact type + sync/export plumbing, quartermaster
   fabrication, eval-mode gating, metrics dashboards.

## 13. Design decisions log

| Decision | Choice | Why |
|---|---|---|
| REPL role | Orchestration surface + RLM data ops; full RLM deferred | Sprout's pain is inter-agent transport, not single-context rot |
| Surface language | JS cells via one `eval` tool; handles work with zero JS | Data structure at the core; JS as the wiring power-up |
| Topology | One store worker + per-agent cell workers; agent loops stay subprocesses | Code moves to data; budget kills are surgical (one agent's cell, never the store or innocent cells) |
| Spawn routing | Cells spawn through the owning agent (subprocess pump; SessionController bridge for in-process root) | Delegation machinery state lives in the owner; root has no subprocess |
| Cell-spawn deviations | No mnemonic LLM call; batched observer frames; replay-excluded act events | Per-spawn LLM calls and serialized observer turns don't survive 50-way fan-out; orphaned tool-results break provider replay |
| Stumble counting | Failed children + non-child cell errors, counted once via the eval result path | Double-counting biases against code mode; pump-bypass undercounting biases for it |
| Namespace persistence | Bindings only; locals die at cell end; `handle(id)` re-acquires | Makes never-re-execute resume honest without stranding children |
| Reference semantics | Explicit env/$ref only; free-text ⟦name⟧ inert; $ref miss is a loud error | Quoted untrusted content must never mint bindings; silent literal writes are corruption |
| $ref form | Whole-arg string `"⟦name⟧"` | Schema-valid on all providers; object form breaks strict validation |
| Scoping | Explicit env, no ambient ancestor visibility; publish-up manifests | Children are different minds; provenance stays explainable |
| Scope knowledge | Message-stream announcements + post-compaction manifest | System-prompt placement would invalidate the whole conversation cache on every bind |
| Store access | Per-handle secret tokens, host-verified; observers by spawner-assigned role | The bus has no caller identity; self-reported addresses are not enforcement |
| Value naming | Model-named > provenance-derived > numeric suffix | Names are prompt-visible documentation |
| Sub-LM calls | `utility/llm-call` genome agent, not a kernel `llm()` | One recursion mechanism; evolvable |
| Cell limits | Compute budget via park/resume; owner lease; timer suspended while cell pending; no fixed cap on child waits | Cells legitimately await children past every fixed timer; edge-triggered signals can't cover a long quiet child |
| Auto-bind boundary | Agent boundaries and cell outputs; leaf primitive results keep today's truncation | A leaf ingesting its file is the job |
| Featherweight | Runs in the owner's process; synthetic handle + two-line synthetic log | wait_agent resolves against the owner's spawner; resume and respawn read per-handle logs |
| Mode choice | `act` per spec with session degradation rule; eval implies value-reads | Don't decide, evolve — with no path to a zero-tool agent |

## 14. Adversarial review log

**Round 1 (2026-07-16, against the first committed draft):** two independent
reviews, 21 distinct legitimate findings. Highlights: evaluator-on-host-thread was
unimplementable; `executeSpawnerDelegation` reuse was asserted but unreachable;
auto-bind starved tool-mode/leaf agents; namespace rehydration contradicted
never-re-execute; payload `$ref` bypass violated the one rule; free-text splicing
was an injection channel; `max_turns: 1` and `tools: []` were rejected or mis-scored
by existing kernel code (one pre-existing bug found); previews-vs-redaction, WS
frame caps, GC, shared-handle scopes, spawnerless mode, featherweight equivalence,
flag/genome coherence.

**Round 2 (2026-07-17, against the round-1 revision):** two fresh independent
reviews, 16 distinct findings — mostly breaking round-1 fixes. Highlights:
owner-routed spawn events would corrupt provider-valid history replay (→ replay
exclusion + dangling-eval closure); the "spawner-verified identity" the scope rules
cited does not exist on the unauthenticated bus (→ per-handle store tokens);
single-worker termination had cross-agent blast radius (→ per-agent cell workers);
the system-prompt `<scope>` block would defeat the conversation prompt cache (→
message-stream announcements); handles didn't survive cells, unimplementing §9's
own recovery story (→ `handle(id)`); waiter-timeout "parity" contradicted no-cap (→
timer-less blocking waits); edge-triggered activity signals couldn't cover one long
child (→ timer suspension + heartbeats); root had no pump for spawn routing (→
SessionController bridge); mnemonic naming cost an owner-model LLM call per spawn
(→ deterministic cell-spawn names); stumble double-count/undercount (→ counting
rule); featherweight synthetic handles broke resume/respawn without logs (→
synthetic logs, owner-process placement); bind-time-only redaction left the read
channel raw (→ read-side redaction); `value_get` met the 30 K truncation layer (→
bypass + explicit budget); `$ref` silent literal passthrough corrupted the keystone
path (→ loud miss); `blocking: false` survival claim was false (→ corrected
lifecycle semantics); eval-only tool lists could still produce a zero-tool agent (→
eval implies value-reads).
