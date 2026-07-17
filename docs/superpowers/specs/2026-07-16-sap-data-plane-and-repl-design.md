# Sap: a data plane and REPL for sprout

**Date:** 2026-07-16
**Status:** Approved design, revised after three adversarial review rounds (§14), pre-implementation
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

- Data produced by one agent — or by the environment (files, command output) — flows
  to other agents without transiting any LLM context.
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
  model as `exec` on leaf agents today. Store access checks (§3) are enforced
  host-side over authenticated per-process channels, but exec-capable agents share
  the OS user and can read journal/CAS files on disk — the checks stop confused
  deputies and accidental cross-scope access, not a determined same-UID attacker.
- **Observer-granted cross-scope access.** Observers may mention values in messages,
  but mentioning never grants the recipient access outside its scope — and observer
  messages cannot carry `env` (§3).
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
  a 200 MB value executes here and returns matches, never shipping the bytes.
- **One cell worker per agent** (lazy-created on first `eval`, destroyed when the
  agent completes). Runs that agent's cell JS and holds its namespace. Cells call
  value ops through a message channel to the store worker; value-op results are
  bounded, and materialization (`get`/`parse`) is budgeted. Arbitrary heavy JS over
  full contents beyond those budgets is unsupported — use value ops or delegate.

This split makes budget enforcement surgical: terminating a runaway cell kills *only
that agent's* cell worker (§4, §9) — never another agent's in-flight cell, never the
store, never the bus/UI/spawner.

**Store ops are budgeted too.** The store worker runs model-influenced work (grep
patterns are model-written; JS regexes can backtrack catastrophically), so it is not
exempt from discipline: `value_grep` executes chunk-at-a-time (bounding any one
regex application) with an abort check between chunks, and every store op carries an
op timeout (default 10 s) that fails that op without harming the worker. If the
worker nonetheless wedges (a single chunk's regex application is uninterruptible JS),
the host restarts it: the worker holds no unjournaled state — values live in the
journal and CAS — so restart is reload; in-flight ops fail with retryable errors.
Cell budget enforcement never touches the store worker; wedge recovery may.

**Value model.** Values are utf8 text, JSON, or bytes. Metadata: ULID, name, scope,
type, size, provenance (producing agent handle, cell or delegation, primitive and
args), and a deterministic preview. Values are **immutable once bound** — rebinding a
name creates a new version; a name resolved in a scope pins a version. Immutability
makes previews cacheable, concurrent children race-free, the journal trustworthy, and
spill/restart trivial.

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

1. Deliberate binds are model-named: `bind('failing_tests', ...)` in cells, and the
   `bind:` argument on capture-capable primitives (§2).
2. Auto-binds get provenance-derived names, deterministically, no LLM in the path:
   a child result → a goal slug such as `implement_endpoints_result`; a truncated
   primitive result → `exec_bun_test_output`; a cell output → `cell_<n>_output`.
3. Collisions take a numeric suffix. Consumers may alias any name locally via `env`.
   Global identity is the ULID; names are per-scope.

**Durability.** Append-only JSONL journal per session in the durable log directory:
bind records (metadata plus inline value, or a content-addressed file reference —
sha256, dedup for free), scope records (created at delegation, publish-at-result), and
cell records (code, bindings created, error, compute time). Resume replays journal
*metadata* and lazy-loads bodies from CAS. **Cells are never re-executed on resume;
effects do not replay.**

**Transport.** Store traffic does **not** ride the session pub/sub bus. The bus is
open, unauthenticated fan-out (`src/bus/server.ts` — no auth, no topic ACLs): store
requests on broadcast topics would expose every agent's credentials and raw value
contents to any connected client. Instead the host serves a dedicated store endpoint;
each agent process opens its own connection, authenticated at handshake with its
per-handle token (§3), and the host maps connection → verified identity thereafter.
Large bodies still transfer by CAS handoff (producer writes the CAS file, sends
`{path, sha256}`; store verifies and adopts) above a frame budget (default 4 MB); the
endpoint sets an explicit max frame size (Bun's default WebSocket cap is 16 MB —
unstated, mid-size frames silently drop the connection).

**Memory management.** The store worker holds hot values under a memory budget
(default 512 MB) with LRU spill to CAS; immutability makes spill/reload safe. Values
unreferenced by any live scope are spill-first. No within-session deletion in v1;
session end prunes everything.

**Lifetime.** Session-scoped. `/clear` drops the store with the rest of session state.

**Defaults (config-tunable):** preview budget 300 chars; auto-bind threshold 2,000
chars; result summary budget 4,000 chars; cell `get()`/`parse()` budget 1 MB;
`value_get` primitive budget 50,000 chars (read_file parity); store op timeout 10 s;
frame budget 4 MB; store memory budget 512 MB; max value size 256 MB.

## 2. Splicing and capture

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

**`$ref` is accepted only in content-carrying arguments — a kernel allowlist.**
`write_file`/`edit_file`/`apply_patch` content and patch bodies: yes. `exec`
commands, `fetch` URLs, file paths, grep patterns: no. The one rule guarantees no
model sees spliced content — which is exactly why arguments that *do* things
(execute, address, navigate) must keep transiting the authoring model's context;
`exec("⟦cmd⟧")` would execute bytes no model ever read, bytes that can originate in
untrusted content. The allowlist is part of the frozen splice semantics.

**A `$ref` miss is a loud tool error, never a silent literal.** A whole-arg `⟦name⟧`
is unambiguous model-authored intent to splice; on a typo or stale name the primitive
fails with an error listing the names actually in scope. Silent passthrough would
write the literal `⟦impl⟧` as file content, succeed, and surface as corruption much
later. (To write a literal `⟦name⟧` string that is also a scope name: bind the
literal and `$ref` it. Degenerate and rare.)

**Free-text `⟦name⟧` (goals, hints, messages) is inert notation.** It never resolves,
never binds, never grants. This is deliberate: agents routinely quote untrusted
content (file contents, exec output, fetched pages) into goals, and auto-bind names
are predictable — if quoted text could mint bindings, any content that can influence a
tool result could plant `⟦deploy_key⟧` in a goal and exfiltrate it through a child.
Rendering surfaces (TUI, web) may decorate `⟦name⟧` with a preview when the name is
already in the reader's scope; the runtime attaches no semantics.

**Capture: how environment data enters the store below the line.** Without this, the
store could only ever hold LLM output — every value would originate as generated
tokens, and a test log could enter the store only by a child re-emitting it, the
exact anti-pattern the Motivation forbids. Two mechanisms:

1. **Explicit `bind:` on ingestion primitives.** `read_file`, `exec`, `grep`, and
   `fetch` gain an optional `bind` string argument. When set, the full result goes
   producer → store, raw, below the line; the tool result above the line is the
   preview + handle (plus today's inline head up to the truncation limit if the
   caller also wants to read it). `exec("bun test", bind: "test_log")` is how a
   400 KB log becomes `⟦test_log⟧` for ~5 output tokens.
2. **Auto-capture on truncation.** Today, when a primitive result exceeds the
   truncation limit, the middle is *lost*, and the banner falsely claims "the full
   output is available in the event stream" (`src/kernel/truncation.ts`). With the
   store present, the full result binds automatically and the banner becomes true
   and useful: `[... 380KB truncated — full output: ⟦exec_bun_test_output⟧]`. This
   applies to all agents, leaves included: the leaf still sees today's inline
   head/tail (no starvation), and nothing is lost anymore.

Capture is ingestion, so captured previews pass bind-time redaction (§1).

**Task payloads are unchanged.** `task_payload` renders inline into the child's goal
prompt (`src/agents/delegation-payload.ts:39-54`) and keeps its 64 KiB cap. There is
no `$ref` bypass — payloads have no below-the-LLM consumer. Reference passing is
`env`'s job; code-mode guidance discourages payloads.

**Auto-bind (upward, at agent boundaries).** Auto-bind applies to results crossing an
*agent* boundary — child results published upward, and cell outputs. A child's
`ResultMessage.output` stays inline up to the **summary budget** (default 4,000 chars
— the judgment channel, worth paying for); overflow auto-binds. Published values
beyond the summary arrive as a manifest:

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
`truncateToolOutput` layer** (`src/kernel/primitives.ts:72-83`): a value-read is a
precision instrument whose own budgets *are* the truncation policy. `value_get` over
its 50,000-char budget refuses with guidance to slice/grep — never a silent
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
capture, auto-bind, and value-read primitives all work. The evaluator requires the
spawner; in spawnerless mode `eval` is unavailable and `act: "code"` degrades to
`"tools"` (§6).

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
cells and captures), the runtime appends a compact scope announcement to history as
a user-role message — the mechanism already used for steering and new-agent
announcements (`src/agents/agent.ts:2338-2345`): `New bindings: ⟦impl: 48KB ts⟧ ...`.
After **compaction**, the runtime injects a fresh consolidated scope manifest as the
first post-compaction message, *emitted as a replayable event* (steering-class) so
event replay — which resets history to the summary on a compaction record
(`src/kernel/event-replay.ts:81-84`) — reconstructs it too. System-prompt placement
was considered and rejected: the system block heads every provider's cache prefix
(`src/llm/anthropic.ts:187-195`), so a scope block there would invalidate the entire
conversation cache on every bind — the steady-state operation of this design.
Message-stream appends preserve the prefix; cached history stays cached.

**Store access control — authenticated channel, host-enforced.** The bus has no
caller identity (anonymous connections, open topics, self-reported addresses), so
the store does not use the bus (§1 transport). At spawn, the spawner mints a
**per-handle secret token**, delivered in the subprocess environment alongside
`SPROUT_HANDLE_ID` (`src/bus/spawner.ts:539-548`). The token — **and the store
endpoint URL, and `SPROUT_BUS_URL`** — are filtered from `exec` child environments
(`src/kernel/execution-env.ts`; bus URL filtering is new — today exec children
inherit it, which also lets model-authored shell code speak raw bus protocol).
The token authenticates the agent process's store connection at handshake; identity
is per-connection thereafter, never per-message. Root and host facilities use an
in-process trusted path. Scope rules on that verified identity:

- Ordinary agents read **their own scope only** (no ancestor chain).
- **Observers** (verified `role: "observer"`, assigned by the spawner at observer
  spawn) are read-only over the whole session store, mirroring their event-stream
  visibility. Observers never bind or publish — **and observer-role senders cannot
  attach `env` to messages.** Without that rule, observer whole-store read plus
  §2's "env validated against the sender's scope" would let an observer grant its
  caller any value in the session — exactly the cross-scope grant the non-goals
  forbid.

Within the v1 trust model (non-goals), these checks stop confused deputies, not a
same-UID attacker reading journal files off disk.

## 4. The evaluator

Cells execute in the owning agent's cell worker (§1); value ops execute in the store
worker. Agents submit cells via the `eval` kernel tool; results return as tool
results.

**Namespace contract — bindings only.** An agent's persistent namespace *is its
scope*: names bound via `bind()` (or received via `env`/manifests) persist across
cells and rehydrate from the journal on resume. **Plain JS locals die at cell end.**
This is what makes "cells are never re-executed" honest: rehydration is a journal
metadata replay, not a state reconstruction. The eval tool description and code-mode
system prompt guidance state this contract; referencing an unknown name returns an
error listing the names actually in scope.

**Handles are strings, and re-acquirable.** `spawn()` returns a handle object whose
`.id` is the spawner handle ID; the ambient `handle(id)` re-wraps any ID into a live
handle in a later cell (backed by the owner's spawner state, which is where handles
actually live). `handle(id).wait()` uses the **timer-less blocking-wait path** (the
same wait as a blocking spawn, `src/bus/spawner.ts:620-637`) — *not* the `wait_agent`
tool's 900 s waiter cap (`src/bus/spawner.ts:369`), which would spuriously fail
exactly the long-running survivors recovery exists for. The `wait_agent` *tool*
keeps its cap; the ambient API does not inherit it.

**Spawn routing — through the owner, not around it.** `spawn()` inside a cell does
not touch the spawner directly. It issues a spawn request to the **owning agent's
process**, which executes it through the existing `executeSpawnerDelegation`
(`src/agents/agent.ts:1504+`) — the process that owns the delegation allowlist,
delegate-observer config, verification, learn signals, and resume state. Two
delivery paths, because root is special:

- **Subprocess owners:** the agent process's message pump — which services
  steer/agent_message during the initial run (`src/bus/agent-process.ts:418-436`)
  **and in `idleLoop` for shared/keep-alive agents' continue turns** — gains a
  request/response channel for cell spawn requests while an `eval` call is pending.
- **Root:** root runs in-process in the host with no pump; its cell spawn requests
  are delivered through the SessionController bridge — the same trusted path that
  delivers root's agent messages (`src/bus/spawner.ts:401-409`) — directly to the
  root `Agent` instance. Root's spawn machinery is await-heavy I/O, not compute;
  cell *JS* still runs in root's cell worker.

A handle spawned from a cell is indistinguishable from one spawned by a tool call —
`wait_agent`/`message_agent` on it work.

**The spawn contract, resolved precisely** (this is the evaluator's central
contract; genome programs will be written against it):

- A blocking `spawn()` **resolves on child completion regardless of child success**:
  `{ok, summary, bindings, handle}` with `ok: false` for an unsuccessful child.
- It **rejects only on spawn-infrastructure failure**: unknown agent, allowlist
  denial, depth exceeded, spawn/transport failure, cancellation by the owner lease.
- Fan-out code therefore checks `ok` (`results.filter(r => !r.ok)`);
  `Promise.allSettled` is guidance for infrastructure robustness, not the primary
  failure channel. A cell that ends with unhandled `ok: false` results is not
  automatically an error; the model judges, exactly as a tool-mode parent judges a
  failed delegate tool result.

**Cell spawns deviate from tool-call delegation in four specified ways** (the
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
   *no* transcript tool call; replaying its result would produce orphaned
   tool-results all three providers reject. Cell-spawn act events are marked
   `cell_spawn: true`; replay skips them for history reconstruction (telemetry
   consumers keep them). Child results reach the owner's transcript only through
   the eval tool result. If replay finds a `plan_end` whose pending `eval` tool_use
   has no recorded result (process died mid-cell), it synthesizes an error tool
   result that closes the transcript validly and **tells the truth about the
   children**: those with journaled results are listed as recoverable (their
   per-handle logs register at resume, `src/bus/resume.ts:199-213`); those still
   in flight **died with the owner** (`src/bus/agent-process.ts:486-491`; ppid
   monitoring) and are listed as `died_with_owner` — re-spawn, don't wait.
   `handle(id)` on a dead ID returns a clean error making the same distinction.
4. **Learn signals are deduplicated, not just stumble counts.** Per-spawn learn
   signals from `executeSpawnerDelegation` (`src/agents/agent.ts:1661-1676`) are
   tagged with the cell ID; the eval-level verify emits a cell-level signal only
   for cell-authored errors (thrown code, budget kill), never a second signal for
   a child failure already signaled per-spawn. Without this, one failed child
   reports twice to Learn, biasing quartermaster repair pressure.

**Stumble accounting — counted once, attributed to the owner.** Per-spawn verify
results fold into the cell result as counts; the `eval` primitive's verify
contributes `(failed-child count) + (1 if the cell itself errored for a non-child
reason)` to the owner's run counters. This requires extending the tool-result path
to carry a count (today it contributes at most 1 boolean per result,
`src/agents/agent.ts:2250-2252`) — a stated change, not silent reuse. Child agents'
own internal stumbles remain their own, as today. This keeps the §10 code-vs-tools
comparison honest: no double-counting, no pump-bypass undercounting.

The entire ambient surface, frozen (kernel API; Learn cannot mutate it):

```js
spawn(agent, goal, {env, hints, blocking, shared, model})
  // blocking (default) → resolves {ok, summary, bindings, handle} on completion;
  //                      rejects only on spawn-infrastructure failure
  // blocking: false    → resolves immediately to {handle}
handle(id)                              // re-acquire a live handle in a later cell
  // handle.id, handle.wait() [timer-less], handle.message(text, {env})
bind(name, value)                       // deliberate, model-named; the only persistence
peek(name, {head, tail})
slice(name, start, end)
lines(name, from, to)
grep(name, pattern, {context})
parse(name)                             // JSON — budgeted like get()
size(name)
get(name)                               // full materialize — budgeted; refuses over
                                        // budget with guidance to slice/grep
console.log(...)                        // captured into cell output
// plus the pure JS stdlib. No fs, no fetch, no process, no import/require.
```

`parse()` shares `get()`'s materialization budget (default 1 MB): it produces the
full parsed structure in the cell worker, which is materialization. Over-budget
JSON → refuse with guidance (grep/slice first, or delegate). The §1 "bounded ops"
contract holds because the two materializers are the budgeted ones.

**Cell results to the LLM:** captured stdout + final expression value (auto-bound if
over threshold) + manifest of new bindings + on error, message, offending line, the
names currently in scope, and the handle IDs of spawns still in flight.

**Budgets, guards, and cancellation:**

- **The budget clock runs on wall time not parked on ambient-API awaits.** A cell
  is "parked" only while awaiting an ambient-API promise (spawn, store op, handle
  wait) — those are the awaitables the runtime can see and account. Model-written
  code *can* construct other promises (`await new Promise(() => {})`, async
  deadlocks); the premise "all awaitables are ambient" is unenforceable, so the
  budget doesn't rest on it: any time spent neither executing nor ambient-parked
  accrues against the budget (default 5 s) exactly like a runaway loop, and the
  cell is killed when it exceeds it. Sync loops, catastrophic regexes, and phantom
  awaits all die by the same clock; legitimate long child-waits are ambient parks
  and never accrue.
- **The cell's lease is the owner's `eval` call.** If the owning agent is
  interrupted, times out, or its process dies, the host cancels the cell; the cell's
  blocking children — ordinary delegations *of the owner* via spawn routing — follow
  the owner's existing abort/kill semantics.
- **Detached (`blocking: false`) children live exactly as long as their owner's
  process — as today.** "Detach" means *outlive the cell*, not *outlive the owner*.
  Work that must outlive a mid-tree agent belongs in a `shared` handle owned higher
  in the tree.
- **Owner inactivity timer: suspended while a blocking child or a cell is pending —
  both arms.** The owner's `timeout_ms` is a wall-clock inactivity timer
  (`src/agents/agent.ts:2304-2308`) reset only after planning and after a tool
  batch (`src/agents/agent.ts:2407, 2485`) — which means **today**, a single
  blocking tool-call delegation outliving `timeout_ms` (default 300 s) already
  marks the owner timed-out and stumbled even when the child succeeds. That is a
  pre-existing latent bug, and it would also confound §10 if only the code-mode arm
  escaped it. Fix (Phase 0, with the timer made pausable): the inactivity timer
  suspends whenever the agent is awaiting a blocking delegation *or* a pending
  `eval`, resumed by liveness heartbeats' absence (dead child process, dead worker
  or host channel → timer resumes). Both act modes get identical timer semantics;
  the §10 comparison stays clean.
- Spawn cap per cell (default 64, tunable); `MAX_AGENT_DEPTH` applies inside cells
  (enforced by `executeSpawnerDelegation`, since spawns route through it).
- Cells are serialized per agent; concurrency happens inside a cell.
- No bare `llm()` function — that would be a second recursion mechanism (see §5).

**Tool surface rules:** `eval` is granted to agents with `can_spawn: true`; tool-mode
agents may also be granted it explicitly. Granting `eval` implicitly grants the
value-read primitives (§6). Leaves stay pure tool-callers — `$ref` args, capture,
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

**Two kernel prerequisites:**

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
and the spawner whose handle table `wait_agent`/`message_agent` resolve against
(`src/agents/agent.ts:1743-1763`). Equivalence, stated precisely:

- Identical events and result semantics; a **synthetic completed handle** registers
  in the owner's spawner so `wait_agent` and result caching work.
- **A synthetic per-handle log of three records** — `perceive` (the request),
  `plan_end` (the response), `session_end` (the result). Three is the minimum, not
  two: resume registration requires a `session_end` result record
  (`src/bus/resume.ts:104-125, 144-181`), while respawn-with-history rebuilds the
  conversation from `perceive`/`plan_end`-class events
  (`src/kernel/event-replay.ts:55-90`) — a follow-up `message_agent` ("refine your
  answer") must arrive with the original request *and response* in history, as the
  tool description promises.
- No idle loop, no keep-alive. Crash isolation genuinely differs; that is the trade,
  and why the rule is restricted to single-turn no-tool agents.

## 6. Code-first Act mode

Agent specs gain `act: "code" | "tools"` (default `tools` — today's behavior,
untouched). A code-mode agent's Plan emits one `eval` tool call per Act; the cell is
the plan. Tool-mode agents keep `delegate` and may also hold `eval`. Both modes are
one stable tool call per provider (Anthropic/OpenAI/Gemini), preserving the
cache-stability decision.

**The data-plane session flag, defined.** Off means *off*: no store service, no
tokens, no capture, no splicing, no auto-bind, no scope announcements, no `eval` —
the control arm is a true baseline for every §10 metric. `value_*` and `eval`
filter out of the registry in off-sessions; `act: "code"` degrades to `"tools"`.

**No zero-tool path — enforced at mutation time, not patched at runtime.** A
degraded eval-only spec would hold zero functional tools in an off-session (and
"granting dead `value_*` tools" would satisfy the zero-tool check's letter while
producing a guaranteed-stumble agent that pollutes the §10 metrics). So genome
validation forbids the shape at the source: a spec granting `eval` must also have
`can_spawn: true`, or other real tools, or the `max_turns: 1` completion exemption
(§5). Validation runs at creation and mutation (`markdown-loader` + genome gates),
where the quartermaster's products are already checked. The genome is shared across
sessions; a spec evolved to code-mode must keep working in every session.

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
  ambient API and the `$ref` allowlist) are kernel — Learn cannot touch them.
  Programs are genome — fully evolvable. The kernel list in `docs/architecture.md`
  grows accordingly.

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
  §4's counting and dedup rules. Model-written cells will stumble early; that is
  the fitness function eating.
- Child failure is **not** a cell error: blocking spawns resolve `{ok: false}` (§4
  spawn contract); the model judges, as a tool-mode parent judges a failed delegate
  result. Spawn-infrastructure failures reject; unhandled rejections fail the cell
  with an error naming the failed spawn and surviving handle IDs, and the next cell
  recovers via `handle(id)` (timer-less waits).
- Store misses list the names available in the caller's scope; `$ref` misses are
  tool errors (§2); store op timeouts fail the op, not the worker; a wedged store
  worker restarts from journal+CAS with in-flight ops failing retryably.
- `get()`/`parse()`/`value_get` over budget refuse with guidance to slice/grep.
- Cell-worker termination (budget overrun) fails that agent's running cell as a
  tool-result error; journaled bindings survive; the worker respawns before the
  agent's next cell. Other agents' cells, in their own workers, are untouched.
- After owner death mid-cell, resume distinguishes recoverable children (journaled
  results) from `died_with_owner` (§4); the synthesized eval error carries both
  lists.

## 10. Instrumentation and metrics

All-in must not mean unattributable:

- `act` mode is per-spec; the data plane is a per-session flag (§6, with defined
  off-semantics) — eval-mode can A/B against a true baseline.
- Timer semantics are identical across arms (§4) so stumble-rate differences
  measure orchestration, not timer policy.
- Metrics: tokens per delegated byte moved; stumble rate by act mode; fan-out
  wall-clock; store hit sizes (how much content stayed below the line);
  prompt-cache hit rate by arm (the scope-announcement design (§3) exists to
  protect it; measure that it does).
- Success criterion for the canonical scenario ("author a 50 KB file via children"):
  ≥ 80% token reduction versus baseline, no resume/replay regressions.

## 11. Testing

- **Unit:** store bind/scope/journal/rehydrate; capture (`bind:` args, auto-capture
  on truncation with truthful banner); `$ref` whole-arg resolution, loud-miss
  errors, and per-primitive allowlist (splice into `exec` must be rejected);
  free-text inertness; preview determinism; redaction of previews *and* value-read
  results; value-read truncation bypass and `value_get` refusal; `parse()`/`get()`
  budgets; store op timeouts, chunked grep abort, wedge restart from journal;
  sandbox surface (no fs/fetch/process/import); budget clock accrual on
  non-ambient awaits (`await new Promise(() => {})` must die at the budget, an
  ambient park must not); per-agent cell-worker terminate/respawn isolation;
  auto-bind thresholds and summary budget; naming collisions; deterministic
  cell-spawn names; scope-announcement rendering, post-compaction manifest, and its
  replayable event; `hitTurnLimit` fix; timer suspension for blocking delegations
  and pending evals; zero-tool exemption and eval-only genome validation; CAS
  handoff over the frame budget; LRU spill/reload; store handshake auth (bad token
  rejected) and env filtering of token, store URL, and bus URL from exec children.
- **Integration:** env-passing over the bus (delegate, message, continue, respawn
  StartMessage); observer messages with `env` rejected; auto-bind of oversized
  child results; shared-handle manifest binding into multiple waiters; cell spawn
  routing through all three owner paths (initial-run pump, idleLoop, root bridge)
  with allowlist enforcement, stumble counting, and learn-signal dedup; spawn
  contract semantics (`ok: false` resolution vs infrastructure rejection); owner
  interrupt/timeout cancelling a pending cell; a 10-minute single-child await
  surviving under suspended timers in *both* act modes; **resume of an owner whose
  cell spawned children** (provider-valid replayed history; dangling eval closed
  with recoverable vs `died_with_owner` lists; `handle(id)` on each behaving as
  specified); fan-out via `Promise.all` with `ok`-checking; bindings-only
  rehydration; spawnerless local store parity; featherweight three-record log
  surviving resume and respawn-with-history; per-spawn model override incl.
  respawn; program load precedence and root promotion. Keystone assertion:
  `write_file` via `$ref`, verified from recorded provider requests that **the
  content bytes appear in no LLM payload anywhere in the tree**.
- **E2E (eval mode, real models, no mocks):** the canonical 50 KB scenario with
  before/after token measurement; a 50-way llm-call fan-out asserting zero spurious
  failures; an `exec`-captured 400 KB log grepped and diagnosed without the log
  transiting any LLM; prompt-cache hit-rate comparison across arms; stumble-rate
  tracking per act mode.

## 12. Build order

One design, sequenced by dependency; each phase lands green before the next starts:

0. **Kernel prerequisites** — `hitTurnLimit` fix; zero-tool completion agents;
   inactivity timer made pausable **and suspended during blocking delegations**
   (pre-existing spurious-timeout bug).
1. **Store** — store worker (op budgets, wedge restart), journal, previews +
   redaction (bind and read side), authenticated store endpoint + per-handle tokens
   + env filtering (token, store URL, bus URL), CAS transport/spill, **capture**
   (`bind:` args + auto-capture on truncation), auto-bind at agent boundaries,
   `value_bind` events, value-read primitives (with truncation bypass), scope
   announcements + post-compaction manifest event.
2. **Splice** — `$ref` whole-arg resolution with loud-miss errors and the
   per-primitive allowlist, `env` on delegate/message/continue/StartMessage (with
   the observer-env prohibition), result manifests + summary budget, spawnerless
   local store.
3. **Evaluator** — per-agent cell workers, ambient API incl. `handle(id)` and the
   resolved spawn contract, spawn routing (pump + idleLoop + root bridge) with the
   four cell-spawn deviations, stumble counting + learn dedup, budget clock,
   cancellation lease, featherweight placement + three-record logs,
   `utility/llm-call`.
4. **Code-first** — `act` spec field + flag semantics + genome validation,
   eval-implies-value-reads, observer store access, TUI/web rendering.
5. **Programs** — genome artifact type + sync/export plumbing, quartermaster
   fabrication, eval-mode gating, metrics dashboards.

## 13. Design decisions log

| Decision | Choice | Why |
|---|---|---|
| REPL role | Orchestration surface + RLM data ops; full RLM deferred | Sprout's pain is inter-agent transport, not single-context rot |
| Surface language | JS cells via one `eval` tool; handles work with zero JS | Data structure at the core; JS as the wiring power-up |
| Topology | One store worker + per-agent cell workers; agent loops stay subprocesses | Code moves to data; budget kills are surgical; store ops get their own budgets and wedge-restart |
| Ingestion | `bind:` on ingestion primitives + auto-capture on truncation | Without below-the-line capture, every stored byte would originate as LLM output — the design's own anti-pattern |
| Spawn routing | Cells spawn through the owning agent (pump/idleLoop; SessionController bridge for root) | Delegation machinery state lives in the owner; root has no subprocess |
| Spawn contract | Resolve `{ok:false}` on child failure; reject only on infrastructure failure | Programs need one unambiguous contract; mirrors tool-mode judgment |
| Cell-spawn deviations | No mnemonic LLM call; batched observer frames; replay-excluded act events; learn-signal dedup | Fan-out economics; provider-valid replay; no double-reporting to Learn |
| Namespace persistence | Bindings only; locals die at cell end; `handle(id)` re-acquires (timer-less waits) | Never-re-execute resume, without stranding children or inheriting the 900 s cap |
| Reference semantics | Explicit env/$ref only; free-text inert; loud misses; content-only `$ref` allowlist | Untrusted content must never mint bindings; executed/addressed args must transit the authoring model |
| Scope knowledge | Message-stream announcements + replayable post-compaction manifest | System-prompt placement would invalidate the conversation cache on every bind |
| Store access | Dedicated authenticated endpoint; per-handle tokens; env filtering incl. bus URL; observers read-only, no env | The bus is open pub/sub — tokens on it would broadcast; observer env would be a cross-scope grant |
| Budget clock | Wall time not parked on ambient awaits | "All awaitables are ambient" is unenforceable; phantom awaits must die by the same clock as runaway loops |
| Timers | Inactivity timer suspended during blocking delegations and pending cells, both arms | Pre-existing spurious-timeout bug; asymmetric suspension would confound the §10 experiment |
| Sub-LM calls | `utility/llm-call` genome agent, not a kernel `llm()` | One recursion mechanism; evolvable |
| Auto-bind boundary | Agent boundaries and cell outputs; leaf primitive results keep today's inline behavior + capture | A leaf ingesting its file is the job; capture adds the store without starving it |
| Featherweight | Owner-process placement; synthetic three-record log | wait_agent resolves against the owner's spawner; resume needs session_end, respawn needs perceive+plan_end |
| Mode choice | `act` per spec; defined off-flag; eval-only specs invalid at mutation time | Don't decide, evolve — with a true control arm and no zero-tool path |

## 14. Adversarial review log

**Round 1 (2026-07-16, first committed draft):** two independent reviews, 21
distinct findings. Highlights: evaluator-on-host-thread unimplementable;
`executeSpawnerDelegation` reuse unreachable; auto-bind starved tool-mode/leaf
agents; namespace rehydration contradicted never-re-execute; payload `$ref` bypass;
free-text splicing as injection channel; `max_turns: 1` / `tools: []` rejected by
kernel code (one pre-existing bug); redaction, frame caps, GC, shared-handle
scopes, spawnerless mode, featherweight equivalence, flag/genome coherence.

**Round 2 (2026-07-17, against the round-1 revision; reviewers directed at
revision-era text):** 16 distinct findings, mostly breaking round-1 fixes:
owner-routed spawn events corrupted provider-valid replay; "spawner-verified
identity" didn't exist; single-worker termination blast radius; system-prompt
`<scope>` block defeated the prompt cache; handles didn't survive cells;
waiter-timeout contradictions; edge-triggered activity signals; root had no pump;
per-spawn mnemonic LLM cost; stumble double/under-counting; featherweight
resume/respawn; read-side redaction; `value_get` vs truncation; `$ref` silent
misses; `blocking: false` survival claim false; eval-only zero-tool path.

**Round 3 (2026-07-17, clean room):** reviewers received a sanitized spec with no
trace of prior review and no steering — run because round 2's "findings cluster in
revision-era text" was an artifact of round-2 instructions, not evidence of
soundness. 14 distinct findings, including two blockers in core mechanisms the
instructed rounds never examined: **no below-the-LLM ingestion path existed at
all** (every stored byte would have originated as LLM output tokens — fixed with
capture); the frozen spawn contract contradicted §9 on resolve-vs-reject (fixed
with the two-channel contract). Also: store tokens would have broadcast on the
open bus (fixed with the dedicated authenticated endpoint + bus-URL env
filtering); observer `env` was a cross-scope grant (prohibited); "all awaitables
are ambient" was unenforceable (budget clock redefined); recovery handles for
in-flight children were guaranteed dead (recoverable vs `died_with_owner`);
`handle.wait()` would have inherited the 900 s cap; `parse()` was unbounded; the
data-plane flag was undefined; `$ref` into `exec` was an
execute-unread-bytes channel (allowlist); the store worker was an unbudgeted
singleton (op budgets + wedge restart); featherweight logs needed three records;
timer suspension was asymmetric between arms — and today's tool-mode blocking
delegations already suffer spurious inactivity timeouts (second pre-existing bug,
now fixed in Phase 0).
