## 1) Verdict + confidence (0-1)
Jesse, the repository is materially improved after remediation, but still has **moderate architectural risk at runtime boundaries** (command ingress, bus fanout, client/server state contract).  
**Verdict:** `Conditionally sound; not yet hard-boundary-safe for long-lived/hostile conditions.`  
**Confidence:** `0.86` (code inspection + targeted runtime probes, no full-suite execution in this audit).

## 2) Top findings ordered by severity (at least 8 findings) with concrete evidence references as file:line
1. **High: Command boundary accepts unknown kinds, then dispatch path can throw at runtime.**  
Evidence: parser intentionally does not validate command kind at runtime ([src/kernel/protocol.ts:37](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/kernel/protocol.ts:37), [src/kernel/protocol.ts:66](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/kernel/protocol.ts:66)); tests assert unknown kinds pass through ([test/web/protocol.test.ts:146](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/test/web/protocol.test.ts:146)); controller dispatches directly by key with no guard ([src/host/session-controller.ts:277](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/session-controller.ts:277)).  
Residual risk: malformed/forward-compat commands can break command handling and be silently dropped upstream.

2. **High: Event bus fanout is synchronous and not listener-isolated. One bad listener can block all others.**  
Evidence: no try/catch around listener invocation in events and commands ([src/host/event-bus.ts:59](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/event-bus.ts:59), [src/host/event-bus.ts:74](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/event-bus.ts:74)).  
Residual risk: observability, metadata, and UI sinks can fail together due to one throwing subscriber.

3. **High: Snapshot contract drift in web client (status/currentModel ignored).**  
Evidence: server snapshot includes `status` and `currentModel` ([src/web/server.ts:199](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/web/server.ts:199)); EventStore only keeps `sessionId`/`availableModels` from snapshot and recomputes status from replayed events ([web/src/hooks/useEvents.ts:55](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useEvents.ts:55), [web/src/hooks/useEvents.ts:88](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useEvents.ts:88)).  
Residual risk: reconnect/truncated-history scenarios can render wrong run status/model.

4. **High: `/clear` path drops model catalog in UI state, disabling model selector until reconnect.**  
Evidence: `session_clear` resets to `INITIAL_STATUS` and only restores `sessionId` ([web/src/hooks/useEvents.ts:113](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useEvents.ts:113)); selector only appears when `availableModels.length > 0` ([web/src/components/StatusBar.tsx:129](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/components/StatusBar.tsx:129)).  
Residual risk: model control silently disappears mid-session.

5. **Medium-High: In-process subagents share one mutable primitive registry; tool names can collide/override across agents.**  
Evidence: child agent reuses parent registry ([src/agents/agent.ts:541](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/agents/agent.ts:541)); child run registers workspace tools dynamically ([src/agents/agent.ts:891](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/agents/agent.ts:891)); register is map overwrite by name ([src/kernel/primitives.ts:54](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/kernel/primitives.ts:54)).  
Residual risk: wrong tool implementation can execute when names overlap.

6. **Medium-High: Session-wide child-event subscription failures are logged but not fail-closed.**  
Evidence: subscription failure is caught/logged in constructor ([src/host/session-controller.ts:231](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/session-controller.ts:231)); submit waits on that promise but proceeds even after caught failure ([src/host/session-controller.ts:380](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/session-controller.ts:380)).  
Residual risk: subprocess events can disappear while runs appear successful.

7. **Medium: WebSocket client replays queued commands after reconnect without session/epoch fencing.**  
Evidence: offline queue stores arbitrary commands ([web/src/hooks/useWebSocket.ts:70](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useWebSocket.ts:70)); reconnect flushes queue wholesale ([web/src/hooks/useWebSocket.ts:109](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useWebSocket.ts:109), [web/src/hooks/useWebSocket.ts:143](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useWebSocket.ts:143)); session can change via `session_clear` ([web/src/hooks/useEvents.ts:113](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useEvents.ts:113)).  
Residual risk: stale commands can mutate a new session.

8. **Medium: Client event state is unbounded and recomputed broadly, risking long-session UI degradation.**  
Evidence: events append with no cap ([web/src/hooks/useEvents.ts:68](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useEvents.ts:68)); full-list recomputation in conversation/tree/stats ([web/src/components/ConversationView.tsx:28](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/components/ConversationView.tsx:28), [web/src/hooks/useAgentTree.ts:185](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useAgentTree.ts:185), [web/src/hooks/useAgentStats.ts:143](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/hooks/useAgentStats.ts:143)); server-side buffer is capped but client live stream is not ([src/web/server.ts:91](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/web/server.ts:91)).  
Residual risk: memory/CPU creep on long sessions.

9. **Medium: Internal bus server has no auth/topic ACL; any local client can publish arbitrary topics.**  
Evidence: accepts WS upgrade broadly ([src/bus/server.ts:62](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/bus/server.ts:62)); publish forwards to any topic without authorization checks ([src/bus/server.ts:150](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/bus/server.ts:150)).  
Residual risk: same-host adversary can spoof results/events/commands.

10. **Low-Medium: Streaming indicator heuristic is explicitly fragile for interleaved multi-agent streams.**  
Evidence: TODO and last-event-only check ([web/src/components/ConversationView.tsx:33](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/components/ConversationView.tsx:33), [web/src/components/ConversationView.tsx:36](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/web/src/components/ConversationView.tsx:36)).  
Residual risk: misleading “is responding” banner state.

## 3) Biggest architectural wins to pursue next (prioritized)
1. **Harden wire contracts first (highest leverage):** add shared runtime schemas for WS command/snapshot payloads and enforce unknown-command fallback, not throw-path dispatch.
2. **Make snapshot authoritative + session-epoch aware:** consume `snapshot.session.status/currentModel`; keep `availableModels` across `session_clear`; add epoch/version to drop stale queued commands.
3. **Isolate bus listener failures:** wrap listener fanout so one subscriber cannot break the rest; surface per-listener fault telemetry.
4. **Isolate tool registries by agent/run scope:** avoid global mutable registry sharing between parent/child in in-process mode.
5. **Bound client state + incremental selectors:** cap event store and move tree/stats/formatting to incremental updates.

**Regressions already avoided by recent remediation (good):**
- Session-wide O(1) subprocess event wiring and race closure ([src/host/session-controller.ts:226](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/session-controller.ts:226), [src/host/session-controller.ts:377](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/session-controller.ts:377)).
- `/clear` generation guard to avoid stale-finally clobber ([src/host/session-controller.ts:192](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/session-controller.ts:192), [src/host/session-controller.ts:449](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/host/session-controller.ts:449)).
- Start/ready handshake to prevent inbox race ([src/bus/spawner.ts:251](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/bus/spawner.ts:251), [src/bus/agent-process.ts:282](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/bus/agent-process.ts:282)).
- Web token+origin hardening ([src/web/server.ts:67](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/web/server.ts:67), [src/web/server.ts:113](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/web/server.ts:113), [src/web/server.ts:285](/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/src/web/server.ts:285)).

## 4) Explicit non-recommendations (what NOT to do, YAGNI/DRY)
- **Do not** rewrite this into external broker/microservices yet; boundary hardening inside current process model gives more return now.
- **Do not** add backward-compat command aliases ad hoc (`text` + `message` + etc.) without one enforced schema and deprecation plan.
- **Do not** increase event retention blindly to “fix” UI gaps; fix contract/state flow first, then cap intentionally.
- **Do not** duplicate protocol logic across frontend/backend; keep one canonical contract path (types + runtime validation).
- **Do not** introduce heavy observability platforms before making bus delivery failure-isolated and deterministic.