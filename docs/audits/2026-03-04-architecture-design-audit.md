# Architecture/Design Audit (2026-03-04)

Source: subagent `Kant` (`019cba9c-5ff6-75c1-b5c2-1bebf17f0c5c`)
Scope: read-only architecture/design audit across `src/` and `web/`

## 1) Verdict + Confidence
Architecture is functional but overly coupled; current module boundaries across `src/` and `web/` are soft and will raise change cost as features grow.

Confidence: **0.84** (high, based on direct code-path evidence).

## 2) Top Findings (Ordered by Severity)
1. **[Critical] `Agent` is a god-object with too many responsibilities and high blast radius.**
Evidence: `src/agents/agent.ts:1`, `src/agents/agent.ts:121`, `src/agents/agent.ts:420`, `src/agents/agent.ts:1142`

2. **[High] In-process subagents share a mutable primitive registry, creating cross-agent state bleed and name-collision risk.**
Evidence: `src/agents/factory.ts:114`, `src/agents/factory.ts:152`, `src/agents/agent.ts:481`, `src/agents/agent.ts:814`

3. **[High] Delegation logic is duplicated in two engines (in-process vs spawner), inviting behavior drift.**
Evidence: `src/agents/agent.ts:420`, `src/agents/agent.ts:572`, `src/agents/agent.ts:1024`

4. **[High] `web/` is tightly coupled to backend internals via deep relative imports, not a stable shared contract.**
Evidence: `web/src/App.tsx:3`, `web/src/components/InputArea.tsx:10`, `web/src/hooks/useEvents.ts:2`, `web/src/hooks/useWebSocket.ts:2`

5. **[High] Command boundary is weakly validated end-to-end; unknown kinds can reach unchecked dispatch.**
Evidence: `src/web/protocol.ts:31`, `src/web/server.ts:219`, `src/host/session-controller.ts:276`, `src/host/session-controller-commands.ts:13`

6. **[Medium-High] Event architecture does repeated full-array work and multi-copy buffering; long sessions will degrade UI performance.**
Evidence: `src/kernel/constants.ts:2`, `src/web/server.ts:91`, `src/web/server.ts:196`, `web/src/hooks/useEvents.ts:68`, `web/src/components/groupEvents.ts:117`

7. **[Medium-High] `Genome` is a persistence/gitrepo/sync/tool-loader/postscript monolith.**
Evidence: `src/genome/genome.ts:1`, `src/genome/genome.ts:21`, `src/genome/genome.ts:65`, `src/genome/genome.ts:391`, `src/genome/genome.ts:560`

8. **[Medium] Layer ownership is blurred: lower layers depend on `host` logger namespace.**
Evidence: `src/host/logger.ts:1`, `src/llm/logging-middleware.ts:1`, `src/learn/learn-process.ts:57`, `src/web/server.ts:23`

9. **[Medium] Dependency/version drift between root and `web/` increases behavioral divergence risk.**
Evidence: `package.json:47`, `package.json:49`, `web/package.json:14`, `web/package.json:15`

10. **[Medium-Low] Circular dependency in web tool renderer registry reduces modular safety and clarity.**
Evidence: `web/src/components/tools/ToolRendererRegistry.ts:2`, `web/src/components/tools/ReadFileRenderer.tsx:2`, `web/src/components/tools/EditFileRenderer.tsx:1`, `web/src/components/tools/ExecRenderer.tsx:2`

## 3) Practical Remediation Plan (30/60/90, YAGNI + DRY)
1. **30 days (stabilize boundaries, low-risk extractions):**
Create a minimal shared contract module for `Command`, `SessionEvent`, `ServerMessage`, and slash-command parsing; stop `web/` deep-importing backend internals. Add strict command-kind runtime validation before controller dispatch. Add a client-side event cap plus incremental derivation hooks for status/tree/stats.
Do not do: no protocol rewrite, no framework migration, no big architecture overhaul.

2. **60 days (remove duplication and hidden shared state):**
Unify delegation flow behind one `DelegationEngine` interface with two adapters (in-process/spawner), keeping one verification/learn path. Make primitive registries agent-scoped (or copy-on-write) so tool registration cannot leak across agents. Move repeated CLI/web orchestration glue into one reusable session-runtime service.
Do not do: no DI container, no plugin platform, no speculative abstractions beyond current use cases.

3. **90 days (targeted decomposition + guardrails):**
Split `Genome` into focused collaborators (`GenomeGitStore`, `AgentRepository`, `ToolRepository`, `RootSyncService`) without changing behavior. Reduce public surface (`src/index.ts`/deprecated exports) to intentional APIs. Add architecture guard tests (import-boundary checks + cycle checks) to prevent regression. Align root/web dependency versions where behavior must match.
Do not do: no microservices split, no full rewrite of `Agent` runtime in one shot.

## 4) Residual Risks
Even after this plan, three risks remain:
- provider SDK volatility (some adapter `any` usage may persist)
- long-session rendering pressure (may still need virtualization for extreme traces)
- migration risk around session/log replay semantics while untangling `Genome` and runtime boundaries
