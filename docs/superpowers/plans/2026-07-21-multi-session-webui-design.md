# Multi-Session Web UI — Design

**Goal:** Let the Sprout web UI show and switch between several agent sessions instead of the single session it binds to today.

**Status:** Design only. No implementation in this document. Every architectural claim is grounded in current code with `file:line` citations; uncertainties are called out explicitly.

---

## 0. The distinction that governs the whole design

"Support multiple concurrent sessions in the web UI" collapses two very different capabilities that must be kept separate, because they cost wildly different amounts:

- **A. View / switch between sessions (cheap, mostly additive).** The host process still runs exactly **one live session** (one `SessionController`, one `SessionBus`), but the web UI can list every persisted session, view any of them read-only from their logs, and switch which one is live via the existing resume path. Only one session is interactive at a time.
- **B. Multiple *live* concurrent sessions (expensive, host refactor).** N independent sessions run simultaneously in one host process — N controllers, N buses, orchestrated by a session manager that does not exist today. The web UI multiplexes all of them, each interactive.

The literal ask ("viewing/switching between several concurrent sessions") is satisfied by **A**. **B** is the maximal interpretation and requires reworking the host's single-controller assumption. This design delivers a client/server/protocol shape that serves **A** now and generalizes cleanly to **B** later, and it sequences the work so **A** ships first.

---

## 1. Current architecture (single-session), with invariants

### 1.1 Host: one controller, one bus, one session id at a time

- `SessionController` holds a single session id: `this._sessionId = options.sessionId ?? ulid()` (`src/host/session-controller.ts:468`), exposed read-only via `get sessionId()` (`:463-465`). It is a single `string` field, never a collection.
- The bus is `readonly`, assigned once (`src/host/session-controller.ts:469`), and event/command subscriptions are registered once in the constructor. `/clear` **mutates the session id in place** to a fresh ULID (`clearSession`, `:621-654`, esp. `:630` `this._sessionId = cleared.sessionId`) and emits `session_clear` carrying `new_session_id` (`:651-653`) on the *same* bus.
- The interactive CLI wires exactly one bus to both the controller and the web server: `new WebServer({ bus: opts.runtime.bus, sessionId: opts.sessionId, initialEvents: opts.initialEvents, ... })` (`src/host/cli-interactive.ts:346-362`; default `createWebServer` at `:247-261`). `opts.runtime.bus` is the same `EventBus` the controller subscribes to.

**Invariant H1 — one process hosts one live session.** There is no code path where two independent controllers/sessions share a bus, or where one process runs two concurrent sessions. (Confirmed: no second `new WebServer`/second-controller site exists.)

### 1.2 How events are scoped to a session

- The bus itself does **not** stamp session ids: `EventBus.emitEvent` builds `{kind,timestamp,agent_id,depth,data}` and touches nothing else (`src/host/event-bus.ts:42-68`).
- The **agent** stamps `data.session_id` in `emitAndLog`: `shouldTagAgentEventWithSessionId(kind) && typeof data.session_id !== "string" ? { ...data, session_id: this.sessionId } : data` (`src/agents/agent.ts:695-698`). `shouldTagAgentEventWithSessionId` returns `false` only for `session_clear` and `exit_hint` (`src/shared/session-event-scope.ts:3-7`).
- `requiresSessionIdAfterClear` (`src/shared/session-event-scope.ts:9-18`) additionally exempts `warning`/`error` from `agent_id` `"cli"`/`"session"`; everything else must carry a session id once a clear has happened.

**Invariant H2 — a single bus legitimately carries two session ids sequentially, only across `/clear`.** After `/clear`, `_sessionId` is a new ULID (`:630`) while a dying pre-clear agent (constructed with the old id, `agent.ts:283`) can still emit old-id events onto the same bus via the factory relay (`session-controller.ts:249-251`). The controller drops them from its own history (`suppressEvents`, `:659`), but they still reach the bus — which is exactly why the web server filters by session id (§1.3). There is **no** concurrent (as opposed to sequential) two-session-on-one-bus condition today.

### 1.3 Server: `src/web/server.ts` bound to one session

- Constructor binds one `sessionId` (`:116`), one `bus` (`:113`). `initialEvents` seed `historyCache` + the live `events` buffer and arm `sessionScopedEventsRequireIds` if the log already contains a `session_clear` (`:131-144`).
- `historyCache` is keyed by session id (`historyCache` / `historyCacheSessionId`, `:109-110`) and lazily loaded from `logs/<sessionId>.jsonl` + child log dir via `loadAllEventLogs` (`getHistoryEvents`, `:348-360`).
- Live event handling (`bus.onEvent`, `:161-214`): on `session_clear` it adopts `new_session_id` as the current session, resets caches and the buffer to just the clear event (`:163-174`); otherwise it accepts the event only if `sessionScopedEventApplies(event, this.sessionId, requireSessionId)` (`:176-188`). The filter helpers `sessionLifecycleApplies` / `sessionScopedEventApplies` (`:60-78`) reject any event whose `session_id` is present but differs from `this.sessionId`, and — after a clear — reject events lacking a session id.
- The buffer is capped: `if (this.events.length > EVENT_CAP * 2) this.events = this.events.slice(-EVENT_CAP)` (`:181-183`; `EVENT_CAP = 10_000`, `src/kernel/constants.ts:2`).
- WS lifecycle: on open, send exactly one snapshot (`createSnapshotMessage`, `:385-388`, `:524-538`) then add the socket to `wsClients` and seed tasks (`:385-393`). Every accepted event is **broadcast to all clients** (`broadcast`, `:610-615`) — there is no per-client / per-session routing.
- HTTP routes: `/api/auth` (token check), `/api/session` returns a single `{ id, status }` (`:253-255`), `/api/events` paginates the single session's history (`serveEventHistory`, `:330-346`), `/api/models` (`:267-272`).
- Commands flow back untouched by session: `handleWsMessage` parses a `CommandMessage`, routes settings commands to the control plane, else `this.bus.emitCommand(cmd.command)` (`:421-463`). **Commands carry no session id.**

**Invariant S1 — one WebServer = one bus = one session id, one shared broadcast stream to all clients.**

### 1.4 Client: `web/src/`

- One module-level, session-agnostic `WS_URL` built from `window.location` (+ `VITE_WS_URL`), forwarding only a `token` query param (`web/src/App.tsx:26-34`; `web/src/hooks/buildWsUrl.ts:1-20`). One `useWebSocket(WS_URL)` (`App.tsx:88`) → one `WebSocketClient`.
- `WebSocketClient` tracks a single `this.sessionId` plus `sessionEpoch` (`web/src/hooks/useWebSocket.ts:28-29`). `trackSessionEpoch` bumps the epoch and clears the queued-command buffer whenever a snapshot's `session.id` or a `session_clear`'s `new_session_id` differs from the tracked id (`:195-215`); `flushQueue` drops queued messages whose epoch no longer matches (`:187-193`). `awaitingInitialSnapshot` gates queue flush until the one snapshot arrives (`:116,126-129`).
- One `EventStore` (`web/src/hooks/useEvents.ts:156`) with a single `status.sessionId` string (`:48`). A snapshot **replaces** the whole event array and retargets the session (`processMessage` snapshot case, `:180-230`); `session_clear` wipes the store in place and swaps the id (`:239-244`, `:349-357`). Client live stream caps at `EVENT_CAP` (`:235-237`).
- Derived state is computed by **pure functions of the event array**: `buildAgentTree(events)` (`useAgentTree.ts:36`), `buildAgentStats(events)` (`useAgentStats.ts:59`), `buildTaskList(events)` (`useTaskList.ts:11`), `deriveActiveAgentWork(events, status, sessionId)` (`App.tsx:80-85`). The `StatusBar` renders one `status.sessionId` (`web/src/components/StatusBar.tsx:251,415-424`).

**Invariant C1 — the client models exactly one session: one socket, one `WebSocketClient.sessionId`, one `EventStore`, one `status.sessionId`. "New session" is an in-place id swap of that single session, and cross-session hygiene is done by filtering stale `session_id`-tagged events out of one merged stream — not by routing per session.**

### 1.5 Protocol and the import boundary

- Wire types live in `src/kernel/protocol.ts`: `ServerMessage` = `event | snapshot | settings_updated | settings_result` (`:46-50`); `SnapshotServerMessage.session` carries `{ id, status, availableModels, currentModel, currentSelection, pricingTable }` (`:19-31`); `CommandMessage` wraps a `BrowserCommand` (`:52-58`); `parseCommandMessage` validates kind + shape (`:121-162`). Web imports these via `@kernel/protocol.ts`.
- **Guardrail (load-bearing).** `test/architecture/dependency-boundaries.test.ts:64` forbids non-test `web/src/**` from relative-importing backend source — predicate `isWebDeepImportToBackend` = `/^(\.\.\/)+src\//` (`:31-33`), covering both static and dynamic imports (`:75-82`), test files excluded (`:35-37,70`). Only the `@kernel/*` → `src/kernel` and `@shared/*` → `src/shared` aliases are permitted (`web/vite.config.ts:9-10`, `web/tsconfig.json:19-20`, `web/knip.json:6-7`). **There is no `@host` alias.** Host- and shared-owned types reach the web client only through the re-export bridge at the bottom of `src/kernel/types.ts` — the `export type { ... } from "../host/..." / "../shared/..."` block (in this revision at **`src/kernel/types.ts:553-566`**; the task brief cited `646-659`, which is stale — the block is load-bearing regardless of line number).

**Invariant P1 — any new protocol surface must be declared in `src/kernel/protocol.ts` (or `src/kernel/*`), and any host-owned DTO the client needs (e.g. `SessionListEntry` from `src/host/session-metadata.ts:128-133`) must be added to the `src/kernel/types.ts` re-export bridge. The web client must never deep-import `../src/host/...`.**

### 1.6 Assets already present that the design reuses

- A session catalog on disk: `sessions/<sessionId>.meta.json` (`SessionMetadata`), `logs/<sessionId>.jsonl`, child logs under `logs/<sessionId>/`.
- A **session-list API already exists**: `listSessions(sessionsDir)` (`src/host/session-metadata.ts:136-156`) and `loadSessionSummaries(sessionsDir, logsDir)` → `SessionListEntry[]` with `sessionId, agentSpec, status, turns, contextTokens, createdAt, updatedAt, firstPrompt, lastMessage` (`:128-133,162-174`). It already backs the TUI list picker `runListMode` (`src/host/cli-list.ts:44-68`), whose `onResume(sessionId)` recursively re-runs the CLI as a resume (`src/host/cli-run.ts:99-109`). The resume load path (`loadResumeState` → `loadAllEventLogs`, `src/host/cli-resume.ts`) turns a session's logs into the `initialEvents` the web server already accepts.

---

## 2. The design

### 2.1 Core decision: connection-scoped sessions (one WebSocket per viewed session)

Keep the invariant **"a connection carries exactly one session."** That is precisely what today's snapshot/epoch/queue/`EventStore` machinery already assumes and is tested for (§1.4). Rather than re-address every message with a session id, we make the **connection** the addressing unit: the client opens one `WebSocketClient` per session it is viewing, and the server routes each connection to that session's view.

Concretely:

**Server — extract a `SessionView`, add a `SessionRegistry`.**
- Refactor `src/web/server.ts` so the per-session state currently on `WebServer` (the `events` buffer, `historyCache`/`historyCacheSessionId`, `status`, `sessionScopedEventsRequireIds`, `pendingTaskCliAgents`, snapshot building, event filtering, task seeding) moves into a `SessionView` class. One `SessionView` == today's whole `WebServer` body, minus the HTTP/WS plumbing.
- A `SessionRegistry` maps `sessionId → SessionView`. For the **live** session, the view subscribes to that session's bus (as today). For a **historical** session, the view is log-only: it builds snapshots and paginates from `loadAllEventLogs(logs/<sessionId>.jsonl, logs/<sessionId>/)` and never streams live events.
- At WS upgrade, the server reads `?session=<id>` (defaulting to the live session for back-compat), looks up/creates the `SessionView`, and binds the socket to it. Each `SessionView` keeps its own `wsClients` set and broadcasts only to sockets bound to it. `session_clear` handling stays inside the live view (it already re-targets `new_session_id` in place, `server.ts:163-174`).
- HTTP: generalize `/api/session` and `/api/events` to accept `?session=<id>` (default = live), and add `GET /api/sessions` returning `loadSessionSummaries(sessionsDir, logsDir)`.

**Client — a per-session client registry.**
- Generalize `buildWsUrl`/`WS_URL` to carry `?session=<id>` alongside `token` (`buildWsUrl.ts` gains one param).
- Replace the single `useWebSocket`+`useEvents` pair with a stable **registry** `Map<sessionId, { client: WebSocketClient; store: EventStore }>`, owned in a `useRef` (not per-render `useMemo`), ref-counted so it survives StrictMode's throwaway mount (§2.6). `useEvents`/`useWebSocket` become parameterized by `sessionId`.
- App state adds `activeSessionId`. Only the active session's `store.events` is fed to the render tree and the derivation hooks (which already take an `events` array, so they need no change). Non-active sessions keep a connection (or are hibernated, §2.5) but do not render or run derivations.
- A `useSessions` hook fetches `/api/sessions` for the switcher.

**Answering the protocol questions directly:**
- *Does every message need a session id?* **No.** The connection is the session addressing, so `event`/`snapshot`/`settings_*` messages and `CommandMessage` stay exactly as they are (`snapshot.session.id` already tells the client which session it bound). This is the decisive advantage over multiplexing.
- *How does the client subscribe/unsubscribe to a session's stream?* By **opening/closing a `WebSocketClient`** for that `?session=<id>`. Subscribe = connect; unsubscribe = `dispose()`. No `subscribe`/`unsubscribe` control frames are added to the protocol.
- *New protocol surface:* only (a) the session list — servable as plain HTTP JSON from `/api/sessions`, so no `src/kernel/protocol.ts` change is strictly required; if we later want *live* list updates pushed over WS, add a `SessionListServerMessage` to `src/kernel/protocol.ts` and re-export `SessionListEntry` through `src/kernel/types.ts:553-566` (§1.5, P1); and (b) session lifecycle (create/resume/teardown) — HTTP endpoints or new command kinds (§2.4).

### 2.2 Session-list API + switcher UI

- **API:** `GET /api/sessions` → `SessionListEntry[]` via `loadSessionSummaries(join(projectDataDir,"sessions"), join(projectDataDir,"logs"))`. Same token/origin checks as `/api/events` (`server.ts:257-265`). The live session is flagged (its `status` is `running`/`interrupted` and its id equals the registry's live id).
- **UI:** a `SessionSwitcher` component (a section in the existing `Sidebar`, or a dropdown in the `StatusBar` beside the current 8-char session id at `StatusBar.tsx:415-424`). Each row shows `firstPrompt` (title), `status`, `updatedAt`, and the short id. Selecting a row sets `activeSessionId`; the registry opens that session's connection if not already open.

### 2.3 Per-session client state (events, history cursor, stats)

- **Events + status:** each session gets its own `EventStore`. `EventStore` already encapsulates events, status, settings, and the `session_id` filtering (`useEvents.ts:156-418`) — it just needs to be instantiated per session instead of once.
- **History cursor:** `App.tsx`'s pagination refs (`historyLoadingRef`, `historyHasMoreRef`, `historyBeforeRef`, `:122-125`) already reset on `status.sessionId` change (`:140-146`). Generalize them into per-session cursor state so switching sessions preserves each session's scroll/paging position, and pass `?session=<id>` to `/api/events` (`loadOlderEvents`, `:148-186`).
- **Derived state (tree/stats/tasks/active-work):** unchanged logic — they are pure over `events` (`useAgentTree`, `useAgentStats`, `useTaskList`, `deriveActiveAgentWork`). Only the active session's array is passed in, so per-session isolation is automatic.

### 2.4 Session creation, selection, teardown from the UI

- **Selection:** switcher → set `activeSessionId` → registry focuses/opens that connection.
- **Creation & "make live":** in the near-term single-live model (A), "open/resume session X" means the host must *become* session X. That is the existing resume mechanic (`onResume` → re-run as resume, `cli-run.ts:99-109`), but today it re-runs the whole CLI. Two sub-options:
  - *A-minimal:* the web UI can freely **view** any session read-only; making one **live** is still driven from the host/TUI (or restarts the process on that session). Lowest effort, honest about H1.
  - *A-plus:* add a `SessionController.switchTo(sessionId)` that clears+re-seeds the single controller from that session's persisted history/metadata (a generalization of `/clear`, which already rebuilds metadata/logger/spawner on a new id, `session-controller.ts:621-654`). The web UI triggers it via a new command/HTTP call. Still one live session, but switchable from the browser.
- **Teardown:** closing a session view `dispose()`s its `WebSocketClient` and evicts its `EventStore` from the registry (or hibernates it, §2.5). No host teardown in model A.

### 2.5 Mapping onto the bus's per-session scoping, and interaction with known issues

- **Bus scoping:** for the live view, keep applying `sessionScopedEventApplies` (`server.ts:60-78`) — H2 still holds (a single bus crosses ids on `/clear`). Historical views never touch a bus, so they cannot leak. Under a future concurrent-live model (B), each session owns its own bus, so cross-session leakage becomes impossible by construction and the filter degenerates to a within-session `/clear` guard.
- **Unbounded event accumulation** (architecture audit item 8, `docs/audits/2026-03-05-architecture-design-audit.md:45-47`; live-stream cap since added at `useEvents.ts:235-237`): with N sessions each holding up to `EVENT_CAP` events, worst-case client memory is N×. Mitigations, in priority order: (1) run derivation hooks and render only for the **active** session; (2) **hibernate** non-visible sessions — after a grace period, `dispose()` the socket and drop the `EventStore` to a small status tail, lazily re-hydrating from `/api/events` on refocus; (3) keep the per-store `EVENT_CAP`. This makes multi-session strictly better-behaved than a naive N-store approach.
- **StrictMode WS double-mount** (untested today, per test survey; `WebSocketClient.connect()` is idempotent at `useWebSocket.ts:48`, `dispose()` sets `disposed=true` at `:53-66`, and the hook memoizes one client per URL at `:252,276-281`): with N per-session clients this risk multiplies. The registry must own clients in a **stable ref-counted structure** so StrictMode's mount→unmount→mount does not permanently dispose a still-wanted client (a disposed client's `connect()` early-returns, `:48`). Add the currently-missing StrictMode test (mount → unmount → mount leaves each active session's client connected).

### 2.6 What model B (concurrent live sessions) adds on top

If Jesse wants genuinely concurrent *live* sessions, the client/server/protocol from §2.1 already support it; the missing piece is **host-side**: a `SessionManager` owning `Map<sessionId, { controller: SessionController; bus: SessionBus }>`, created/torn down on demand, replacing the single `opts.runtime.controller`/`opts.runtime.bus` wiring in `src/host/cli-interactive.ts:346-362`. The `SessionRegistry` in the web server then maps live session ids to their buses. This is the large, deferrable chunk (it touches `session-controller.ts`, `cli-interactive.ts`, `cli-run.ts`, the runtime builders, and the TUI, which also assumes one bus). Phases 1–3 deliver the question's literal ask without it.

---

## 3. Tradeoffs: multiplexed WebSocket vs. per-session WebSocket

| | **Per-session WS (recommended)** | **One multiplexed WS** |
|---|---|---|
| Protocol churn | Minimal: connection = session address; `event`/`snapshot`/`command` unchanged. Only `/api/sessions` (+ optional list-push) is new. | Large: every `ServerMessage` and `CommandMessage` gains a `sessionId`; add `subscribe`/`unsubscribe` control frames; `parseCommandMessage` (`protocol.ts:121-162`) and all message handling change. |
| Reuse of tested machinery | High: `awaitingInitialSnapshot` gating, epoch fencing, reconnect/queue (`useWebSocket.ts`), and `EventStore` snapshot/`session_clear` logic are all "one session per connection" already. | Low: the same machinery must be reworked to demux by `sessionId`; the epoch/queue model (`:195-215`) no longer maps to a connection. |
| Server routing | Per-connection `SessionView.wsClients`; broadcast within a view. | Per-client subscription sets; central fan-out of N sessions with head-of-line coupling on one socket. |
| Isolation & failure blast radius | Strong: one session's stream/backpressure can't stall another. | Weaker: one socket shared by all sessions. |
| Global push (live session-list, cross-session notices) | Needs a dedicated control connection or SSE (a real cost). | Natural — one socket already sees everything. |
| Connection count | N sockets for N *viewed* sessions (a handful of tabs → fine). | One socket regardless. |
| Maps to host reality (H1/H2) | Yes — host is "one session per bus"; a connection per session mirrors it. | Forces a multiplex abstraction the host doesn't have. |

**Recommendation: per-session (connection-scoped) WebSocket.** It preserves the exact invariants the current, well-tested code depends on, keeps `src/kernel/protocol.ts` almost unchanged (respecting the P1 boundary — no need to thread a session id through the whole contract), and mirrors the host's one-bus-per-session reality. The multiplex option's single real advantage — one global channel — matters only for pushing live session-list/cross-session updates, and that is recoverable with a **hybrid escape hatch**: one lightweight control connection (or SSE) for the session list, plus per-session data connections. Adopt the hybrid only if/when live list updates become central; until then `/api/sessions` polling on switcher open is enough. The multiplex cost (rewriting the most delicate, most-tested code — `useWebSocket`, `EventStore`, `parseCommandMessage`, the server broadcast path) is not justified for a small number of concurrently-viewed sessions.

---

## 4. Phased plan (file-level, each phase shippable/testable)

Coverage rule for every phase: existing single-session tests are **generalized, not deleted** — a single-session case remains a first-class instance of the multi-session behavior.

### Phase 0 — Extract `SessionView` (pure refactor, zero behavior change)
- `src/web/server.ts`: move per-session fields/methods (`events`, `historyCache`/`historyCacheSessionId`, `status`, `sessionScopedEventsRequireIds`, `pendingTaskCliAgents`, `createSnapshotMessage`, `updateStatus`, event filtering, `serveEventHistory`/`getHistoryEvents`, task seeding) into a new `SessionView` class in `src/web/session-view.ts`. `WebServer` holds exactly one `SessionView`; HTTP/WS plumbing and `broadcast` stay on `WebServer`.
- Tests: `test/web/server.test.ts` stays green unchanged — this phase proves the extraction is behavior-preserving. Optionally add a direct `SessionView` unit test mirroring the buffer-cap and `session_clear` cases (`server.test.ts:1243-1261`, `:394-452`).

### Phase 1 — Session-list API + read-only historical viewing
- `src/web/server.ts`: add `GET /api/sessions` (backed by `loadSessionSummaries`); generalize `/api/session` and `/api/events` to accept `?session=<id>` (default = live). Add a `SessionRegistry` that can build a **log-only** `SessionView` for a historical id (no bus subscription).
- `web/src/hooks/useSessions.ts` (new) + `web/src/components/SessionSwitcher.tsx` (new); render it in `Sidebar`/`StatusBar`. Client can select a historical session and view its snapshot/history read-only.
- Guardrail: if the switcher consumes `SessionListEntry`, add its re-export to `src/kernel/types.ts:553-566` and import via `@kernel/types.ts` — never `../src/host/session-metadata.ts`.
- Tests: extend `test/web/server.test.ts` with `/api/sessions` and id-scoped `/api/events`; the existing single-session `/api/session`/`/api/events` cases (`server.test.ts:253-283,330-346`) become the "default = live" instance. New `useSessions` test.

### Phase 2 — Per-session WebSocket routing
- `web/src/hooks/buildWsUrl.ts` + `App.tsx:26-34`: carry `?session=<id>`. Update `web/src/__tests__/buildWsUrl.test.ts` to cover the session param (keeping the token-only case).
- `src/web/server.ts`: route each WS upgrade to the `SessionView` named by `?session` (live → bus-subscribed; historical → log-only); per-view `wsClients`/broadcast.
- Client: `web/src/hooks/useWebSocket.ts` + `useEvents.ts` parameterized by `sessionId`; a stable ref-counted registry `Map<sessionId,{client,store}>` in `App.tsx` (or a new `web/src/hooks/useSessionRegistry.ts`). `activeSessionId` selects the rendered store.
- Tests (generalize, preserve coverage):
  - `useWebSocket.test.ts` — keep the epoch-reset-on-id-change case (`:297-323`) but scope it per client; **add** the missing StrictMode mount→unmount→mount test (§2.6).
  - `useEvents.test.ts` — "second snapshot replaces first" (`:184-197`) and the `EVENT_CAP` cap (`:320-338`) become per-store; add a two-store isolation test (events for session A never appear in session B's store).
  - `server.test.ts` — "multiple clients receive the same events" (`:676-701`) becomes "clients on the same session share a stream; clients on different sessions are isolated."
  - `App.test.tsx` — `computeActiveWorkForStatus` cases (`:48-102`) run against the active session's store; add a switch-active-session test.

### Phase 3 — Switching UX, per-session lifecycle & memory hygiene
- Wire `SessionSwitcher` selection to `activeSessionId`; add "New session" and "Resume selected" actions. In model A-plus, add `SessionController.switchTo(sessionId)` (generalizing `clearSession`, `session-controller.ts:621-654`) and a command/HTTP trigger; in A-minimal, "make live" is host-driven and the UI only views.
- Teardown/hibernation: `dispose()` + evict/hibernate non-visible `EventStore`s; per-store `EVENT_CAP`; lazy re-hydrate from `/api/events` on refocus (§2.5).
- Tests: switcher interaction; hibernation re-hydration; memory-cap-per-store.

### Phase 4 (optional, larger) — Concurrent live sessions (model B)
- Host: new `src/host/session-manager.ts` owning `Map<sessionId,{controller,bus}>`; rewire `src/host/cli-interactive.ts:346-362`, `cli-run.ts`, runtime builders. Web `SessionRegistry` maps live ids to buses. Add create/teardown surface (HTTP or command kinds; if command kinds, extend `VALID_COMMAND_KINDS`/`parseCommandMessage` in `src/kernel/protocol.ts:60-162`).
- Tests: session-manager lifecycle; two concurrent live sessions with fully isolated buses (cross-session leakage impossible by construction). The TUI's single-bus assumption must be revisited or explicitly scoped to "the manager's foreground session."

---

## 5. Open questions / risks

1. **Which capability does Jesse actually want — A (view/switch, Phases 1–3) or B (concurrent live, Phase 4)?** This is the single biggest scoping decision. The plan front-loads A because it satisfies the literal ask; B is a genuine host refactor.
2. **"Make live from the browser" (A-plus) vs. host-driven (A-minimal).** A-plus adds `SessionController.switchTo` and a control surface; A-minimal keeps making-live in the host/TUI. A-minimal is the smaller, safer first cut.
3. **Live session-list freshness.** Poll `/api/sessions` on switcher open (simple) vs. push updates over a control channel (needs the §3 hybrid). Start with polling.
4. **`SessionListEntry` re-export.** Confirm adding it to the `src/kernel/types.ts` bridge is acceptable, or define a slimmer web-facing DTO in `src/kernel/*` mapped on the server to avoid leaking host metadata shape. Either way, respect the deep-import guardrail (P1).
5. **StrictMode with N clients is currently untested even for N=1** — the registry design must be validated by the new StrictMode test before it ships (§2.6).
