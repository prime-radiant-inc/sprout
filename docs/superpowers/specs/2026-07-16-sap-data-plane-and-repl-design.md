# Sap: a data plane and REPL for sprout

**Date:** 2026-07-16
**Status:** Approved design, revised after six adversarial review rounds and a roborev design review (§14), pre-implementation
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

**Cell workers are OS subprocesses, not threads.** Plain JS needs no ambient API
to allocate (`let s = "x"; while (true) s += s;` reaches gigabytes in under a
second), and a thread-worker OOM would abort the entire host — bus, UI, store,
every session. As subprocesses, a memory blowout kills only that agent's cell
worker. **Memory enforcement is an RSS watchdog, not an rlimit**: the host polls
each cell worker's RSS (every 250 ms) and kills over-budget workers (default
512 MB). This is specified deliberately — RLIMIT_AS is not enforced on macOS
(setrlimit succeeds and XNU ignores it; JSC's mmap'd heap escapes RLIMIT_DATA),
`Bun.spawn` exposes no rlimit API, and this project develops and runs on darwin.
On Linux, a setrlimit-exec shim adds a hard backstop; on darwin the watchdog is
the mechanism, and a fast allocation bomb can transiently exceed the budget by
the polling interval's worth of growth — bounded imprecision, stated rather than
hidden. The store worker may be a thread (it runs no model-authored code and its
allocations are quota-bounded); cell workers may not. This is what makes budget
enforcement surgical: killing a runaway cell kills *only that agent's* cell worker
(§4, §9) — never another agent's in-flight cell, never the store, never the
bus/UI/spawner.

**Store ops are budgeted too — and the contract is honest about JS regex.** The
store worker runs model-influenced work (grep patterns are model-written; JS regexes
can backtrack catastrophically). `value_grep` executes chunk-at-a-time with an abort
check between chunks, and every store op carries an op timeout (default 10 s). The
timeout is checked *between* chunks — a single chunk's regex application is
uninterruptible JS, so the enforceable contract is: ops that exceed budget between
chunks fail cleanly; an op wedged *inside* one application is recovered by **worker
termination and restart**, which is a first-class recovery path, not an edge case.
Chunks are line-bounded (regexes apply per line-run, never across a chunk seam)
with a byte cap (default 1 MB) as the fallback for pathological single-line
values, which do occur (`src/kernel/truncation.ts:36-37` handles them today).
The worker holds no unjournaled state — values live in the journal and CAS — so
restart is reload; in-flight ops fail with retryable errors. Implementers must build
to the weaker guarantee (timeout-or-restart), never assume regex is interruptible.
Cell budget enforcement never touches the store worker; wedge recovery may.

**Value model.** Values are utf8 text, JSON, or bytes. Metadata: ULID, name, scope,
type, size, provenance (producing agent handle, cell or delegation, primitive and
args), and a deterministic preview. Values are **immutable once bound** — rebinding a
name creates a new version; a name resolved in a scope pins a version. Immutability
makes previews cacheable, concurrent children race-free, the journal trustworthy, and
spill/restart trivial.

**Previews** (~300 chars, computed once at bind, stable forever): type, size, line
count, head/tail excerpt; for JSON, top-level shape (keys, array lengths) — but
shape analysis requires a parse, so it applies only to JSON values under a
preview-parse budget (default 10 MB); larger JSON previews fall back to head/tail
excerpt with `json (unparsed)` noted. Binding a 200 MB JSON value must not cost a
200 MB parse.

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
3. **Auto-bind collisions take a numeric suffix; explicit names never do.** A
   `bind()`/`bind:` name or an `env` alias that collides with an existing name in
   the target scope fails loudly (for `env`, at grant registration, reported to
   the sender) — silently renaming a granted `schema` to `schema_2` would break
   every `⟦schema⟧` reference the granting model wrote. Suffixing is reserved for
   auto-binds, whose names no model has referenced yet. Global identity is the
   ULID; names are per-scope.
4. **Names are validated data, never code.** Charset `[a-z0-9_]`, max 64 chars, no
   leading digit; reserved names (ambient API names, `programs`, kernel primitive
   names) rejected. Names are string keys — `peek('x')` — and are **never injected
   as JS identifiers into cell namespaces**: arbitrary names can't be identifiers,
   and globals would collide with the ambient API. The namespace "is the scope" in
   the addressing sense, not the global-variable sense.

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
carries: **handle registration** (§3 — the identity bootstrap: a spawner registers
each child's handle ID, token hash, owner, depth, and observer remit with the host
*before* launching it; without this the host could never validate a mid-tree
handle's handshake, since spawners are per-process and the host is not in the
grandchild spawn path — the host rejects duplicate registrations and registrations
from any identity other than the verified parent, else an authenticated agent
could re-register another agent's handle and capture its identity — with one
carve-out: **the verified parent of a handle may re-register it with a fresh
token** when the handle has no live connection, which is how respawn and
owner-resume re-establish identity: tokens are never journaled, so a resumed
parent cannot redeliver the original token and must mint anew; a handle with an
active authenticated connection can be re-registered by no one), store ops,
capture uploads, publish records, **manifest fetch** (§2), env-grant registration
(§3), cell submission and results, cell spawn requests and responses (§4),
liveness pings (§4), and blocking-wait registration (§4). **This channel and
everything on it is control-plane infrastructure, independent of the data-plane
flag (§6)**: tokens, pings, wait registration, and deadlock detection exist in
every session including flag-off control arms — otherwise the timer-suspension
net would vanish in exactly one arm, either hanging it (suspension without pings)
or resurrecting the spurious-timeout bug there (no suspension), and the §10
"identical timer semantics across arms" requirement would be false by
construction. Large bodies still transfer by CAS handoff above a frame
budget (default 4 MB); the endpoint sets an explicit max frame size (Bun's default
WebSocket cap is 16 MB — unstated, mid-size frames silently drop the connection).
**CAS handoff is confined:** producers write only into a host-created per-session
staging directory (path issued to the process at spawn), and the store adopts files
only from that directory — path canonicalized, symlinks rejected, size checked
against the max-value limit *before* adoption. Arbitrary `{path}` adoption would
let a confused producer make the store ingest any readable file on disk.
The legacy bus keeps what it carries today — events, steer, agent_message,
start/continue/result — with its existing (unauthenticated) trust posture.

**Memory and disk management.** The store worker holds hot values under a memory
budget (default 512 MB) with LRU spill to CAS; immutability makes spill/reload
safe. Values unreferenced by any live scope are spill-first. Disk is bounded too:
a per-session store disk quota (default 4 GB, journal + CAS combined) and a
per-scope value-count cap (default 10,000). At quota, new binds fail with an
explicit store-full error (a stumble the owner can react to — e.g., delegate
summarization); the session keeps running. No within-session deletion in v1;
session end prunes everything.

**Lifetime.** Session-scoped. `/clear` drops the store with the rest of session state.

**Defaults (config-tunable):** preview budget 300 chars; auto-bind threshold 2,000
chars; result summary budget 4,000 chars; cell `get()`/`parse()` budget 1 MB;
`value_get` primitive budget 50,000 chars (read_file parity); store op timeout 10 s;
liveness ping interval 15 s; frame budget 4 MB; store memory budget 512 MB; store
disk quota 4 GB; per-scope value cap 10,000; max value size 256 MB; name length 64.

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

**`$ref` is accepted only in pure-content arguments — a kernel allowlist.**
`write_file` content and `edit_file` old/new strings: yes. `exec` commands,
`fetch` URLs, file paths, grep patterns: no — and **`apply_patch` bodies: no**,
because a patch body is not pure content: it *addresses* (file paths) and *acts*
(`*** Delete File`, `*** Move to`), and today's path-constraint enforcement
parses those paths out of the raw model-authored argument *before* execution
(`src/agents/agent.ts:2204-2225` → `src/kernel/path-constraints.ts:40-51`) — a
spliced patch would present zero paths to the check and bypass
`allowed_write_paths` entirely. The one rule guarantees no model sees spliced
content — which is exactly why arguments that do things must keep transiting the
authoring model's context. **Belt and braces: for any primitive call that
resolved a `$ref`, path constraints re-run on the resolved arguments** after
splicing, so a future allowlist mistake fails closed instead of open. The
allowlist and the re-check rule are part of the frozen splice semantics.

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
corruption on the design's flagship path. **For `read_file` and `grep` this
requires new interface surface**: the line numbering happens inside
`ExecutionEnvironment.read_file` itself (`src/kernel/execution-env.ts:124-129`),
and `grep` shells out to `rg --line-number` returning `path:line:text` — raw
match text does not exist in the current interface. (`exec` already returns
structured `{stdout, stderr, exit_code}` — `ExecResult`,
`src/kernel/execution-env.ts:6-12` — with the trailer rendering applied in the
primitive; its capture needs no interface change.) The affected implementations
gain structured-result methods (raw content + rendering), and capture consumes
the structured form:

- `read_file(path, bind:)` → the raw bytes of exactly what was read (with
  `offset`/`limit`, the requested slice, not the whole file).
- `exec(cmd, bind:)` → raw stdout; nonempty stderr becomes a second value
  `<name>_stderr`. Exit code stays in the rendered result only.
- `grep(..., bind:)` → a JSON value of structured matches
  `[{path, line, text}, ...]` — grep results are inherently structured; storing
  them as such makes them `parse()`-able instead of a rendering to re-parse.
- `fetch(url, bind:)` → the raw body.

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
   `[... 4,700 lines truncated — full output: ⟦exec_bun_test_output⟧]` (for exec,
   the marker names both values when stdout and stderr were both cut). Applies to
   all agents, leaves included: the leaf still sees today's inline rendering (no
   starvation), and nothing is lost anymore.

**Store-full degrades to today's semantics, never worse.** §1's store-full error
covers deliberate binds, where the owner can react. The two *automatic* paths get
explicit fallbacks: if auto-capture can't bind at quota, the truncation marker
reverts to a lossy-but-honest form (`[... 4,700 lines truncated; store full —
content not captured]` — never a marker naming a value that doesn't exist); if a
child's result-overflow auto-publish fails at quota, the child's `ResultMessage`
falls back to today's inline truncation (30,000 chars, `src/kernel/truncation.ts:105`)
instead of the 4,000-char summary — degraded to the status quo, never silent loss
of the primary result channel.

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

**Manifests are pulled from the store, never pushed on the bus — and delimited
per result.** Publish records land in the journal via the *child's* authenticated
connection at publish time. At result receipt, the recipient's runtime
**fetches** the manifest from the store over its *own* authenticated connection —
and the fetch is a **delta**: the publishes of that handle since its previous
result delivery to *this recipient* (the store keeps a delivery cursor per
handle × recipient). Keep-alive handles produce a result per continue and shared
handles are waited by different agents at different times; a cumulative fetch
would re-deliver every earlier run's publishes on each receipt, spuriously
tripping collision suffixing for values the recipient already holds. Two
same-handle name rules: a manifest name that matches a binding from *the same
handle's earlier manifest* is a **version update** (the alias moves to the new
ULID — the child rebound and republished; no suffix); a match against any
*other* binding is a genuine collision and suffixes per §3. If the manifest
fetch fails retryably (store worker mid-restart), result processing waits and
retries under ping-backed liveness before delivering the tool result. The bus `ResultMessage` carries no manifest and no overflow content (the
child's runtime publishes overflow to the store *before* sending the result;
`output` carries only the inline summary). This matters because result topics are
open bus (`src/bus/spawner.ts:501-518`): a manifest field on the message would let
a forged result mint cross-scope bindings from arbitrary ULIDs — the
confused-deputy class env-grant registration exists to stop. Pulled manifests make
forgery no stronger than today: a forged result can spoof *text*, never *data
access*. This is the entire child→parent data path; nothing else crosses upward.

**Auto-bind (upward, at agent boundaries).** A child's `ResultMessage.output` stays
inline up to the **summary budget** (default 4,000 chars — the judgment channel,
worth paying for); over budget, the inline portion is the head of the output
(mechanical cut, marked as such) and the auto-bound, auto-published value is the
**full output** — a clipped remainder would be useless to splice. Child system
prompts are guided to lead with judgment so the head *is* the summary. One
exception path: results recovered from a dead child's durable log
(`src/bus/spawner.ts:263-296`) predate publish-before-result ordering and fall
back to today's 30 K inline truncation — the degraded-to-status-quo rule, stated. Published values arrive
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
optional `env`. The existing `task_payload` channel
(`src/agents/delegation-payload.ts` — inline JSON rendered into the child's goal,
64 KiB cap) is unchanged and **superseded by `env`** for new specs: it has no
below-the-LLM consumer, so it gets no `$ref` integration; existing
`task_payload: true` specs keep working untouched; no migration machinery. Respawn of a completed keep-alive handle goes through a fresh
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
  not copies). **Manifest name collisions are the one place explicit names must
  suffix** — the child that chose the name has already completed, so the loud
  failure §1 mandates for explicit names has no one to fail to. The mitigation:
  when a manifest name suffixes (`impl_notes` → `impl_notes_2`), the runtime
  rewrites every `⟦impl_notes⟧` occurrence in that child's *delivered summary
  text* to the suffixed name before it reaches the recipient. Without this, a
  child's "noted in ⟦impl_notes⟧" would resolve against a pre-existing value in
  the recipient's scope — silent wrong-value misdirection on the flagship path,
  systematic in fan-outs where same-type children publish conventional names
  (`result`, `patch`, `notes`).
- **Shared handles resolve through the host.** Handle tables today are per-spawner
  and per-process — every agent process builds its own child spawner
  (`src/bus/agent-process.ts:334`), and `waitAgent`/`messageAgent` throw
  `Unknown handle` for anything the local spawner didn't spawn
  (`src/bus/spawner.ts:649-651`). Cross-process shared-handle access therefore does
  not exist yet; the docs' access-rules table describes checks, not a resolution
  path. New machinery, scheduled in **Phase 5 (Evaluator)** with the rest of the
  handle machinery — until it lands, cross-process shared-handle access errors
  explicitly as unsupported: `shared` handles register with the
  **host handle registry** at spawn; local misses on wait/message fall back to a
  host lookup over the authenticated channel, and the host proxies the wait and
  delivers the manifest. Private handles stay purely local.
- **Siblings never collide.** They are wired together only by the parent (or by
  explicitly waiting on a shared handle).

**Scope knowledge lives in the message stream, not the system prompt.** When
bindings enter an agent's scope, the runtime appends a compact scope announcement to
history as a user-role message — the mechanism already used for steering and
new-agent announcements (`src/agents/agent.ts:2328-2345`). After **compaction**, the
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
sending (grant record: sender identity, recipient handle, alias → ULID — journaled);
the recipient's runtime binds an `env` only if a matching pending grant exists,
verified with the store. A forged bus message with `env` finds no grant and binds
nothing. For delegations the spawner registers the grant as part of spawn (it is
the sender's runtime); `message_agent`/continue grants register before publish.
Grant registration is also where **alias collisions fail loudly** (§1 naming): an
`env` alias already present in the recipient's scope rejects the grant back to the
sender, who can re-alias — explicit names are never suffixed. Message-shape note:
`env`, `StartMessage.model`, and the other new fields are **additive optional
fields** on existing messages and tool schemas; older parsers ignore them and no
compatibility machinery is built (project rule: no backward-compat shims).

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
// plus the pure JS stdlib. No fs, no fetch, no process, no import/require —
// and no runtime globals: cells execute in a stripped realm with the ambient
// API as the ONLY non-stdlib surface. In a Bun-hosted process, `Bun`,
// `process`, and friends grant full fs/exec — leaving them reachable would
// hand every cell holder capabilities the grant system deliberately withheld
// (code-mode agents hold no exec grant — a validated invariant, §6).
// Enforcement is two-layer, because global stripping alone cannot deliver
// "no import": dynamic `import()` is SYNTAX, not a deletable property, and
// one `await import("node:child_process")` would reopen everything. So:
// (1) cell source is lexically scanned before execution — any `import`
// (static or dynamic) or `require` occurrence rejects the cell with a loud
// error; (2) realm construction strips the runtime globals. Lexical
// enforcement on model-authored code is adequate for the v1 confused-deputy
// trust model; it is not a hard sandbox, per Non-goals.
```

`parse()` shares `get()`'s materialization budget (default 1 MB): it produces the
full parsed structure in the cell worker, which is materialization. Over-budget
JSON → refuse with guidance (grep/slice first, or delegate).

**Cell results to the LLM:** captured stdout + final expression value (auto-bound if
over threshold) + manifest of new bindings + on error, message, offending line, the
names currently in scope, and the handle IDs of spawns still in flight.
**Replay carries the cell result as a standard `primitive_end`**: cell completion
emits the ordinary `primitive_end` event with `tool_result_message` — the event
class replay already reconstructs history from (`src/kernel/event-replay.ts:55-90`)
— *plus* the telemetry `cell_end` (§8, which carries code and metrics, not the
tool result). Without this, resuming an owner after a *successfully completed*
cell would orphan the `cell` tool_use just as surely as dying mid-cell; the
dangling-eval synthesis covers only the incomplete case.
**Everything a cell emits above the line goes through the same gate as value
reads:** stdout, final expression values, and error messages can echo raw `get()`
content (`console.log(get('secrets'))` is one line), so all of it passes
`redactSensitiveTranscriptContent` and the auto-bind threshold before reaching any
model, event, or UI consumer — the read-side redaction rule (§1) would otherwise be
a one-line bypass. The same applies to journaled cell code and `cell_end` event
payloads, and to learn-signal artifacts carrying cell code (§7): journal and event
writes of cell material pass redaction at write time.

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
  escaped it. Fix (Phase 0 timer + Phase 1 pings): the timer suspends during
  **every blocking wait on another agent, in either mode** — blocking tool-call
  delegations, blocking `wait_agent` and `message_agent`, pending cells, and
  ambient waits inside cells. Anything narrower recreates the asymmetry: suspending
  only delegations and cells would leave tool-mode's `wait_agent` pattern (deferred
  waits on shared handles, legal up to 900 s against a 300 s inactivity default)
  exposed to the same spurious stumble code mode escapes. **Liveness pings** — a
  new mechanism, not an existing one — keep suspensions alive. Every agent process
  pings the host over its authenticated connection every 15 s (a wedged event loop
  stops pinging — its own `setTimeout`s can't fire — which is what makes this a
  real net); cell workers ping for cells. The host relays liveness to whoever is
  suspended on that party; missing pings resume the waiter's timer, which then
  times out normally. Root and featherweight runs use in-process liveness.
- **Deadlock detection: the host owns the wait graph — and the graph covers every
  blocking wait, not just ambient ones.** With waiter caps removed and inactivity
  timers suspended, cycles would otherwise hang forever with every party alive and
  pinging. The uncapped-wait set is: ambient waits (spawn wait, `handle.wait`)
  *and* blocking tool-call delegations (`waitForBlockingSpawn` has no timer,
  `src/bus/spawner.ts:620-637`, and its former backstop — the inactivity timer —
  is now suspended). A graph that registered only ambient waits would miss mixed
  cycles: parent A blocking-delegates (tool call) to code-mode B, whose cell
  ambient-waits a shared handle of A — one registered edge, no cycle detected,
  everything pings, permanent silent hang. So **every blocking wait on another
  agent registers** start/end with the host over the authenticated channel —
  delegation waits, `wait_agent`/blocking `message_agent`, spawn waits,
  `handle.wait` — and the host detects cycles and fails the youngest wait with an
  explicit deadlock error naming the cycle. `wait_agent` keeps its 900 s cap *in
  addition to* registration; the cap alone was never cycle-safe for the uncapped
  edges around it. Edge lifecycle: edges deregister on wait completion and are
  swept when the registering connection drops (process death) or its wait is
  cancelled (owner interrupt) — stale edges would make the detector fire on
  phantom cycles.
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
  in the owner's spawner so `wait_agent` and result caching work. "Identical
  events" includes the session-wide topic: the owner synthesizes the child's
  `session_start`/`session_end` events (subprocess children publish these
  themselves, `src/bus/agent-process.ts:320-331`, and the TUI's active-work
  derivation and observers consume them) — otherwise a 50-way featherweight
  fan-out would be invisible to every session-event consumer.
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

**The code-mode tool surface is defined and validated, not implied.** An
`act: "code"` spec's tool surface is exactly `cell` plus the implicit `value_*`
reads — nothing else. Genome validation rejects code-mode specs granting
primitives or `delegate`: delegation happens through `spawn()` inside cells, the
world is touched through spawned leaves, and a hybrid (cells beside an
unrestricted `exec` tool) would make the stripped realm security theater. This
turns §4's premise — code-mode agents hold no exec — from an assumption into a
validated invariant. The genome will mutate specs toward hybrid shapes;
validation, not convention, is what stops them. Flag-off degradation of a
code-mode spec therefore yields `delegate` (code mode requires
`can_spawn: true`) plus `value_*` — a functional tool-mode agent.

**The data-plane session flag, defined — including the arguments.** Off means
*off* for the data plane: no store values, no capture, no publish, no splicing,
no auto-bind, no scope announcements, no cells. **The authenticated channel and
its control-plane services — tokens, handle registration, liveness pings, wait
registration, deadlock detection, timer suspension — are flag-independent (§1)**
and run in every session; the flag governs data, not liveness. `value_*` and `cell` filter out of
the registry in off-sessions; `act: "code"` degrades to `"tools"`; and data-plane
*fields* emitted in an off-session (`bind:`/`publish:` args, `env` on delegate or
message, whole-arg `⟦name⟧`) are **rejected with a clear tool error naming the
flag** — loud and uniform, never silently stripped (stripping would make tasks
fail downstream in undiagnosable ways).

**A/B honesty about genome adaptation.** A genome that has evolved under the
treatment arm (specs, memories, programs habituated to capture/env/cells) will
stumble against these rejections in off-sessions — at that point the off arm
measures adaptation friction, not baseline orchestration. So the §10 comparison
runs in **eval mode with pinned genome snapshots** (the harness already runs
pinned, read-only genomes): both arms execute the same genome, and the comparison
is valid by construction rather than only at t=0.

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
unchanged. Observer configs' `events:` filters (validated against known event kinds,
`src/agents/markdown-loader.ts`) gain the new kinds — an observer that should react
to dataflow must be able to subscribe to `value_bind`/`cell_start`/`cell_end`, and
root's shipped observer specs are updated accordingly. Events carry previews instead of raw content — observer frames get
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
- **The canonical scenario, defined** (referenced throughout): root delegates
  "author a 50 KB TypeScript module per this schema" to a tech-lead, which
  delegates authoring to an engineer child and file-writing to an editor leaf; the
  content flows engineer → store (publish) → editor (`$ref` into `write_file`),
  and root receives summary + manifest. Baseline: the same task on the flag-off
  arm, where content rides goals and tool results inline.
- **Acceptance criteria, one per goal** (the canonical scenario alone validates
  only the first):
  - *Token economics:* ≥ 80% token reduction on the canonical scenario versus
    baseline.
  - *Fan-out:* a 50-way llm-call fan-out completes with zero spurious failures
    and wall-clock bounded by the slowest child, not the sum.
  - *Resume/replay:* every §11 resume scenario replays to provider-valid history;
    zero regressions in existing resume tests.
  - *Grant security:* the forged-env, observer-env, forged-spawn, **forged-result
    manifest**, and **handle re-registration** tests all reject; the keystone
    no-content-in-LLM-payloads assertion holds.
  - *Liveness:* a two-agent wait cycle is detected and failed within one ping
    interval; a wedged child resumes its waiter's timer within two.
  - *Code mode:* after the A/B period, code-mode stumble rate is no worse than
    tool-mode on matched tasks (else `act: "code"` does not graduate to default
    on any spec).
  - *Programs:* one quartermaster-fabricated program survives eval-mode gating,
    root promotion, and re-execution in a fresh session.

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
  name validation (charset, length, reserved names) and loud explicit-name
  collisions (bind, `bind:`, env-alias at grant registration); manifest-collision
  suffix with summary-reference rewrite; CAS staging confinement (out-of-staging
  and symlinked paths rejected); cell-output redaction gate
  (`console.log(get(...))` of a secret is redacted in the tool result, event, and
  journal); sandbox: realm asserts `Bun`/`process` absent AND a cell containing
  `await import(...)` or `require(...)` rejects before execution; RSS watchdog
  kills an allocation-bomb cell worker leaving host and store untouched
  (darwin-viable — no rlimit dependence); `$ref` in an `apply_patch` body
  rejected; path constraints re-run on post-splice arguments; per-result
  manifest deltas (a second continue re-delivers nothing; same-handle republish
  is a version update, not a collision); parent token re-registration on
  respawn/resume with non-parent registration still rejected; code-mode spec
  validation (primitives or `delegate` in an `act: "code"` spec rejected); cell
  completion emitting `primitive_end` with tool_result_message (resume after a
  *successful* cell replays provider-valid); store disk/count quota →
  store-full error, with the automatic-path fallbacks (marker degrades honestly;
  result overflow reverts to 30 K inline); capture fidelity (raw bytes for
  read_file incl. offset/limit slices; stdout/stderr split; structured grep
  matches); off-session data-plane fields rejected with the flag named;
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
  10-minute single-child await surviving under suspended timers in both act modes,
  including the `wait_agent`-on-shared-handle pattern; a two-agent ambient wait
  cycle *and* a mixed cycle (tool-path blocking delegation one way, ambient
  `handle.wait` the other) both failing fast with a deadlock error; a forged
  `ResultMessage` carrying manifest ULIDs binding nothing (manifests are pulled);
  handle-registration integrity (duplicate and non-parent registrations
  rejected); manifest collision in a same-type fan-out delivering rewritten
  summary references; resume of an owner
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

One design, sequenced by dependency; each phase lands green before the next starts.
Phases are deliberately small — each is one reviewable concern, and safety
mechanisms land *with* their nets, never before (a paused timer without pings is a
hang; publish without manifests is a stranded value):

0. **Kernel prerequisites** — `hitTurnLimit` fix; zero-tool completion agents;
   inactivity timer made *pausable* (mechanism only — nothing suspends yet;
   today's caps stay in force until Phase 1's pings exist).
1. **Channel & auth** — authenticated host endpoint, per-handle tokens, **handle
   registration** (identity bootstrap, duplicate/non-parent rejection), env
   filtering (token, endpoint URL, bus URL), liveness pings; timer suspension for
   *all* blocking agent waits (delegations, `wait_agent`, blocking
   `message_agent`) activates here, pings as its net (fixes the pre-existing
   spurious-timeout bug symmetrically).
2. **Store core** — store worker (op budgets, wedge restart), journal, CAS
   (staging-confined handoff, spill), disk/count quotas, name validation,
   previews + redaction, `value_bind` events, value-read primitives (truncation
   bypass), spawnerless local store.
3. **Capture & publish** — structured-result methods on `ExecutionEnvironment`
   (raw bytes; stdout/stderr split; structured grep matches), capture (`bind:`
   args, auto-capture on both truncation passes, truthful markers), publish
   (`publish: true`, `value_publish`, auto-publish of result overflow),
   **pulled result manifests** + summary budget + collision suffix with
   summary-reference rewrite + store-full fallbacks, auto-bind at agent
   boundaries, scope announcements + post-compaction manifest event. One phase
   because publish is only correct with its receiving semantics (manifests,
   announcements) present.
4. **Splice & grants** — `$ref` whole-arg resolution (loud misses, per-primitive
   allowlist), env-grant registration (loud alias collisions, observer-env
   prohibition), `env` on delegate/message/continue/StartMessage.
5. **Evaluator** — per-agent cell workers (subprocesses, RSS watchdog + Linux
   rlimit hardening, stripped realm + lexical import scan), `cell` tool over the
   authenticated channel, ambient API incl.
   `handle(id)` and `publish()`, cell-output redaction/budget gate, spawn routing
   (owner relay + root bridge) with the five cell-spawn deviations, stumble
   counting + learn dedup, budget clock, cancellation lease, full blocking-wait
   registration + cycle detection (lands *with* the timer-less waits it
   protects), **host handle registry for shared handles**
   (until this lands, cross-process shared-handle access errors explicitly as
   unsupported — no partial behavior), featherweight placement + three-record
   logs, `utility/llm-call`.
6. **Code-first** — `act` spec field + flag semantics + flag-off-empty genome
   validation, cell-implies-value-reads, scoped observer store access, TUI/web
   rendering.
7. **Programs** — genome artifact type + sync/export plumbing, quartermaster
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
| Explicit names | Loud collision failure for bind/`bind:`/env aliases; suffixing for auto-binds only | Silently renaming a granted name breaks every reference the granting model wrote |
| Manifest collisions | Suffix + rewrite of `⟦name⟧` references in the delivered summary | The child is gone, so loud failure is impossible; unrewritten references resolve to the wrong value |
| Cell output | Same redaction + budget gate as value reads, incl. journal and events | `console.log(get('secrets'))` is a one-line bypass otherwise |
| Manifest transport | Pulled from the store over the recipient's authenticated connection; never on ResultMessage | Result topics are open bus; a pushed manifest would let forged results mint cross-scope bindings |
| Identity bootstrap | Spawners register child handles+tokens with the host before launch; duplicates and non-parent registrations rejected | Spawners are per-process; the host is not in the grandchild spawn path and can't otherwise validate handshakes |
| Wait coverage | Timer suspension and wait-graph registration cover every blocking agent wait, both modes | Partial coverage recreates the arm asymmetry and leaves mixed tool/ambient cycles undetectable |
| Cell worker containment | OS subprocesses; RSS watchdog (rlimits are Linux hardening only); stripped realm + lexical import/require rejection | Thread OOM kills the host; RLIMIT_AS is unenforced on darwin; dynamic import() is syntax no realm strip can remove |
| Code-mode surface | Exactly `cell` + implicit `value_*`; hybrids rejected at genome validation | An `exec` grant beside a stripped realm is security theater; the genome will mutate toward hybrids |
| Manifest delivery | Per-result deltas with a handle×recipient cursor; same-handle republish = version update | Cumulative fetch re-collides every prior publish on keep-alive continues |
| Control vs data plane | Channel, tokens, pings, wait graph are flag-independent | Flag-off must not remove the liveness net or fork timer semantics between arms |
| A/B validity | Eval mode with pinned genome snapshots; off-session data-plane fields rejected loudly | A treatment-adapted genome makes a live control arm measure adaptation friction, not baseline |

## 14. Adversarial review log

**Round 6 (2026-07-17, clean room):** 8 distinct findings. **RLIMIT_AS is
unenforced on macOS** — empirically verified on the development machine — so the
cell-memory containment cornerstone was unimplementable on the platform sprout
runs on (→ RSS watchdog, rlimits demoted to Linux hardening); **`$ref` into
`apply_patch` bodies bypassed `allowed_write_paths`** (constraints parse paths
from raw args pre-splice; → apply_patch off the allowlist + post-splice
constraint re-run); **dynamic `import()` is syntax, not a strippable global** (→
lexical import/require rejection before execution); **no event carried a
completed cell's tool result into replay** (→ cell completion emits standard
`primitive_end`); flag-off "no tokens" destroyed the liveness net in the control
arm (→ channel is flag-independent control plane); cumulative manifest fetch
re-collided keep-alive continues (→ per-result deltas + version-update rule);
token lifecycle conflicted with duplicate-registration rejection on
respawn/resume (→ parent-may-re-register carve-out); code-mode tool surface was
undefined while §4's security rationale assumed it (→ validated
cell-plus-value_* surface, hybrids rejected). Minors: featherweight session-event
synthesis, summary-head derivation + full-output overflow value, wait-graph edge
sweeping, crash-recovered results as a stated status-quo path, exec's
already-structured ExecResult correcting §2's universal claim.

**Round 5 (2026-07-17, clean room, post-roborev):** 10 distinct findings; the two
reviewers tied and independently found the same blocker: **result manifests — the
primary child→parent data path — had no authenticated transport** (a manifest
field on the open-bus `ResultMessage` would have let forged results mint
cross-scope bindings; → manifests are now pulled from the store over the
recipient's authenticated connection, and overflow content never rides the bus).
Also: the identity bootstrap was unspecified (mid-tree spawners mint tokens the
host never learns; → handle registration with duplicate/non-parent rejection);
the wait graph was blind to tool-path blocking delegations (mixed cycles would
hang with all nets green; → every blocking agent wait registers); timer
suspension omitted `wait_agent` (arm-asymmetry confound survived; → all blocking
waits suspend, both modes); store-full was unspecified for the automatic bind
paths (result overflow would silently drop below today's 30 K inline; → degrade
to status-quo fallbacks); manifest collisions silently suffixed child-authored
names (`⟦impl_notes⟧` in a summary would resolve to the wrong value; → suffix +
summary-reference rewrite); capture "tapped" an environment layer that has no raw
bytes (`grep` raw text doesn't exist; → structured-result interface methods);
cell workers had no memory containment and the realm left `Bun`/`process`
reachable (full fs/exec past the grant system; → OS subprocesses with RLIMIT +
stripped realm); §3 and §12 scheduled the handle registry in different phases (→
Phase 5, reconciled); flag-off behavior for data-plane *arguments* was undefined
and genome adaptation would decay the control arm (→ loud rejection + pinned-
genome A/B in eval mode).

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

**Design review (2026-07-17, roborev job 2158, codex, full-spec range):** verdict
Fail on ambiguity, not direction. Fixed: explicit-name collisions now fail loudly
(suffixing reserved for auto-binds); cell stdout/final-value/error output routed
through the same redaction + budget gate as value reads (was a one-line bypass);
namespaces defined as string-addressed (names are validated data, never JS
identifiers); CAS handoff confined to host-created staging with symlink-safe
adoption; store-op timeout contract weakened to timeout-or-restart (JS regex is
uninterruptible); disk/value-count quotas with store-full-is-a-stumble semantics;
acceptance criteria per goal; build order split into eight single-concern phases
with safety mechanisms landing with their nets (timer suspension with pings,
publish with manifests, timer-less waits with cycle detection, shared handles
explicitly unsupported until their registry); additive-only message fields, no
compat shims.

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
