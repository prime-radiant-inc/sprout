# Sap: a data plane and REPL for sprout

**Date:** 2026-07-16
**Status:** Approved design, revised after four adversarial review rounds (§14), pre-implementation
**Scope:** Value store ("sap"), capture, splicing, publish, evaluator/REPL, code-first Act mode, genome programs

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
  model as `exec` on leaf agents today. Authority-bearing operations (store access,
  spawn requests, env grants) run over authenticated host channels (§3), but
  exec-capable agents share the OS user and can read journal/CAS files on disk, and
  the legacy bus inbox (steer/agent_message delivery) remains unauthenticated as
  today — the checks stop confused deputies, not a determined same-UID attacker.
- **Observer-granted cross-scope access.** Observers may mention values in messages,
  but mentioning never grants the recipient access outside its scope; observer
  messages cannot carry `env`, and observer store reads are scoped to what they
  observe (§3).
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
- **One cell worker per agent** (lazy-created on first cell, destroyed when the
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
surface. Below-the-line consumers — `$ref` splice into primitive args,
store-internal ops — get raw bytes. This is pattern-based redaction with the same
limits it has today (sliced reads can evade it, as `read_file` offset reads can
now); it prevents accidents, not exfiltration by a determined agent.

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
sha256, dedup for free), scope records (created at delegation; publish records at
result delivery), grant records (§3), and cell records (code, bindings created,
error, compute time). Resume replays journal *metadata* and lazy-loads bodies from
CAS. **Cells are never re-executed on resume; effects do not replay.**

**Transport.** Store and control traffic do **not** ride the session pub/sub bus.
The bus is open, unauthenticated fan-out (`src/bus/server.ts` — no auth, no topic
ACLs): authority-bearing messages on broadcast topics would let any connected client
forge them. Instead the host serves a dedicated endpoint; each agent process opens
one connection, authenticated at handshake with its per-handle token (§3), and the
host maps connection → verified identity thereafter. This **authenticated channel**
carries: store ops, capture uploads, env-grant registration (§3), cell submission
and results, cell spawn requests and responses (§4), liveness pings (§4), and wait
registration (§4). Large bodies still transfer by CAS handoff (producer writes the
CAS file, sends `{path, sha256}`; store verifies and adopts) above a frame budget
(default 4 MB); the endpoint sets an explicit max frame size (Bun's default
WebSocket cap is 16 MB — unstated, mid-size frames silently drop the connection).
The legacy bus keeps what it carries today — events, steer, agent_message,
start/continue/result — with its existing (unauthenticated) trust posture.

**Memory management.** The store worker holds hot values under a memory budget
(default 512 MB) with LRU spill to CAS; immutability makes spill/reload safe. Values
unreferenced by any live scope are spill-first. No within-session deletion in v1;
session end prunes everything.

**Lifetime.** Session-scoped. `/clear` drops the store with the rest of session state.

**Defaults (config-tunable):** preview budget 300 chars; auto-bind threshold 2,000
chars; result summary budget 4,000 chars; cell `get()`/`parse()` budget 1 MB;
`value_get` primitive budget 50,000 chars (read_file parity); store op timeout 10 s;
liveness ping interval 15 s; frame budget 4 MB; store memory budget 512 MB; max
value size 256 MB.

## 2. Capture, splicing, and publish

**Reference resolution is explicit and model-authored — never free-text.** Bindings
enter a recipient's scope through exactly two mechanisms, both structured fields the
model authors in its own tool calls, both validated against the *sender's* scope
(enforcement in §3):

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
(execute, address, navigate) must keep transiting the authoring model's context.
The allowlist is part of the frozen splice semantics.

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
exact anti-pattern the Motivation forbids.

**Capture stores source bytes, never rendered tool output.** The rendering a model
sees is not the content: `read_file` output is line-number-prefixed
(`src/kernel/execution-env.ts:124-129` — the codebase itself warns against reusing
it verbatim, `src/kernel/primitives.ts:11-12`), and `exec` output appends
`[stderr]`/`exit_code:`/`duration_ms:` trailers. Splicing a captured *rendering*
into `write_file` would write line numbers and exit codes into files — silent
corruption on the design's flagship path. So capture taps the environment layer:

- `read_file(path, bind:)` → the raw file bytes.
- `exec(cmd, bind:)` → raw stdout; nonempty stderr becomes a second value
  `<name>_stderr`. Exit code stays in the rendered result only.
- `grep(..., bind:)` → the raw match text; `fetch(url, bind:)` → the raw body.

Two capture triggers:

1. **Explicit `bind:`** on `read_file`, `exec`, `grep`, `fetch`. The full source
   content goes producer → store, raw, below the line; the rendered tool result
   above the line is preview + handle (plus today's inline rendering up to the
   truncation limits if the caller also wants to read it).
   `exec("bun test", bind: "test_log")` makes a 400 KB log `⟦test_log⟧` for ~5
   output tokens.
2. **Auto-capture on lossy truncation — either pass.** Today's truncation pipeline
   (`src/kernel/truncation.ts:100-118`) is two independent lossy passes: a char
   limit with a banner falsely claiming "the full output is available in the event
   stream," then a *line* limit (`exec` 256 lines, `grep` 200 — `truncation.ts:16-20`)
   with its own omission marker. A 20 KB, 5,000-line test log trips only the line
   pass. When **either** pass drops content, the full source content auto-binds and
   the marker becomes true and useful:
   `[... 4,700 lines truncated — full output: ⟦exec_bun_test_output⟧]`. Applies to
   all agents, leaves included: the leaf still sees today's inline rendering (no
   starvation), and nothing is lost anymore.

Capture is ingestion, so captured previews pass bind-time redaction (§1).

**Publish: how values cross the agent boundary upward.** Publishing is explicit,
distinct from binding, and exists in both modes:

- **Cells:** `publish(name)` (ambient API, §4) marks a bound value for the result
  manifest.
- **Tool mode:** capture primitives take `publish: true` alongside `bind:`
  (`exec("bun test", bind: "test_log", publish: true)`), and a `value_publish(name)`
  primitive covers values bound earlier.
- **Automatic:** the overflow of a child's `ResultMessage.output` beyond the summary
  budget auto-binds *and* auto-publishes — it *is* the result. Everything else —
  cell intermediates, un-published captures, locals — stays in the producing
  agent's scope. A 50-child fan-out does not flood the owner with every child's
  internal captures.

At result delivery, published values become the result manifest, which binds into
the scope of whoever receives the result (§3), and a publish record lands in the
journal. This is the entire child→parent data path; nothing else crosses upward.

**Auto-bind (upward, at agent boundaries).** A child's `ResultMessage.output` stays
inline up to the **summary budget** (default 4,000 chars — the judgment channel,
worth paying for); overflow auto-binds and auto-publishes. Published values arrive
as a manifest:

```
✓ engineer (brave_otter): "Implemented all 6 endpoints per the schema; two
  required new middleware, noted in ⟦impl_notes⟧."
  published: ⟦impl: 48KB ts, 14 exports⟧ ⟦impl_notes: 2KB md⟧
```

**Value-read primitives.** `value_peek`, `value_slice`, `value_lines`, `value_grep`,
`value_get` (and `value_publish`) are kernel primitives grantable through the
ordinary `tools` list — default-granted to delegating agents, implicitly granted to
any cell holder (§6), and grantable to any leaf whose work needs them. Tool-mode
agents can therefore always inspect what a manifest hands them; ingestion never
requires the evaluator. The reads are pure; the leaf discipline holds. **They bypass
the registry's `truncateToolOutput` layer** (`src/kernel/primitives.ts:72-83`): a
value-read is a precision instrument whose own budgets *are* the truncation policy.
`value_get` over its 50,000-char budget refuses with guidance to slice/grep — never
a silent middle-cut.

**Delegate tool changes.** `delegate` gains `env` and keeps its single-stable-tool
shape (prompt-cache decision preserved). `message_agent` and `ContinueMessage` gain
optional `env`. Respawn of a completed keep-alive handle goes through a fresh
`StartMessage` (`src/bus/spawner.ts:798-845`) — `StartMessage` gains `env` too, and a
respawned handle's scope rehydrates from the journal. `env` on a message to a
*running* target binds on receipt — gated by grant verification (§3).

**Spawnerless mode.** The in-process delegation path (no `AgentSpawner`: unit tests,
library embedding, `executeDelegation` at `src/agents/agent.ts:1038-1186`) gets a
local in-memory store implementation behind the same interface — `env`, `$ref`,
capture, publish, auto-bind, and value-read primitives all work. The evaluator
requires the spawner; in spawnerless mode cells are unavailable and `act: "code"`
degrades to `"tools"` (§6).

## 3. Scopes and authority

Each agent handle owns a scope; the scope tree mirrors the delegation tree.

- **No ambient ancestor visibility.** A child sees exactly what `env` handed it plus
  what it creates. A closure shares its parent's mind; a child agent is a different
  mind with its own context budget. Explicit `env` is goal+hints, typed.
- **Publish is explicit and upward** (§2). The manifest binds into the scope of
  whoever receives the result: the owner for a private handle; for a **shared**
  handle, each agent that waits on it binds the manifest into its own scope on
  receipt (values are immutable and ULID-identified, so multiple binds are aliases,
  not copies; per-scope name collisions take the numeric suffix).
- **Shared handles resolve through the host.** Handle tables today are per-spawner
  and per-process — every agent process builds its own child spawner
  (`src/bus/agent-process.ts:334`), and `waitAgent`/`messageAgent` throw
  `Unknown handle` for anything the local spawner didn't spawn
  (`src/bus/spawner.ts:649-651`). Cross-process shared-handle access therefore does
  not exist yet; the docs' access-rules table describes checks, not a resolution
  path. New machinery, scheduled in Phase 3: `shared` handles register with the
  **host handle registry** at spawn; local misses on wait/message fall back to a
  host lookup over the authenticated channel, and the host proxies the wait and
  delivers the manifest. Private handles stay purely local.
- **Siblings never collide.** They are wired together only by the parent (or by
  explicitly waiting on a shared handle).

**Scope knowledge lives in the message stream, not the system prompt.** When
bindings enter an agent's scope, the runtime appends a compact scope announcement to
history as a user-role message — the mechanism already used for steering and
new-agent announcements (`src/agents/agent.ts:2338-2345`). After **compaction**, the
runtime injects a fresh consolidated scope manifest as the first post-compaction
message, *emitted as a replayable event* (steering-class) so event replay — which
resets history to the summary on a compaction record
(`src/kernel/event-replay.ts:81-84`) — reconstructs it too. System-prompt placement
was considered and rejected: the system block sits in every provider's cache prefix
ahead of all history (`src/llm/anthropic.ts:187-208` — tools, then system, then
rolling history breakpoints), so a scope block there would invalidate the
conversation cache on every bind — the steady-state operation of this design.
Message-stream appends preserve the prefix; cached history stays cached.

**Identity: per-handle tokens on the authenticated channel.** The bus has no caller
identity (anonymous connections, open topics, self-reported addresses), so nothing
authority-bearing trusts it (§1 transport). At spawn, the spawner mints a
**per-handle secret token**, delivered in the subprocess environment alongside
`SPROUT_HANDLE_ID` (`src/bus/spawner.ts:539-548`). The token — and the host endpoint
URL, and `SPROUT_BUS_URL` — are filtered from `exec` child environments
(`src/kernel/execution-env.ts`; bus URL filtering is new — today exec children
inherit it, letting model-authored shell code speak raw bus protocol). The token
authenticates the process's host connection at handshake; identity is
per-connection thereafter, never per-message. Root and host facilities use an
in-process trusted path.

**Env grants are registered, not asserted.** `env` fields travel on bus messages
(`StartMessage`/`ContinueMessage`/`AgentMessageMessage`) whose senders are
self-reported — so the recipient's runtime never trusts the message alone. The
sender's process registers the grant over its **authenticated** connection before
sending (grant record: sender identity, recipient handle, names/ULIDs — journaled);
the recipient's runtime binds an `env` only if a matching pending grant exists,
verified with the store. A forged bus message with `env` finds no grant and binds
nothing. For delegations the spawner registers the grant as part of spawn (it is
the sender's runtime); `message_agent`/continue grants register before publish.

**Scope rules, on verified identity:**

- Ordinary agents read **their own scope only** (no ancestor chain).
- **Observers read the scopes they observe — not the whole store.** A session/root
  observer's remit is session-wide, so it reads session-wide. A **delegate**
  observer observes one owner's delegations; it reads the owner's scope and the
  observed children's scopes, nothing else. (Both kinds share the runtime
  `role: "observer"` today — `src/bus/spawner.ts:865-889` — so the registry records
  each observer's remit at spawn.) Observers never bind or publish, and
  **observer-role senders cannot attach `env`** — with whole-remit read and §2's
  sender-scope validation, an observer `env` would be a cross-scope grant, exactly
  what the non-goals forbid. Observation is deep inspection of what the frames
  already summarize, not a skeleton key.

Within the v1 trust model (non-goals), these checks stop confused deputies, not a
same-UID attacker reading journal files off disk.

## 4. The evaluator

Cells execute in the owning agent's cell worker (§1); value ops execute in the store
worker. Agents submit cells via the **`cell` kernel tool** — named to avoid
collision with the existing eval-mode evaluation harness (`evalMode`,
`src/kernel/primitives.ts:45`), which this design also uses in §6/§10; one word must
not mean both. Cell submission and results ride the authenticated channel (§1).

**Namespace contract — bindings only.** An agent's persistent namespace *is its
scope*: names bound via `bind()` (or received via `env`/manifests) persist across
cells and rehydrate from the journal on resume. **Plain JS locals die at cell end.**
This is what makes "cells are never re-executed" honest: rehydration is a journal
metadata replay, not a state reconstruction. The cell tool description and code-mode
guidance state this contract; referencing an unknown name returns an error listing
the names actually in scope.

**Handles are strings, and re-acquirable.** `spawn()` returns a handle object whose
`.id` is the spawner handle ID; the ambient `handle(id)` re-wraps any ID into a live
handle in a later cell (backed by the owner's spawner state, with host-registry
fallback for shared handles, §3). `handle(id).wait()` uses the **timer-less
blocking-wait path** (`src/bus/spawner.ts:620-637`) — *not* the `wait_agent` tool's
900 s waiter cap (`src/bus/spawner.ts:369`), which would spuriously fail exactly the
long-running survivors recovery exists for. The `wait_agent` *tool* keeps its cap;
the ambient API does not inherit it.

**Spawn routing — through the owner, over the authenticated channel.** `spawn()`
inside a cell does not touch the spawner directly, and its request/response
**never rides the open bus** — the bus inbox pump would let any client forge a
spawn request that executes with the owner's authority and allowlist, no model in
the loop (a stronger confused-deputy verb than today's forgeable `steer`). Instead
the host relays cell spawn requests to the owning agent's process over that
process's authenticated connection; responses (summary + manifest) return the same
way. In the owner's process the request executes through the existing
`executeSpawnerDelegation` (`src/agents/agent.ts:1504+`) — the process that owns the
delegation allowlist, delegate-observer config, verification, learn signals, and
resume state. The agent process services these requests while a `cell` call is
pending, during the initial run and in `idleLoop`. **Root:** root runs in-process in
the host with no subprocess; its cell spawn requests go through the
SessionController bridge — the same trusted path as root's agent messages
(`src/bus/spawner.ts:401-409`) — directly to the root `Agent` instance. Root's spawn
machinery is await-heavy I/O, not compute; cell *JS* still runs in root's cell
worker.

A handle spawned from a cell is indistinguishable from one spawned by a tool call —
`wait_agent`/`message_agent` on it work.

**The spawn contract** (the evaluator's central contract; genome programs will be
written against it):

- A blocking `spawn()` **resolves on child completion regardless of child success**:
  `{ok, summary, bindings, handle}` with `ok: false` for an unsuccessful child.
- It **rejects only on spawn-infrastructure failure**: unknown agent, allowlist
  denial, depth exceeded, spawn/transport failure, cancellation by the owner lease.
- Fan-out code therefore checks `ok` (`results.filter(r => !r.ok)`);
  `Promise.allSettled` is guidance for infrastructure robustness, not the primary
  failure channel. A cell that ends with unhandled `ok: false` results is not
  automatically an error; the model judges, exactly as a tool-mode parent judges a
  failed delegate tool result.

**Cell spawns deviate from tool-call delegation in five specified ways** (the
machinery was built for one-at-a-time tool calls; fan-out changes the economics):

1. **No mnemonic LLM call.** `executeSpawnerDelegation` awaits a model-generated
   mnemonic per delegation (`src/agents/agent.ts:1522-1533`) — concurrent across a
   fan-out but still ~50 owner-model completions per 50-way cell, plus a
   name-collision race (each call snapshots `usedMnemonicNames` before siblings
   finish). Cell spawns use deterministic names (goal slug + index). Tool-call
   delegations keep mnemonics.
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
   the cell tool result. If replay finds a `plan_end` whose pending `cell` tool_use
   has no recorded result (process died mid-cell), it synthesizes an error tool
   result that closes the transcript validly and **tells the truth about the
   children**: those with journaled results are listed as recoverable (their
   per-handle logs register at resume, `src/bus/resume.ts:199-213`); those still
   in flight **died with the owner** (child-spawner shutdown at
   `src/bus/agent-process.ts:486-491`; ppid monitoring at
   `src/bus/agent-process.ts:116-129`) and are listed as `died_with_owner` —
   re-spawn, don't wait. `handle(id)` on a dead ID returns a clean error making the
   same distinction.
4. **Learn signals are deduplicated, not just stumble counts.** Per-spawn learn
   signals (`src/agents/agent.ts:1661-1676`) are tagged with the cell ID; the
   cell-level verify signals only cell-authored errors (thrown code, budget kill),
   never a second signal for a child failure already signaled per-spawn.
5. **Typed outcome envelope.** `executeSpawnerDelegation` today *never rejects* —
   allowlist denial, depth, payload errors, and thrown spawn errors all become
   error tool-results (`src/agents/agent.ts:1548-1603, 1715-1730`), shaped around a
   `call_id` that cell spawns don't have. The function gains a structured outcome
   return (infrastructure-error | child-completion{ok, summary, bindings}) that the
   cell path consumes directly and the tool path renders into tool-results as
   today. This is how the spawn contract's reject-vs-resolve distinction is
   actually delivered; without it the contract was unimplementable through this
   code path.

**Stumble accounting — counted once, attributed to the owner.** Per-spawn verify
results fold into the cell result as counts; the `cell` primitive's verify
contributes `(failed-child count) + (1 if the cell itself errored for a non-child
reason)` to the owner's run counters. This requires extending the tool-result path
to carry a count (today it contributes at most 1 boolean per result,
`src/agents/agent.ts:2250-2252`) — a stated change, not silent reuse. Child agents'
own internal stumbles remain their own, as today.

The ambient surface (kernel API; Learn cannot mutate it — genome programs appear
under the `programs.*` namespace, which is genome content, not kernel):

```js
spawn(agent, goal, {env, hints, blocking, shared, model})
  // blocking (default) → resolves {ok, summary, bindings, handle} on completion;
  //                      rejects only on spawn-infrastructure failure
  // blocking: false    → resolves immediately to {handle}
handle(id)                              // re-acquire a live handle in a later cell
  // handle.id, handle.wait() [timer-less], handle.message(text, {env})
bind(name, value)                       // deliberate, model-named; the only persistence
publish(name)                           // mark a bound value for the result manifest
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
JSON → refuse with guidance (grep/slice first, or delegate).

**Cell results to the LLM:** captured stdout + final expression value (auto-bound if
over threshold) + manifest of new bindings + on error, message, offending line, the
names currently in scope, and the handle IDs of spawns still in flight.

**Budgets, guards, and cancellation:**

- **The budget clock runs on wall time not parked on ambient-API awaits.** A cell
  is "parked" only while awaiting an ambient-API promise (spawn, store op, handle
  wait). Model-written code *can* construct other promises (`await new
  Promise(() => {})`, async deadlocks); the premise "all awaitables are ambient" is
  unenforceable, so the budget doesn't rest on it: time spent neither executing nor
  ambient-parked accrues against the budget (default 5 s) exactly like a runaway
  loop. Sync loops, catastrophic regexes, and phantom awaits all die by the same
  clock; legitimate long child-waits are ambient parks and never accrue.
- **The cell's lease is the owner's `cell` call.** If the owning agent is
  interrupted, times out, or its process dies, the host cancels the cell; the
  cell's blocking children — ordinary delegations *of the owner* via spawn routing —
  follow the owner's existing abort/kill semantics.
- **Detached (`blocking: false`) children live exactly as long as their owner's
  process — as today.** "Detach" means *outlive the cell*, not *outlive the owner*.
  Work that must outlive a mid-tree agent belongs in a `shared` handle owned higher
  in the tree.
- **Owner inactivity timer: suspended while a blocking child or a cell is pending —
  both arms — with liveness pings as the net.** The owner's `timeout_ms` is a
  wall-clock inactivity timer (`src/agents/agent.ts:2304-2308`) reset only after
  planning and after a tool batch (`agent.ts:2407, 2485`) — meaning **today**, a
  single blocking tool-call delegation outliving `timeout_ms` (default 300 s)
  already marks the owner timed-out and stumbled even when the child succeeds: a
  pre-existing latent bug, and an arm-asymmetry confound for §10 if only code mode
  escaped it. Fix (Phase 0 timer + Phase 1 pings): the timer suspends while
  awaiting a blocking delegation or pending cell, and **liveness pings** — a new
  mechanism, not an existing one — keep it suspended. Every agent process pings the
  host over its authenticated connection every 15 s (a wedged event loop stops
  pinging — its own `setTimeout`s can't fire — which is what makes this a real
  net); cell workers ping for cells. The host relays liveness to whoever is
  suspended on that party; missing pings resume the waiter's timer, which then
  times out normally. Root and featherweight runs use in-process liveness.
- **Deadlock detection: the host owns the wait graph.** With waiter caps removed
  (timer-less ambient waits), cycles would otherwise hang forever with every party
  alive and pinging: A's cell waits B's shared handle while B's cell waits A's.
  Every ambient blocking wait (spawn wait, `handle.wait`) registers start/end with
  the host over the authenticated channel; the host maintains the session wait
  graph, detects cycles, and fails the youngest wait in a cycle with an explicit
  deadlock error naming the cycle. Tool-path waits (`wait_agent`) keep their 900 s
  cap and need no registration.
- Spawn cap per cell (default 64, tunable); `MAX_AGENT_DEPTH` applies inside cells
  (enforced by `executeSpawnerDelegation`, since spawns route through it).
- Cells are serialized per agent; concurrency happens inside a cell.
- No bare `llm()` function — that would be a second recursion mechanism (see §5).

**Tool surface rules:** `cell` is granted to agents with `can_spawn: true`;
tool-mode agents may also be granted it explicitly. Granting `cell` implicitly
grants the value-read primitives (§6). Leaves stay pure tool-callers — `$ref` args,
capture, publish, and value-read primitives cover them. Reserved-name checks extend
to `cell`, the `value_*` primitives, and the ambient names.

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
   natural completion. Fixed first, with its own tests.
2. **Zero-tool completion agents.** The run loop rejects agents with no tools
   (`src/agents/agent.ts:411-423`, `1939-1950`; only observer-tagged specs are
   exempt). The exemption extends to specs with `tools: []` and `max_turns: 1` — a
   pure completion agent that cannot hallucinate tool calls into anything.

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
  (`src/bus/resume.ts:104-181`), while respawn-with-history rebuilds the
  conversation from `perceive`/`plan_end`-class events
  (`src/kernel/event-replay.ts:55-90`) — a follow-up `message_agent` ("refine your
  answer") must arrive with the original request *and response* in history, as the
  tool description promises.
- No idle loop, no keep-alive. Crash isolation genuinely differs; that is the trade,
  and why the rule is restricted to single-turn no-tool agents.

## 6. Code-first Act mode

Agent specs gain `act: "code" | "tools"` (default `tools` — today's behavior,
untouched). A code-mode agent's Plan emits one `cell` tool call per Act; the cell is
the plan. Tool-mode agents keep `delegate` and may also hold `cell`. Both modes are
one stable tool call per provider (Anthropic/OpenAI/Gemini), preserving the
cache-stability decision.

**The data-plane session flag, defined.** Off means *off*: no store service, no
tokens, no capture, no publish, no splicing, no auto-bind, no scope announcements,
no cells — the control arm is a true baseline for every §10 metric. `value_*` and
`cell` filter out of the registry in off-sessions; `act: "code"` degrades to
`"tools"`.

**No zero-tool path — enforced at mutation time, not patched at runtime.** Genome
validation rejects any spec whose **functional tool set is empty under flag-off
filtering** — i.e., after removing `cell` and all `value_*` grants, the spec must
retain `can_spawn: true` or at least one real tool, or satisfy the `max_turns: 1`
completion exemption (§5). This covers the eval-only shape *and* the
`value_*`-only shape (a plausible evolved log-inspector leaf), either of which
would otherwise hard-throw the zero-tool error in every control-arm session
(`src/agents/agent.ts:1939-1950`) and pollute the §10 baseline. Validation runs at
creation and mutation (`markdown-loader` + genome gates), where quartermaster
products are already checked. The genome is shared across sessions; a spec evolved
for the data plane must keep working in every session.

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
- **Sync plumbing:** the genome directory list, bootstrap manifest, `syncRoot`, and
  `exportLearnings` (`src/genome/`) have no `programs/` entry today; each extends so
  evolved programs can be promoted to root through the existing staged-review flow.
- **The immutability line:** store, capture, splice, publish, scope, and cell
  semantics (including the ambient API and the `$ref` allowlist) are kernel — Learn
  cannot touch them. Programs are genome — fully evolvable. The kernel list in
  `docs/architecture.md` grows accordingly.

This is a skill library where the skills are orchestrations of agents, under
selection by stumble rate.

## 8. Events and surfaces

New event kinds:

- `value_bind` — name, size, type, preview, provenance, published flag.
- `cell_start` / `cell_end` — code, duration, compute time, bindings created, error,
  in-flight handle IDs.

Spawns inside cells emit the existing delegation events with `cell_spawn: true`;
history replay skips them (§4), all other consumers (TUI, observers, learn) see them
unchanged. Events carry previews instead of raw content — observer frames get
cheaper, and observers use their scoped store read (§3) when a frame's preview
warrants deep inspection. Metacognitive observers gain strictly better signal —
dataflow topology ("root re-peeked ⟦test_log⟧ four times; suggest binding the grep
result"; "two siblings each re-parsed the same JSON — this wants to be a program").

TUI: handles render as dim inline `⟦name: 48KB⟧`. Web: preview on hover.

## 9. Failure handling

- Cell errors are tool-result errors (message, line, names in scope, in-flight
  handle IDs) — they flow through the verify → stumble → learn-signal pipeline with
  §4's counting and dedup rules. Model-written cells will stumble early; that is
  the fitness function eating.
- Child failure is **not** a cell error: blocking spawns resolve `{ok: false}` (§4
  spawn contract); the model judges. Spawn-infrastructure failures reject;
  unhandled rejections fail the cell with an error naming the failed spawn and
  surviving handle IDs, and the next cell recovers via `handle(id)`.
- Deadlock cycles fail the youngest wait with an explicit error naming the cycle
  (§4); the failed cell's owner replans with that information.
- Store misses list the names available in the caller's scope; `$ref` misses are
  tool errors (§2); env binds without a registered grant are dropped with a warning
  event (§3); store op timeouts fail the op, not the worker; a wedged store worker
  restarts from journal+CAS with in-flight ops failing retryably.
- `get()`/`parse()`/`value_get` over budget refuse with guidance to slice/grep.
- Cell-worker termination (budget overrun) fails that agent's running cell as a
  tool-result error; journaled bindings survive; the worker respawns before the
  agent's next cell. Other agents' cells, in their own workers, are untouched.
- After owner death mid-cell, resume distinguishes recoverable children (journaled
  results) from `died_with_owner` (§4); the synthesized cell error carries both
  lists.

## 10. Instrumentation and metrics

All-in must not mean unattributable:

- `act` mode is per-spec; the data plane is a per-session flag (§6, with defined
  off-semantics) — eval-mode can A/B against a true baseline.
- Timer semantics are identical across arms (§4) so stumble-rate differences
  measure orchestration, not timer policy.
- Metrics: tokens per delegated byte moved; stumble rate by act mode; fan-out
  wall-clock; store hit sizes; prompt-cache hit rate by arm (the
  scope-announcement design (§3) exists to protect it; measure that it does).
- Success criterion for the canonical scenario ("author a 50 KB file via children"):
  ≥ 80% token reduction versus baseline, no resume/replay regressions.

## 11. Testing

- **Unit:** store bind/scope/journal/rehydrate; capture at the environment layer
  (raw file bytes — never line-numbered renderings; raw stdout with `_stderr`
  sibling; splice-back byte-for-byte fidelity); auto-capture on **both** truncation
  passes (char and line) with truthful markers; publish (`publish()`,
  `publish: true`, `value_publish`, auto-publish of result overflow — and
  *non*-publish of unmarked captures); `$ref` whole-arg resolution, loud-miss
  errors, and the per-primitive allowlist; free-text inertness; preview
  determinism; redaction of previews and value-reads; value-read truncation bypass
  and `value_get` refusal; `parse()`/`get()` budgets; store op timeouts, chunked
  grep abort, wedge restart; sandbox surface; budget clock accrual on non-ambient
  awaits; per-agent cell-worker terminate/respawn isolation; auto-bind thresholds
  and summary budget; naming collisions; deterministic cell-spawn names;
  scope-announcement rendering, post-compaction manifest, and its replayable
  event; `hitTurnLimit` fix; timer suspension + liveness-ping resume (wedged
  process stops pinging → waiter timer resumes); wait-graph cycle detection;
  zero-tool exemption and flag-off-empty genome validation (eval-only *and*
  value_*-only shapes rejected); grant registration (env without grant drops;
  forged bus env binds nothing; observer env rejected); CAS handoff; LRU
  spill/reload; store handshake auth; env filtering (token, endpoint URL, bus URL).
- **Integration:** env-grant round-trips (delegate, message, continue, respawn
  StartMessage); auto-bind + auto-publish of oversized child results;
  shared-handle host-registry resolution and manifest binding into multiple
  cross-process waiters; cell spawn routing over the authenticated channel through
  all owner paths (initial run, idleLoop, root bridge) with allowlist enforcement,
  the typed outcome envelope, stumble counting, and learn-signal dedup; spawn
  contract semantics; owner interrupt/timeout cancelling a pending cell; a
  10-minute single-child await surviving under suspended timers in both act modes;
  a two-agent wait cycle failing fast with a deadlock error; resume of an owner
  whose cell spawned children (provider-valid replay; recoverable vs
  `died_with_owner`; `handle(id)` behavior on each); fan-out via `Promise.all`
  with `ok`-checking; bindings-only rehydration; spawnerless local store parity;
  featherweight three-record log surviving resume and respawn-with-history;
  per-spawn model override incl. respawn; program load precedence and root
  promotion. Keystone assertion: a leaf captures a source file raw, publishes it,
  and the parent splices it via `$ref` into `write_file` — verified byte-identical
  output *and*, from recorded provider requests, that the content bytes appear in
  **no LLM payload anywhere in the tree**.
- **E2E (eval mode, real models, no mocks):** the canonical 50 KB scenario with
  before/after token measurement; a 50-way llm-call fan-out asserting zero spurious
  failures; an `exec`-captured 400 KB log grepped and diagnosed without the log
  transiting any LLM; prompt-cache hit-rate comparison across arms; stumble-rate
  tracking per act mode.

## 12. Build order

One design, sequenced by dependency; each phase lands green before the next starts:

0. **Kernel prerequisites** — `hitTurnLimit` fix; zero-tool completion agents;
   inactivity timer made pausable and suspended during blocking delegations
   (pre-existing spurious-timeout bug).
1. **Store + channel** — authenticated host endpoint (tokens, env filtering incl.
   bus URL, liveness pings feeding the Phase 0 timer), store worker (op budgets,
   wedge restart), journal, previews + redaction, CAS transport/spill, **capture at
   the environment layer** (`bind:` args + auto-capture on both truncation passes),
   **publish** (primitive flags + `value_publish` + auto-publish), auto-bind at
   agent boundaries, `value_bind` events, value-read primitives, scope
   announcements + post-compaction manifest event.
2. **Splice + grants** — `$ref` whole-arg resolution with loud-miss errors and the
   per-primitive allowlist, env-grant registration protocol, `env` on
   delegate/message/continue/StartMessage (observer-env prohibition), result
   manifests + summary budget, spawnerless local store.
3. **Evaluator** — per-agent cell workers, `cell` tool over the authenticated
   channel, ambient API incl. `handle(id)` and `publish()`, spawn routing (owner
   relay + root bridge) with the five cell-spawn deviations, stumble counting +
   learn dedup, budget clock, cancellation lease, wait registration + cycle
   detection, **host handle registry for shared handles**, featherweight placement
   + three-record logs, `utility/llm-call`.
4. **Code-first** — `act` spec field + flag semantics + flag-off-empty genome
   validation, cell-implies-value-reads, scoped observer store access, TUI/web
   rendering.
5. **Programs** — genome artifact type + sync/export plumbing, quartermaster
   fabrication, eval-mode gating, metrics dashboards.

## 13. Design decisions log

| Decision | Choice | Why |
|---|---|---|
| REPL role | Orchestration surface + RLM data ops; full RLM deferred | Sprout's pain is inter-agent transport, not single-context rot |
| Surface language | JS cells via one `cell` tool; handles work with zero JS | Data structure at the core; JS as the wiring power-up ("cell", not "eval": the eval-mode harness already owns that word) |
| Topology | One store worker + per-agent cell workers; agent loops stay subprocesses | Code moves to data; budget kills are surgical; store ops get their own budgets and wedge-restart |
| Ingestion | Capture at the environment layer (raw bytes) via `bind:` + auto-capture on either lossy pass | Rendered tool output (line numbers, exit codes) spliced into files is silent corruption; char-only triggering misses line-truncated logs |
| Child→parent flow | Explicit publish (`publish()`/`publish: true`/`value_publish`) + auto-publish of result overflow | Without a publish verb the central data flow was undecidable: all-binds-publish floods scopes; no-publish strands leaf captures |
| Control plane | Authenticated host channel for store ops, grants, cell spawns, pings, waits; open bus keeps only today's traffic | Anything authority-bearing on the open bus is forgeable; env grants are registered by the sender's verified connection, never trusted from messages |
| Shared handles | Host handle registry; local-miss fallback over the authenticated channel | Handle tables are per-process today — cross-process shared waiting doesn't exist; the spec must build it, not assume it |
| Spawn contract | Resolve `{ok:false}` on child failure; reject only on infrastructure; delivered via a typed outcome envelope (deviation 5) | `executeSpawnerDelegation` never rejects today — the contract needed a delivery mechanism, not an assertion |
| Namespace persistence | Bindings only; locals die at cell end; `handle(id)` re-acquires (timer-less waits) | Never-re-execute resume, without stranding children or inheriting the 900 s cap |
| Reference semantics | Explicit env/$ref only; free-text inert; loud misses; content-only `$ref` allowlist | Untrusted content must never mint bindings; executed/addressed args must transit the authoring model |
| Scope knowledge | Message-stream announcements + replayable post-compaction manifest | System-prompt placement would invalidate the conversation cache on every bind |
| Budget clock | Wall time not parked on ambient awaits | "All awaitables are ambient" is unenforceable; phantom awaits die by the same clock as loops |
| Timers & liveness | Suspension during blocking waits (both arms) + 15 s liveness pings + host wait-graph cycle detection | Suspension without a net hangs on wedged-but-alive processes; timer-less waits without cycle detection deadlock forever |
| Observers | Read scoped to observed remit; no env; no bind/publish | Whole-store read exceeded (not mirrored) event visibility and over-granted delegate observers; content exfiltration ≠ handle granting |
| Sub-LM calls | `utility/llm-call` genome agent, not a kernel `llm()` | One recursion mechanism; evolvable |
| Featherweight | Owner-process placement; synthetic three-record log | wait_agent resolves against the owner's spawner; resume needs session_end, respawn needs perceive+plan_end |
| Mode choice | `act` per spec; defined off-flag; flag-off-empty specs invalid at mutation time | Don't decide, evolve — with a true control arm and no zero-tool path in any shape |

## 14. Adversarial review log

**Round 1 (2026-07-16, first committed draft):** 21 distinct findings. Evaluator
placement, delegation-machinery reachability, auto-bind starvation, rehydration
contradiction, payload `$ref`, free-text injection, `max_turns: 1`/`tools: []`
kernel rejections (first pre-existing bug), redaction, frame caps, GC, spawnerless
mode, featherweight equivalence, flag coherence.

**Round 2 (2026-07-17, reviewers directed at revision-era text):** 16 distinct
findings, mostly breaking round-1 fixes: replay corruption from owner-routed spawn
events; fictional "spawner-verified" identity; single-worker blast radius;
system-prompt scope block vs prompt cache; handles not surviving cells; waiter-cap
contradictions; root's missing pump; per-spawn mnemonic cost; stumble
double/under-counting; featherweight resume; read-side redaction; `value_get` vs
truncation; `$ref` silent misses; `blocking: false` survival claim.

**Round 3 (2026-07-17, clean room — sanitized spec, no steering):** 14 distinct
findings, including two core blockers the instructed rounds missed: **no
below-the-LLM ingestion path existed** (→ capture) and the spawn contract
contradicted §9 (→ two-channel contract). Also: store tokens on the open bus (→
authenticated endpoint), observer env grants, unenforceable park premise (→ budget
clock), dead recovery handles, `handle.wait` cap, `parse()` budget, undefined
flag, `$ref`-into-exec, store-worker budgets, three-record featherweight logs,
timer asymmetry — surfacing the second pre-existing bug (tool-mode blocking
delegations already suffer spurious inactivity timeouts).

**Round 4 (2026-07-17, clean room again):** 11 distinct findings, concentrated in
protocol seams: **publish had no mechanism** (→ §2 publish design); **the control
plane rode the unauthenticated bus** the spec itself had just hardened against (→
authenticated channel carries grants/spawns/cells; grant registration); **shared
handles had no cross-process resolution in the existing code** (→ host handle
registry); capture stored rendered output, not source bytes (→ environment-layer
capture); the line-truncation pass escaped auto-capture (→ either-pass trigger);
liveness heartbeats were asserted but never designed (→ ping protocol); timer-less
waits + suspended timers could deadlock in cycles (→ host wait graph); the spawn
contract was undeliverable through a function that never rejects (→ typed outcome
envelope, deviation 5); flag-off validation missed `value_*`-only specs (→
functional-emptiness rule); observer whole-store read over-granted (→ remit-scoped
read); `eval`-the-tool collided with eval-mode-the-harness (→ renamed `cell`).
