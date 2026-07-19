# Sap build plan (living)

**Date started:** 2026-07-18
**Spec:** `../specs/2026-07-16-sap-data-plane-and-repl-design.md`
**Review:** `../specs/2026-07-18-sap-state-of-the-art-review.md`
**Status:** in progress — Phases 0–5 complete (built + Fable-reviewed). v1 eval measurements captured (see below). Phases 6–7 (code-first act mode; genome programs + metrics) remain.

This is the working tracker for building sap. It records *what we're building, in what
order, and where we deliberately simplified away from the maximal spec*. Update it as
phases land.

## Guiding principle

**Simple, clean, self-improving.** The spec is the maximal, adversarially-hardened design;
it is the reference for *intent and invariants*, not a line-by-line build order. We implement
the simplest clean mechanism that satisfies each phase's intent and preserves the spec's
frozen invariants (the "one rule", the `$ref` allowlist, scope isolation, kernel-vs-genome
line). Where the spec hardens against a threat that isn't live yet, we defer that hardening
to the phase where it becomes load-bearing rather than landing it as dead code.

Two standing rules from the review that are *not* optional, because they protect the
self-improvement loop itself:
- **Multi-run A/B** for genome fitness (single-run stumble rate is noise — RLM-class variance
  scores identical inputs 0/6→6/6). Lands with metrics (Phase 7).
- **A hidden, outcome-anchored canary suite** the quartermaster cannot see (DGM proved a
  self-modifier games a visible fitness check). Lands with programs (Phase 7).

Everything the review filed as roadmap (futures + `$ref` pipelining, QuickJS cell engine,
Agent-Skills-compatible programs) is **post-v1**. We design the value model to *admit* futures
later (an unresolved-value state), but build nothing for it now.

## How we work

- **TDD, always.** Failing test first, then the minimal code to pass it. Regression test for
  every bug fix.
- **A phase lands green before the next starts** (typecheck + unit tests + biome clean;
  `bun run precommit`). Commit per reviewable concern, conventional-commit messages.
- **Subagent fan-out where files don't collide.** Read-only exploration fans out freely.
  Parallel *implementation* only across independent modules, in worktrees, never two agents
  editing one file. Foundational kernel edits are done in-line, coherently.
- **Architectural sub-decisions go to Jesse** before building (sandbox mechanism, store-worker
  transport, cell-worker engine). Routine implementation does not.
- **Each phase gets an adversarial Fable review before it's marked done** and before the next
  phase builds on it — a fresh-context reviewer (not a fork) on the strongest model, checking
  correctness/security/simplicity against the spec. Findings are addressed before proceeding.

## Phases

Order and intent follow spec §12. "Simplification" notes what we changed and why.

### Phase 0 — Kernel prerequisites  ✅ landed 2026-07-18
- [x] **`hitTurnLimit` bug fix** (`95d7340`). An agent that naturally completed on its final
  allowed turn was marked failed + stumbled — a live fitness-signal bug. Fixed by threading
  `completedNaturally` from the natural-completion breaks.
- [x] **Runtime health on Linux** (supported runtime, per Jesse): `node`-interpreter agent
  tools failed on Linux (`/dev/stdin` → /proc pipe ENOENT) — tool scripts now run from a
  shell-side temp file (`a4c97d8`); subcortical eval needed a realistic timeout (`8b0ea34`);
  abort-between-turns test had a timer/spawn race under parallel load (`186f376`).
- [x] **Fable review (fix-then-ship → fixed).** Logic confirmed correct (no masking path).
  Findings addressed: `hitTurnLimit` no longer fires on an abort landing at the final turn
  (`412e7dd`); the flagship fix now has an agent-level seam test and the tool-exec fix has
  escaping/injection torture tests (`75af20c`) — both verified to fail under the regression
  they guard.
  - *Residual (pre-existing, for the code-mode tool-surface phase):* a script tool's `args`
    are interpolated into the executor shell raw (`tool-loading.ts`), so any agent granted
    *any* script tool already holds arbitrary shell in its ExecutionEnvironment even without
    the `exec` primitive. Matters when sap tightens code-mode surfaces (Phase 6) — the
    stripped realm withholds exec, but a granted script tool does not.
- **Simplification — deferred, not dropped:**
  - *Zero-tool completion agents* (`tools: []`, `max_turns: 1`) → **Phase 5**, landing with
    `utility/llm-call`, its only consumer. Building it now is dead capability.
  - *Pausable inactivity timer (mechanism only)* → **Phase 1**, landing with the suspension
    logic that first calls it. A pause nothing calls is dead code; the spec split it out for
    review isolation, which we don't need.

### Phase 1 — Channel & auth  ✅ landed 2026-07-18
Authenticated host endpoint, per-handle tokens, handle registration
(duplicate/non-parent rejection), env filtering (token, endpoint URL, bus URL), liveness
pings; **timer suspension for all blocking agent waits** (this is where the pausable timer
from Phase 0 lands, *with* pings as its net). Fixes the pre-existing spurious-timeout bug
symmetrically across arms.

Slices (test-first; fan-out where files are disjoint):
- [x] `src/host/handle-registry.ts` — identity core (`51c3f08`): registration
  (duplicate/non-parent rejection, owner re-register carve-out when not live), sha256 token
  hashing, constant-time authenticate, live-connection tracking. Pure logic, no I/O.
- [x] `src/agents/inactivity-timer.ts` — pausable inactivity timer (`d5648ff`): reentrant
  pause/resume, resume re-arms fresh. Extracted from the run loop's inline setTimeout.
- [x] Swap the run loop's inline timer for the module (`3cac769`, behavior-preserving).
- [~] **Authenticated host endpoint** — DECIDED: separate authenticated WebSocket endpoint
  (Bun.serve, token at handshake, connection→identity via the registry). Transport core
  (`src/host/auth-channel.ts`, server+client, request/response envelope) building test-first.
  Integration flow discovered while scouting:
  - Host wiring beside `BusServer` in `src/host/cli-shared.ts:48` — create `HandleRegistry`
    + `AuthChannelServer`; register a `register_handle` request handler that calls
    `registry.registerHandle` with the *connection's verified identity* as `registrarId`.
  - **Registration rides the auth channel**: an already-authenticated spawner process sends
    `register_handle` over its own connection before launch (host verifies registrar =
    that connection). Root registers its direct children via the registry's in-process
    trusted path (`trustedRegistrarId`).
- [x] Foundation modules built + reviewed line-by-line + committed:
  - `handle-registry.ts` (`51c3f08`) + reserved-trusted-id hardening (`ad015b9`, a
    privilege-escalation closure found while wiring the host trusted path).
  - `auth-channel.ts` transport (`9ae48f1`).
  - `handle-registrar.ts` — trusted-direct + over-channel registration, keystone tested
    (`892e4b6`).
  - `inactivity-timer.ts` (`d5648ff`) + run-loop swap (`3cac769`).
- [x] Env filtering: `SPROUT_BUS_URL`/`SPROUT_AUTH_URL` withheld from exec shells (`bc838cb`).
- [x] **The spawn-path integration — landed as one slice.**
  - Host: `startBusInfrastructure` starts the `AuthChannelServer` (trusted id
    `TRUSTED_REGISTRAR_ID = "sprout:host"`, defined in `handle-registrar.ts`), registers the
    `register_handle` handler, hands the spawner `{ url, registrar: HostHandleRegistrar }`,
    exposes `authUrl` + `handleRegistry` (optional fields) on `BusInfrastructure`, and stops
    the auth server in cleanup + the startup-failure path.
  - Spawner: grouped optional `authChannel` constructor param (7th);
    `registerHandleForLaunch` mints the token, registers before launch (both the spawn and
    the re-spawn path — tokens are never journaled, so re-spawn re-registers), injects
    `SPROUT_AUTH_URL` + `SPROUT_HANDLE_TOKEN`; observers register with their remit
    (root caller → session, otherwise delegate scoped to the owner). A rejected
    registration aborts the launch. No auth channel → unchanged.
  - Agent process: connects an `AuthChannelClient` before signalling ready (refused
    credentials fail the process fast), hands a `ChannelHandleRegistrar` to its child
    spawner, disconnects in the shutdown path. Env entry point reads
    `SPROUT_AUTH_URL`/`SPROUT_HANDLE_TOKEN`.
  - Tests: spawner unit tests (register-before-launch ordering, env injection,
    registrar-rejection abort, observer remits, re-spawn fresh token, no-channel spawn),
    agent-process liveness lifecycle + fail-fast-on-refusal, host-wiring tests
    (authUrl exposed, intruder refused, registered handle authenticates, reserved trusted
    id, cleanup stops the channel), and an end-to-end spawn through real
    registry+channel+trusted registrar asserting live-while-running / cleared-on-shutdown.
  - *Known coverage gap for the Phase 1 review:* grandchild registration **through a live
    agent process delegation** is untested end-to-end — triggering it would launch real
    subprocesses. The channel path is covered piecewise (`handle-registrar.test.ts` real
    channel + spawner-with-authChannel tests).
- [x] **Liveness pings (15 s) + timer suspension during blocking waits — landed.**
  - Pings: every agent process pings the host every 15 s over its authenticated
    connection (`LivenessReporter`; recorded ONLY for the connection's verified identity).
    A `liveness` request answers "ms since this handle last pinged"; probes mirror the
    registrar split (`HostLivenessProbe` in-process, `ChannelLivenessProbe` over the wire)
    and ride the spawner's `authChannel`.
  - Suspension: the run loop's inactivity timer is now an instance-visible
    `currentInactivityTimer`; `withInactivitySuspendedFor(handleId, fn)` pauses it around
    every blocking wait on another agent — blocking tool-call delegations, `wait_agent`,
    blocking `message_agent` (both act-mode arms once code mode exists, since cells route
    through the same spawner paths). The net: while suspended, a poll checks the awaited
    party's pings; silence past 2× the ping interval resumes the timer, which then times
    out normally instead of hanging forever. Pause/resume stays balanced when the net
    fires (the net performs that wait's resume; the finally skips its own).
  - Layering: cadence constants + `LivenessProbe` live in `src/shared/liveness.ts` (the
    architecture boundary test forbids agents/ → host/ imports).
  - Tests: registry ping tracking, handler identity rules, reporter cadence over a real
    channel, both probes; agent seam tests (wait outliving `timeout_ms` completes without
    timing out — mutation-verified; healthy pings hold suspension; silent counterparty
    resumes and times out; blocking spawner delegation suspends too). This closes the
    pre-existing spurious-timeout bug symmetrically.
  - *Deferred to the wait-graph phase:* host-side deadlock detection (spec §4) — depends
    on wait registration, which lands with cells/waits.

#### Phase 1 Fable review — outcome
Fresh-context adversarial review of the whole phase. No criticals; core identity
properties confirmed (registrar-from-connection, reserved id, auth-before-upgrade with
rollback, constant-time compare, token env filtering). Findings and dispositions:
- **Fixed — late-probe double-resume** (major): an in-flight liveness check landing after
  its wait already resumed could resume a second time, unbalancing an overlapping wait's
  suspension. One `settled` guard now covers both resume paths; mutation-verified test.
- **Fixed — channel registrar remit/depth escalation** (major): the host accepted any
  `observerRemit`/`depth` from the payload; a mid-tree registrar could grant its observer
  a session-wide remit or claim arbitrary depth. The handler now requires depth ==
  registrar.depth + 1 and remits scoped to the registrar's own delegations; tests added.
- **Fixed — never-pinged parties never tripped the net** (minor): `null` msSincePing is
  now measured against the wait's start, so a child that wedges before its first ping
  still resumes the waiter's timer.
- **Fixed — auth timing distinguishable for unknown handles** (minor): the unknown-handle
  path now does the same hash+compare work as the bad-token path.
- **Documented — token-inheritance invariant** (minor): comment at the spawn env site.
- **RESOLVED (Jesse: "i trust you") — respawn re-registration vs. socket-close race**
  (major): same-owner re-registration now tolerates a stale live flag — the owner
  re-registers only when it observed the child's process die, and the socket-close event
  that normally clears liveness can lag that death. Re-registration replaces the token
  hash (voiding the dead process's credentials immediately) and clears the flag; a
  different owner still can't capture a handle, live or not. `live_connection` removed
  from the result union.

#### Resume notes — spawn-path integration (enough to pick up cold)
- **Trusted registrar id:** a reserved sentinel that is neither a ULID nor `"root"` (root's
  bus handle) — e.g. `"sprout:host"`. The registry now refuses to register any handle with
  this id (`ad015b9`), so the choice is robust regardless. Define it where host wiring uses it.
- **Host wiring** — `cli-shared.ts` `startBusInfrastructure`, right after `server.start()`
  (~line 55): create `new HandleRegistry({ trustedRegistrarId })`, `new AuthChannelServer({
  port: 0, hostname: "127.0.0.1", registry })`, `await authServer.start()`,
  `authServer.onRequest(REGISTER_HANDLE_REQUEST, makeRegisterHandleHandler(registry))`,
  `new HostHandleRegistrar(registry, trustedRegistrarId)`. Add `await authServer.stop()` to
  `cleanup`. Expose `authUrl` (= `authServer.url`) on `BusInfrastructure` for spawner + tests.
- **DI is additive-safe:** `cli-run.ts` uses `typeof startBusInfrastructure`; `cli-headless.ts`
  uses a narrower `HeadlessInfrastructure`. New *optional* `BusInfrastructure` fields break
  neither; if any are made required, update the mocks in `test/host/cli-*.test.ts`.
- **Two spawner construction sites:** host at `cli-shared.ts:73` (gets `HostHandleRegistrar` +
  authUrl); child process in `agent-process.ts` (build an `AuthChannelClient` from
  `SPROUT_AUTH_URL` + `SPROUT_HANDLE_TOKEN`, wrap in `ChannelHandleRegistrar`, pass to its
  child spawner). Add a grouped optional `authChannel?: { url, registrar: HandleRegistrar }`
  constructor param rather than more positional args.
- **Spawner spawn path:** handleId minted at `spawner.ts:527` (`ulid()`); child env built at
  `:539` and `:805`. Before launch: `token = mintToken()`, `await registrar.registerChild({
  handleId, tokenHash: hashToken(token), ownerId: caller.handleId, depth, observerRemit? })`,
  then add `SPROUT_AUTH_URL` + `SPROUT_HANDLE_TOKEN: token` to env. Skip entirely when
  `authChannel` is absent (test/spawnerless).
- **End-to-end test:** spawn a child through the real infra; assert it registered and can
  authenticate over the channel; assert env injection + exec filtering hold.
- **Phase 1 Fable review** runs when this integration lands (the whole phase as a unit).

### Phase 2 — Store core  ✅ landed 2026-07-18
Store worker (op budgets, wedge restart), journal, CAS (staging-confined handoff, spill),
disk/count quotas, name validation, previews + redaction, `value_bind` events, value-read
primitives (truncation bypass), spawnerless local store. *Simplify memory/spill to the
smallest correct LRU; no premature tiering.*

Slices (test-first; 1–3 are pure/disjoint and fanned out to subagents in parallel;
4+ built on top after review):
- [x] `src/store/value.ts` — pure value model: types (text/json/bytes), metadata shape,
  name validation (charset `[a-z0-9_]`, max 64, no leading digit, reserved list),
  deterministic previews (~300 chars: type/size/line count/head-tail; JSON top-level
  shape under a 10 MB parse budget, else `json (unparsed)` head/tail fallback).
- [x] `src/store/cas.ts` — content-addressed store: sha256 naming, dedup, put/get/has,
  staging-confined adoption (realpath-canonicalized, symlinks rejected, size checked
  against max-value before adoption), byte accounting for the disk quota.
- [x] `src/store/journal.ts` — append-only JSONL journal: bind (inline < 64 KB or CAS
  ref), scope, publish, manifest-delivery, grant, cell records; replay reads metadata
  only and tolerates a trailing partial line (crash mid-append).
- [x] Store engine on top (`src/store/store.ts`; bind records journal the explicit flag + createdAt so resume recovers collision origins): bind/rebind versioning + collision rules (auto-bind suffix,
  cross-origin fail-loud), value ops (peek/slice/grep/get/parse) with budgets, chunked
  line-bounded grep with abort checks, smallest-correct LRU memory budget with spill to
  CAS, disk/count quotas → explicit store-full error.
- [x] Store worker subprocess (`src/store/store-worker.ts` + `store-client.ts`):
  stdio-JSONL op protocol, SIGKILL-based wedge recovery with transparent idempotent
  re-issue (binds dedup by client-minted ulid — engine change), `StoreUnavailableError`
  with `.infrastructure === true` after retries exhaust, `--internal-store-worker`
  subcommand, real-subprocess integration test.
- [x] **Store host wiring + value-read primitives — landed.** StoreAccess (caller-scoped,
  no scope params; Direct/Channel impls riding the spawner authChannel like the liveness
  probe); host handlers derive scope from the verified connection (scope id = handleId,
  lazily created; provenance forced); per-session StoreWorkerClient in
  startBusInfrastructure; value_peek/grep/slice/get primitives with redaction and a 50k
  value_get budget. value_bind events + bind: capture args deferred to Phase 3 (capture)
  where binds first happen. Original scoping notes follow (historical):
  Resume notes (enough to pick up cold):
  - Host: start a per-session `StoreWorkerClient` in `startBusInfrastructure`
    (journal/cas under the session's durable log dir beside handle logs; rootScopeId =
    the session id or "root" — decide and record), expose it on `BusInfrastructure`
    (optional field), shut down in cleanup. Register auth-channel op handlers
    (`store_bind`, `store_peek`, `store_get`, `store_slice`, `store_grep`,
    `store_metadata`): SCOPE AUTHORITY COMES FROM THE CONNECTION — the handler derives
    the caller's scope from `ctx.handleId` (scope per agent handle, created at spawn
    registration or first use), NEVER from the payload; payloads are narrowed
    field-by-field like `makeRegisterHandleHandler`.
  - Agent side: a `StoreAccess` interface with two impls mirroring the registrar split
    (direct for host/spawnerless — wraps `StoreWorkerClient` or a bare `SapStore`;
    channel for agent processes — rides `AuthChannelClient`). Reaches the Agent via
    the spawner grouped param or a new optional Agent option — prefer riding
    `authChannel` like `LivenessProbe` did.
  - Primitives (kernel registry): `value_peek`, `value_grep`, `value_slice`,
    `value_get` (50k-char budget, read_file parity), each redacting through
    `redactSensitiveTranscriptContent` before returning above the line; a `bind:`
    capture arg on capture-capable primitives is Phase 3 (capture) — do NOT build it
    here. Emit a `value_bind` event on binds.
  - Reserved names for the store options: kernel primitive names from the registry +
    ambient API names (peek/grep/slice/get/parse/bind/publish/env) + "programs".
- [x] **Phase 2 Fable review — done; all findings fixed.** No criticals. Majors fixed
  (`9167e45` + `a29f5d9`): grep's clean-failure budget tier was dead code (microtask
  yield; now macrotask + 8s wall-clock op budget under the client's 10s wedge net);
  restart-counter unfairness (culprit-attributed now); CAS adoption TOCTOU (O_NOFOLLOW
  fd-based read, producer paths never renamed in); unbounded slice/grep output + channel
  accepting Infinity (engine output budgets, {matches, truncated}, strict int narrowing);
  unstated 16MB WebSocket cap (explicit 8MB + client oversize-bind guard); engine
  concurrency unsafety (internal mutex — worker serialization was silently masking it).
  Minors fixed: inline utf8 live/resume divergence, unredacted error paths, spawn-failure
  handling, inlineLimitBytes resume brick, two-round-trip channel get, CRLF addressing,
  stdin line cap. Confirmed solid: naming/collision rules, journal parsing + torn-tail
  replay, ulid-idempotent binds, provenance forcing, sha gating, scope-from-connection.

### Phase 3 — Capture & publish  ✅ landed 2026-07-18
Structured-result methods on `ExecutionEnvironment` (raw bytes; stdout/stderr split;
structured grep matches — grep results must carry offsets/lines that compose into
`slice`/`lines`/`spawn`), capture (`bind:`, auto-capture on both truncation passes, truthful
markers), publish, pulled result manifests + summary budget + collision suffix/rewrite +
store-full fallbacks, auto-bind at boundaries, scope announcements + post-compaction manifest
event. **Review add:** scope-announcement transport uses Anthropic mid-conversation
`role:"system"` messages where available, `system-reminder` fallback elsewhere.

- Phase 2 review deferral: in-host agents currently share the single root scope via
  `DirectStoreAccess` — give each in-host agent its own scope here.
- Phase 2 review deferral: channel-level bind idempotency (client-minted ulid over the
  auth channel, mirroring the store-worker re-issue dedup) so a dropped response cannot
  double-bind.

Slices (test-first):
- [x] **`$ref` splice engine (pure)** — `src/kernel/ref-splice.ts`: whole-arg
  trimmed `⟦name⟧` detection; the frozen kernel allowlist (`write_file.content`,
  `edit_file.old_string`/`new_string`; everything else NO including apply_patch);
  loud-miss classification (unknown name in scope; bracket-lookalike forms `[[x]]`,
  `〚x〛` etc. when x is a scope name) vs genuine passthrough; resolver injected as
  `(name) => Promise<Uint8Array|null>`. Pure module, exhaustive tests.
- [x] **Splice integration** — agent tool-execution path: resolve `$ref` args via the
  agent's StoreAccess before primitive execution (below the line), then RE-RUN path
  constraints on resolved arguments (belt-and-braces, frozen rule), loud tool errors
  on misses listing in-scope names.
- [x] **Structured-result surface** — ExecutionEnvironment gains raw-content forms:
  `read_file` raw slice bytes, `grep` structured matches `[{path,line,text}]`
  (`exec` already structured; `fetch` raw body).
- [x] **Capture** — `bind:`/`publish:` args on read_file/exec/grep/fetch (exec stderr →
  `<name>_stderr`); auto-capture when EITHER truncation pass drops content, marker
  names the value(s); store-full fallbacks (honest lossy marker; never a marker naming
  a nonexistent value); `value_publish` primitive; `value_bind` events; captured
  previews redacted at bind.
- [x] **Publish delivery + pulled manifest delta** — design decisions fixed:
  - Manifest binds are ALIASES into the recipient scope (name → existing ulid, no body
    copy) journaled as `grant` records; the `manifest_delivery` cursor record appends
    ATOMICALLY with them (journal multi-append). Resume replays grants into name
    tables and cursors.
  - Engine: `deliverManifest({ publisherHandle, recipientScopeId })` → delta of that
    publisher's publish records past the cursor; per name: same-handle earlier
    manifest name = version update (alias moves), other collisions suffix (auto-bind
    rule). Idempotent by cursor.
  - StoreAccess: `manifestDelta(publisherHandle)` (recipient = own scope, from the
    connection host-side). Worker op + client + both impls + channel handler.
  - Recipient runtime: at result receipt (spawner delegation + wait_agent +
    blocking message_agent), fetch the delta BEFORE delivering the tool result;
    render `published: ⟦name: preview⟧` lines under the result; infrastructure
    errors retry briefly then degrade to result-without-manifest with an honest
    note (never a hang, never silent).
  - Child boundary auto-bind: in the agent process, result output over the 4,000-char
    summary budget → bind FULL output (auto name from the goal slug), publish it,
    send head-4000 inline with a marked mechanical cut; store-full → today's 30k
    truncation fallback. ResultMessage carries NO manifest and no overflow content.
- [x] **Auto-bind at the boundary** (landed with the manifest slice) — child result overflow past the 4,000-char summary
  budget auto-binds + auto-publishes the FULL output (inline head is a marked
  mechanical cut); dead-child recovery delivers summary + manifest delta from the
  journal, store-unavailable fallback = today's 30k inline truncation.
- [~] Phase 2 deferrals: per-agent scopes hold for subprocess agents (scope = verified
  handle); the in-host root's single scope is CORRECT for root itself — recorded, not a
  bug. Channel-level bind idempotency still open (flag for the Phase 3 review).
- [x] Deferred (recorded): scope announcements + post-compaction manifest event slip to
  the evaluator phase — nothing consumes them yet; `value_lines`/`value_publish` as
  separate primitives also deferred (capture's publish: covers the current need).
- [x] Manifest pulls are owner-only for now: STORE_MANIFEST_REQUEST rejects unless the
  handle registry's registered owner of the publisher handle IS the connection's
  verified handle. Shared-handle cross-waiter delivery widens this later when needed;
  the in-host root path (DirectStoreAccess) stays ungated — root is the trust anchor.
- [~] Accepted (recorded): channel/worker-level manifest_delta re-issue after a
  crash-after-append can return an EMPTY delta — the cursor already advanced, so the
  aliases exist but the delta's lines are lost. Accepted for now alongside the open
  channel-level bind idempotency item.
- [x] **Phase 3 Fable review — done; all findings fixed** (`47f7f32`). Two criticals
  caught: registry auto-capture bound RENDERINGS (exec trailers/line numbers) — now
  captureSource carries raw bytes and no-source means no auto-capture; and single-file
  grep capture parsed rg's pathless output to zero matches (-H everywhere). Majors:
  manifest pulls gated to the publisher's registered owner; in-batch alias collapse
  fixed (staging keyed by source name); the .infrastructure tag now crosses the auth
  channel so subprocess parents retry mid-restart stores. Minors all fixed (journal
  bytes quota-counted, foreign-ulid publish rejected, bind-time preview redaction,
  single truncation marker, no double-store, bounded error results). Splice semantics
  verified frozen-correct: no prefilter bypass, no recursive splice, no normalization
  trick, constraints re-run on resolved args.

### Phase 4 — Splice & grants  ✅ landed 2026-07-18
`$ref` whole-arg resolution (LANDED in Phase 3), env-grant registration (loud alias
collisions, observer-env prohibition), `env` on delegate/message/continue/StartMessage,
manifest summary-text suffix rewrite. **← natural v1 release line: the ≥80% token win is
delivered here, no evaluator. Ship and measure before Phase 5.**

Design decisions (fixed):
- **Grant lifecycle**: sender registers over its authenticated connection BEFORE the bus
  message — new journal record kind `env_grant` {sender scope, recipient handle, alias,
  ulid} (pending); recipient's runtime claims on message receipt: a claim verifies a
  matching pending grant exists, aliases the value into the recipient scope, journals a
  `grant` record (same kind manifests use), and consumes the pending entry. A forged
  bus `env` finds no pending grant and binds NOTHING. Resume: `env_grant` → pending
  table, `grant` → bound alias, claimed pendings subtracted by (recipient, alias, ulid).
- **Sender-scope validation**: the sender must own the granted value (ref resolves in
  the SENDER's scope; foreign ulids rejected like publish).
- **Alias collisions fail loudly AT REGISTRATION** (explicit names never suffix): an
  alias already bound in the recipient's scope rejects the grant back to the sender.
  Race note: the recipient scope may gain the name between registration and claim —
  the claim then also fails loudly back into the recipient's tool result.
- **Observer-env prohibition**: enforced host-side at grant registration (the registry
  knows observer remits): an observer-role sender's registration is rejected.
- **Wire**: `env?: Record<string, string>` (alias → sender-scope name or ulid) additive
  on the delegate tool, StartMessage, ContinueMessage, AgentMessageMessage. Spawner
  registers grants at spawn (it is the sender's runtime); message/continue senders
  register before publishing the bus message. Recipient claims: start path binds before
  the first turn; continue/agent_message paths bind on receipt.
- **Scope announcements**: claimed env binds append a compact user-role message to
  history ("values now in scope: ⟦a⟧ (preview)…") — message stream, never the system
  prompt (cache-prefix preservation). Post-compaction consolidated manifest: DEFERRED
  to the compaction integration (recorded).
- **Manifest suffix rewrite** (§3): when a manifest alias suffixes, rewrite ⟦oldname⟧ →
  ⟦newname⟧ occurrences in that child's delivered summary TEXT before it reaches the
  recipient; the delta carries the alias map (child name → bound-as). Residual (spec
  stated): in-content references can't be rewritten.
- [x] **Phase 4 Fable review — done; all findings fixed** (`e62bcb3`): grant
  registration relationship-gated (own handles or your owner — closes the
  pre-registered-grant + forged-message scope-write escalation); GrantRecord via-tagged
  (env|manifest) so resume never misclassifies; pending overwrites reject loudly;
  manifest renames persist per child across deliveries; forged aliases never echoed;
  observers can neither claim nor receive env; messageAgent options object;
  continue/agent_message claim paths now covered.
- Deferrals recorded: observer READ expansion (remit-wide value reads) waits for the
  observation surface that consumes it; shared-handle host resolution stays Phase 5;
  task_payload untouched (superseded, no migration).

### Phase 5 — Evaluator  ✅ landed 2026-07-19
Design decisions (fixed; deviations from spec topology recorded):
- **Cell workers are owned by the agent process, not the host.** Each agent process
  lazily spawns ONE cell-worker subprocess (root's is owned by the host process — same
  code). Rationale: spawn routing becomes an in-process parent call over stdio — a pipe
  to your parent is unforgeable, so the spec's host-relay machinery (built to avoid the
  open-bus forgery) is unnecessary; the owner-lease semantics (owner dies → worker
  dies) fall out of ppid monitoring for free; credentials never leave the agent
  process (the worker proxies store ops through the OWNER's StoreAccess — the worker
  itself holds no token). The RSS watchdog runs in the agent process (250ms poll,
  512MB default, SIGKILL).
- **Stripped realm + lexical scan** (spec-frozen): cell source rejects any
  import/require occurrence before execution; the worker's realm exposes ONLY the
  ambient API + JS stdlib — no Bun, process, fs, fetch, require. v1 confused-deputy
  bar, not a hard sandbox (per non-goals).
- **Budget clock**: 5s wall-time default, not accruing while parked on ambient-API
  awaits; anything else (sync loops, phantom promises) accrues. Cells serialized per
  agent; spawn cap 64/cell; MAX_AGENT_DEPTH enforced by executeSpawnerDelegation.
- **Spawn contract** per spec: resolves {ok, summary, bindings, handle} on completion
  regardless of child success; rejects only on spawn-infrastructure failure. Delivered
  via the typed outcome envelope refactor of executeSpawnerDelegation (spec deviation
  #5); cell spawns skip mnemonics (#1), batch observer frames per cell (#2), mark act
  events cell_spawn for replay exclusion (#3), dedup learn signals per cell (#4).
  Infrastructure-tagged failures count zero stumbles.
- **DEFERRED TOGETHER, coherently**: shared-handle host resolution AND deadlock
  detection. Without cross-process shared-handle waits (which stay an explicit
  "unsupported" error, as today), wait cycles are structurally impossible — a child
  holds no handle on its parent, and private handles are local. The wait graph lands
  when shared-handle resolution does. Recorded as the load-bearing pairing.
- Cell results: stdout + final expression + new-bindings manifest (+ error detail with
  in-scope names); everything above the line passes redaction + the auto-bind
  threshold; cell completion emits a standard primitive_end (replay-safe) plus a
  telemetry cell_end; cell records journal (redacted at write).
- Dangling-call replay synthesis (both act modes) is IN scope: a pending tool_use with
  no result at replay closes with a truthful synthesized error (recoverable vs
  died_with_owner).

Slices:
- [x] A: cell worker subprocess + stripped realm + lexical gate + ambient VALUE API
  (no spawn) + budget clock + RSS watchdog + `cell` kernel tool + journaling +
  redaction gate + primitive_end/cell_end.
- [x] B: spawn()/handle() ambient API + typed outcome envelope refactor + the five
  cell-spawn deviations + stumble/learn accounting.
- [x] C: dangling-call replay synthesis (both act modes).
- [x] **Phase 5 Fable review — done; findings fixed** (`85dc2ec`). One HIGH: the
  stripped realm was cosmetic (new-Function param shadowing; Function/eval/constructor
  chains reached real Bun → arbitrary exec, falsifying the no-exec-grant invariant).
  Fixed with a real `node:vm` context — Bun implements node:vm with genuine realm
  isolation, verified empirically under Bun/JSC (constructor-chain escape resolves to
  the context's own global, no host reach). Only 3 host bridges enter; ambient surface
  installed from in-context source then bridges deleted; return values JSON-severed;
  lexical import gate retained. Two LOWs: outstanding-ambient cap (256, RSS watchdog is
  the ultimate net); infra-vs-stumble classification now by thrown-object identity
  (WeakSet), not forgeable message substring. Verified solid: redaction, stumble/learn
  dedup, replay truthfulness, the deferred deadlock↔shared-handle pairing (cross-process
  shared waits still error as unsupported — structurally cycle-free).
  - *Realm honesty:* node:vm is the confused-deputy bar (model-authored code can't reach
    host capabilities), NOT a hard sandbox vs a determined same-UID attacker exploiting a
    JSC realm bug — matches the spec non-goal. The SOA review's OS-capability-sandbox
    remains the path if the trust model ever hardens.

#### Phase 5 (spec text, for reference)
Per-agent cell workers, `cell` tool over the authenticated channel, ambient API (incl.
`handle(id)`, `publish()`), cell-output redaction/budget gate, spawn routing (owner relay +
root bridge) with the five cell-spawn deviations, stumble counting + learn dedup, budget
clock, cancellation lease, full blocking-wait registration + cycle detection, host handle
registry for shared handles, featherweight placement, `utility/llm-call` (+ **zero-tool
completion agents** from Phase 0). **Architectural decision pending (review §3.2): cell-worker
isolation.** Recommendation: OS capability sandbox (`anthropic-experimental/sandbox-runtime`,
Seatbelt/bubblewrap — fails closed) rather than the spec's stripped-realm + lexical-ban (fails
open, bypassable). Discuss before building. Add per-session sub-call/token budget (variance
cap). RSS watchdog worded as best-effort liveness, not a hard cap.

### Phase 6 — Code-first  ← current
`act` spec field + flag semantics + flag-off-empty genome validation,
cell-implies-value-reads, scoped observer store access, TUI/web rendering. Typed surface for
the ambient API and spawnable agents.

Design decisions (fixed):
- **§5 first (utility/llm-call foundation).** Zero-tool completion exemption already partly
  there (observer-tag path); extend to `tools:[] && max_turns:1` specs at both run-loop gates
  (agent.ts ~411/~1939). Per-spawn `model` override: SpawnAgentOptions.model +
  StartMessage.model (additive optional) + handle records it for respawn; resolved through the
  existing model-resolver; the cell `spawn(..,{model})` that currently rejects now threads it.
  `root/agents/utility/llm-call.md` genome spec (tools:[], can_spawn:false, max_turns:1,
  subcortical_recall:false). Featherweight in-process placement: single-turn no-tool no-spawn
  agents run IN the owner's process (no subprocess/bus handshake) with a synthetic completed
  handle in the owner's spawner, synthetic session_start/session_end on the session topic, and
  a 3-record per-handle log (perceive, plan_end, session_end) so resume + respawn-with-history
  work. Gated behind a spawner option; wait_agent/message_agent resolve the synthetic handle.
- **§6 act mode.** `act: "code"|"tools"` spec field (default tools, untouched). Code-mode Plan
  emits ONE `cell` call per act (the cell IS the plan); one stable tool per provider
  (cache-preserving). Code-mode tool surface = exactly `cell` + implicit value_* — genome
  validation REJECTS a code-mode spec granting any primitive or `delegate` (turns §4's
  no-exec premise into a validated invariant). Grant rule: `cell` implies value_* reads.
- **Data-plane session flag** (defined off-semantics): off = no store/capture/publish/splice/
  auto-bind/scope-announce/cells. The authenticated channel + control-plane services
  (tokens, registration, pings, timer suspension) are FLAG-INDEPENDENT — run every session.
  Off: value_*/cell filter out of the registry; act:code degrades to tools; data-plane FIELDS
  in an off-session (bind:/publish: args, env on delegate/message, whole-arg ⟦name⟧) are
  REJECTED with a clear tool error naming the flag — never silently stripped. Threaded as a
  session-level boolean from the runtime into the primitive registry + agent + splice/capture
  gates. Default ON for the branch (v1 is the data plane); the flag exists for A/B + off-arm.
- **Flag-off-empty genome validation.** Reject any spec whose functional tool set is empty
  after flag-off filtering (remove cell + value_*): must keep can_spawn:true or ≥1 real tool
  or the max_turns:1 completion exemption. Covers eval-only and value_*-only shapes. Runs at
  creation + mutation (markdown-loader + genome gates).
- **Typed surface (review add).** The cell tool description / code-mode system prompt carries
  a `.d.ts`-style declaration of the ambient API AND the spawnable agents' (name, goal-shape)
  — types make model-written cells reliable (Cloudflare evidence). Generated from the genome
  allowlist so it stays honest.
- Deferred (coherent, recorded): scoped observer store reads (needs the observation surface);
  shared-handle host registry + wait-graph (Phase 5 pairing).

Slices: [x] 6A §5 (llm-call + featherweight + model override), [x] 6B §6 (act mode + flag +
validation + cell-implies-reads), [x] 6C typed surface, [ ] 6D Fable review. (TUI/web cell
rendering folded — cell_end renders-as-null; deeper cell UI is post-v1.)

### Phase 7 — Programs & metrics
Design decisions (fixed):
- **programs/ genome artifact.** frontmatter (name, description, typed params, `spawns:`,
  version, provenance) + JS body run in the cell realm. Body passes the SAME lexical
  import/require scan as cells — at genome validation AND at load (git-editable outside
  mutation). Injected into code-mode namespaces as `programs.<name>(...)`, listed in a
  `<programs>` system-prompt block (declared `spawns` shown; runtime enforcement stays the
  caller's delegation allowlist). Genome dir list + bootstrap manifest + syncRoot +
  exportLearnings extend with a programs/ entry (staged-review promotion to root).
- **Immutability line:** store/capture/splice/publish/scope/cell semantics + ambient API +
  $ref allowlist are KERNEL (Learn can't touch). Programs are genome — fully evolvable.
- **Metrics (§10):** tokens per delegated byte moved; stumble rate by act mode; fan-out
  wall-clock; store hit sizes; prompt-cache hit rate by arm. Emitted as events + a metrics
  store, consumed by the eval harness.
- **Multi-run A/B with significance (non-negotiable).** Single-run stumble rate is noise
  (RLM variance scores identical inputs 0/6→6/6). Genome-fitness comparisons run N times per
  arm (pinned eval-mode snapshots, same genome both arms) with a significance test; the
  quartermaster's accept/reject gates on significance, not a single delta.
- **Hidden canary suite (non-negotiable).** An outcome-anchored eval set the quartermaster
  CANNOT see (not in the genome, not in any prompt) — DGM proved a self-modifier games a
  visible fitness check. Canaries run post-mutation; a regression rolls back regardless of
  visible fitness.
- **Curator pass** for library rot: consolidation/retirement of redundant agents/memories/
  programs, gated like any mutation.
- **Quartermaster program fabrication** from recurring cell patterns + repair from cell
  stumbles (cell_end carries code + program name/version so the artifact is resolvable).

Slices: 7A programs artifact + plumbing, 7B metrics + multi-run A/B + canary suite, 7C
curator + program fabrication, 7D Fable review.

## Roadmap (post-v1)
Futures + `$ref` promise pipelining (rides the existing wait graph); QuickJS-WASM cell engine
(byte-precise memory cap); Agent-Skills-compatible program metadata. Also table-stakes and
scheduled but spanning phases: **byte-exact persistence of opaque provider state** (Anthropic
thinking/compaction blocks, OpenAI encrypted reasoning items, Gemini thought signatures) in
the journal/resume path.

## Decisions log
- **2026-07-18:** Phase 0 reduced to the `hitTurnLimit` fix; zero-tool agents → Phase 5,
  pausable timer → Phase 1 (avoid dead code). Simple-clean over the spec's review-isolation
  split.
