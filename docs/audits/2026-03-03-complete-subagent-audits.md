# Complete Subagent Audits (2026-03-03)

This document preserves the full output from three independent read-only audits:
- Architecture/Design audit (`Tesla`)
- Design-concept audit (`Ohm`)
- Code-quality audit (`Avicenna`)

---

## Architecture/Design Audit (`Tesla`)

Jesse, I ran a read-only audit plus a full suite timing run (`bun test`), and reviewed architecture/test code in detail.

**Verdict**
`mixed` (confidence: `0.84`)

Evidence point: full suite is currently `90.586s` for 1,977 tests (`/tmp/sprout-junit.xml:2`).

**Top 10 Findings (Most Severe First)**

1. **[Critical] `Agent` is a God object with cross-layer coupling**
Evidence: `src/agents/agent.ts:1`, `src/agents/agent.ts:7`, `src/agents/agent.ts:975`, `src/agents/agent.ts:1240`
Why it matters: planning, retries, delegation, primitive execution, learning, compaction, and logging are all in one class (1344 LOC), so changes are risky and hard to isolate.
Concrete fix: split into `PlanLoop`, `DelegationExecutor`, `PrimitiveExecutor`, `HistoryManager`, and `EventSink` interfaces; keep `Agent` as thin coordinator.

2. **[Critical] `Genome` combines too many responsibilities and commits on every mutation**
Evidence: `src/genome/genome.ts:50`, `src/genome/genome.ts:146`, `src/genome/genome.ts:391`, `src/genome/genome.ts:510`, `src/genome/genome.ts:631`
Why it matters: CRUD, sync/reconcile, workspace tools/files, postscripts, rollback, and git plumbing are tightly coupled; throughput and test speed suffer from heavy I/O.
Concrete fix: split into `GenomeStore` (read/write), `GenomeVersioning` (git), `GenomeSyncService`, and `WorkspaceService`; batch commits by transaction.

3. **[High] Agent startup path is expensive and repeated**
Evidence: `src/agents/factory.ts:65`, `src/agents/factory.ts:115`, `src/agents/factory.ts:122`, `src/agents/factory.ts:141`
Why it matters: disk sync, docs load, postscripts load, model discovery, and tree scan happen during creation; this inflates runtime for each session/spawn.
Concrete fix: create a cached `RuntimeContext` per session/process (agent tree, preambles, model map, docs) and pass it into agent creation.

4. **[High] Process-per-delegation design will bottleneck at scale**
Evidence: `src/bus/spawner.ts:81`, `src/bus/agent-process.ts:83`, `src/bus/agent-process.ts:112`, `src/bus/agent-process.ts:150`
Why it matters: each delegation pays process startup + genome/docs/tree loading cost; that becomes multiplicative under fan-out.
Concrete fix: move to a worker pool (warm processes) with per-session cached context; keep spawn-per-task only for strict isolation cases.

5. **[High] Event buffering/payload strategy risks memory growth and slow resume/snapshots**
Evidence: `src/kernel/constants.ts:2`, `src/host/event-bus.ts:55`, `src/web/server.ts:72`, `src/web/server.ts:185`, `src/agents/agent.ts:1048`, `src/host/resume.ts:12`
Why it matters: large event payloads are duplicated in memory and replayed from full-file reads; long sessions will degrade reconnect/resume latency.
Concrete fix: store compact event summaries in memory/web snapshots, stream detailed logs from disk on demand (pagination).

6. **[High] Test runtime is dominated by real waits/backoff instead of deterministic clocks**
Evidence: `/tmp/sprout-junit.xml:2`, `test/bus/genome-service.test.ts:187`, `test/agents/llm-events.test.ts:370`, `test/agents/llm-events.test.ts:561`, `test/llm/retry.test.ts:425`, `src/llm/retry.ts:88`, `src/agents/agent.ts:975`
Why it matters: slow CI and higher flake probability. Biggest single test is ~5s; several are 1-3.8s.
Concrete fix: inject timer/scheduler abstractions and use fake timers; add fast retry config in tests (`baseDelayMs` near 1-5ms, `jitter:false`, reduced retries).

7. **[Medium-High] `SessionController` and `cli.ts` are overloaded orchestration hubs**
Evidence: `src/host/session-controller.ts:157`, `src/host/session-controller.ts:235`, `src/host/cli.ts:607`, `src/host/cli.ts:774`, `src/host/cli.ts:1065`
Why it matters: change blast radius is large; unit tests become heavy and behavior coupling grows.
Concrete fix: split into dedicated modules: `CliParser`, `CliRuntime`, `WebLifecycle`, `ResumeService`, `SignalHandler`, and `SessionOrchestrator`.

8. **[Medium] Test maintainability is poor due oversized files and duplicated helpers**
Evidence: `test/agents/agent.test.ts`, `test/host/session-controller.test.ts`, `test/web/server.test.ts:12`, `test/web/e2e.test.ts:23`, `web/src/hooks/useWebSocket.test.ts:12`
Why it matters: brittle tests, repetitive setup, harder review/debug.
Concrete fix: introduce shared test harness modules (`test/helpers/ws.ts`, `test/helpers/agent-fixtures.ts`) and split mega-tests by behavior area.

9. **[Medium] Unit vs integration split is filename/grep driven and fragile**
Evidence: `package.json:16`, `package.json:17`
Why it matters: easy to accidentally skip or misclassify tests as file names evolve.
Concrete fix: move to directory/tag-based classification and explicit Bun patterns for each lane.

10. **[Medium] Tests depend on machine-specific dotenv paths**
Evidence: `test/agents/factory.test.ts:11`, `test/agents/agent.test.ts:20`, `test/integration/e2e.test.ts:12`
Why it matters: portability/reproducibility risk (CI and teammate machines), plus noisy side effects.
Concrete fix: centralized test bootstrap with deterministic env (`.env.test`) and adapter mocks by default.

**30/60/90 Day Plan**

**30 days**
1. Cut test runtime from ~90s to <55s by replacing real sleeps/backoff in top offenders (`llm-events`, `retry`, `genome-service`, websocket reconnection tests).
2. Add a strict test lane split (`unit`, `integration`, `e2e`) with stable globs/tags.
3. Create shared test harness modules for websocket/timer/setup duplication.
4. Write an architecture ADR defining layer boundaries (`host` should not be imported by `agents`).

**60 days**
1. Refactor agent creation into `BootstrapContext` + lightweight `createAgentFromContext`.
2. Split `Agent` into focused components (planning/delegation/primitive execution/history).
3. Split `cli.ts` into parser/runtime/web/signal modules.
4. Make resume/snapshot paths stream-based and paginated.

**90 days**
1. Rework genome persistence into transactional batching (fewer git commits, clearer domain/persistence separation).
2. Introduce worker pool for delegated agents to avoid process-per-task overhead.
3. Reduce in-memory event footprint with compact event models and lazy detail fetch.
4. Add architectural fitness tests (dependency rules + performance budgets in CI).

No files were modified during this audit.

---

## Design-Concept Audit (`Ohm`)

Jesse, I ran a read-only concept audit of the repo.

**1) Concept Verdict**
`mixed`
The core concept is strong: there is a clear event-driven runtime, recursive agent architecture, and an extensible genome model. But conceptual coherence is being eroded by contract drift (docs/prompts vs code), split learning pathways, and a few high-impact safety/operational failure modes.

**2) Design-Level Findings (10)**
1. Frontend/runtime boundary is clean and coherent. CLI/TUI/Web all drive one command/event contract, which is a solid mental model for developers.
Evidence: `src/host/event-bus.ts:15`, `src/host/session-controller.ts:227`, `src/web/server.ts:70`.

2. Orchestrator vs worker behavior is enforced in runtime, not just prompt text. Agents either delegate or use primitives, and zero-tool agents fail hard.
Evidence: `src/agents/agent.ts:201`, `src/agents/agent.ts:217`, `src/agents/agent.ts:820`.

3. Genome overlay + reconciliation is conceptually viable for long-term extensibility and auditability.
Evidence: `src/genome/genome.ts:117`, `src/genome/genome.ts:391`, `src/genome/export-learnings.ts:41`.

4. Delegation resolution is powerful but cognitively heavy: auto-discovered children + explicit refs + dynamic runtime paths. This increases flexibility but makes behavior less predictable.
Evidence: `src/agents/loader.ts:107`, `src/agents/resolver.ts:35`, `root/agents/quartermaster/resources/agent-tree-spec.md:170`.

5. Documentation is materially out of sync with implementation (capabilities/YAML/enum assumptions), which weakens developer mental model and maintainability.
Evidence: `docs/DELEGATION_DATA_STRUCTURES.md:17`, `docs/ROOT_AGENT_DELEGATION_ARCHITECTURE.md:76`, `src/kernel/types.ts:58`, `src/agents/markdown-loader.ts:40`.

6. Prompt contract drift exists inside runtime preambles: orchestrator preamble says `delegate_task`, runtime tool is `delegate`. That can cause tool-use errors.
Evidence: `root/preambles/orchestrator.md:2`, `src/agents/plan.ts:9`.

7. Root’s declared static `agents` list and its narrative routing guidance conflict with effective runtime visibility (tree auto-discovery), which makes “who can root call?” harder to reason about.
Evidence: `root/root.md:6`, `root/root.md:39`, `src/agents/factory.ts:143`.

8. Bus-based learning path appears partially wired: subprocesses emit `learn_signal`, mutation service listens for `mutation_request`. Conceptually this is an incomplete contract.
Evidence: `src/bus/learn-forwarder.ts:9`, `src/bus/learn-forwarder.ts:22`, `src/bus/genome-service.ts:57`.

9. Remote web mode is high risk: `--host 0.0.0.0` is supported and origin checks are relaxed there, with no auth layer shown. That is a conceptual deployment safety gap.
Evidence: `src/host/cli.ts:321`, `src/web/server.ts:94`.

10. Operational/safety edge cases remain: path constraints don’t cover `apply_patch`, bus subscribe ack has no timeout, and web server session id is fixed while client can switch on `session_clear`.
Evidence: `src/kernel/path-constraints.ts:5`, `src/agents/plan.ts:142`, `src/bus/client.ts:83`, `src/bus/client.ts:197`, `src/web/server.ts:53`, `web/src/hooks/useEvents.ts:112`.

**3) Biggest Conceptual Risks (and practical failure points)**
1. Remote command/control exposure via web mode.
Where it fails: a non-local client can issue session commands that eventually execute shell/file actions.

2. Contract drift between docs/prompts and code.
Where it fails: agents and developers follow stale interfaces (`capabilities`, `delegate_task`, old storage assumptions), causing wrong tool calls and harder debugging.

3. Split/unclear learning pipeline semantics.
Where it fails: subprocess-generated learning signals may not be processed as intended, reducing actual “self-improving” behavior despite architectural claims.

4. Over-flexible delegation addressing.
Where it fails: hard-to-predict delegation sets and runtime path behavior produce inconsistent orchestration and policy reasoning.

**4) Recommended Simplifications (YAGNI-friendly) + North-Star Principles**
1. Pick one learning path for now. Either remove bus mutation service/forwarder until needed, or implement one canonical bus message contract end-to-end.
2. Make delegation visibility explicit and deterministic. Prefer one source: static `agents` plus validated tree resolution, not multiple implicit paths.
3. Harden web mode by default. Keep localhost-only as default, require explicit auth token for any non-local bind.
4. Move write-policy enforcement to a single low-level mutating gate so `write_file`, `edit_file`, `apply_patch`, and tool scripts are uniformly constrained.
5. Create one authoritative architecture contract doc generated from current types/code paths; retire stale delegation docs.
6. Remove stale prompt fragments (for example, `delegate_task`) and test preambles as part of CI.

North-star principles:
1. One concept, one contract, one implementation path.
2. Security defaults must match likely operator behavior.
3. Determinism over flexibility in core orchestration.
4. Self-improvement claims should map to one observable runtime pipeline.

No files were modified.

---

## Code-Quality Audit (`Avicenna`)

Jesse,

**1) Overall rating and confidence**
- **Rating:** **B-**
- **Confidence:** **0.77 (medium-high)**
- Baseline signal: `bun run test:unit` passed (`1535` tests), but `bun run typecheck` fails in 2 test files and `bun run lint` reports 2 warnings.

**2) Top 12 findings (by severity, with evidence)**

1. **Critical: `allowed_write_paths` can be bypassed via `apply_patch` (and OpenAI provider aliasing).**
Evidence: `src/kernel/path-constraints.ts#L6`, `src/kernel/path-constraints.ts#L35`, `src/kernel/primitives.ts#L228`, `src/kernel/primitives.ts#L355`, `src/kernel/primitives.ts#L370`, `src/agents/plan.ts#L142`.
Impact: write-boundary guarantees are not reliable for agents expected to be constrained.

2. **High: interrupted runs are reported as successful in `session_end`.**
Evidence: abort branch breaks loop at `src/agents/agent.ts#L925`, success computed without abort state at `src/agents/agent.ts#L1322`, emitted at `src/agents/agent.ts#L1325`.
Impact: downstream metrics/UI can misclassify interrupted work as success.

3. **High: turn count can increment twice on truncation path (`finish_reason === "length"`).**
Evidence: loop increment at `src/agents/agent.ts#L904`, extra increment in truncation branch at `src/agents/agent.ts#L1087`.
Impact: early `max_turns` exhaustion and distorted stumble/turn metrics.

4. **High: weak command boundary when web server is exposed (`--host 0.0.0.0`).**
Evidence: origin checks skipped for `0.0.0.0` at `src/web/server.ts#L95`, commands forwarded directly at `src/web/server.ts#L208`.
Impact: if exposed on a network, command channel is effectively unauthenticated.

5. **High-Medium: `useWebSocket` does not react to URL changes.**
Evidence: client created once at `web/src/hooks/useWebSocket.ts#L170`, effect keyed by `client` not `url` at `web/src/hooks/useWebSocket.ts#L197`.
Impact: stale socket connection when endpoint/session URL changes.

6. **Medium: typecheck gate is currently red in tests.**
Evidence: failing timer mocks in `test/tui/app.test.tsx#L455` and `test/tui/input-area.test.tsx#L443`.
Impact: CI reliability and trust in static checks are reduced.

7. **Medium: test coverage misses the safety-critical `apply_patch` constraint path.**
Evidence: constraint tests cover `write_file`/`edit_file` only at `test/kernel/path-constraints.test.ts#L75` while runtime supports `apply_patch` at `src/kernel/primitives.ts#L228`.
Impact: the boundary regression in finding #1 was not caught by tests.

8. **Medium: logging persistence failures are swallowed silently.**
Evidence: write chain errors ignored at `src/host/logger.ts#L251`.
Impact: operational blind spots when disk/path issues occur.

9. **Medium: project root resolution likely wrong for git worktrees (inference).**
Evidence: uses `git rev-parse --git-common-dir` and parent directory at `src/host/cli.ts#L87`, `src/host/cli.ts#L94`.
Impact: project data could be keyed to the main repo path instead of the active worktree path.

10. **Medium: duplicated log-replay logic across host and bus layers.**
Evidence: `src/host/resume.ts#L30` and `src/bus/resume.ts#L137`.
Impact: drift risk when event schema evolves.

11. **Medium: outbound WS queue is unbounded while disconnected.**
Evidence: queue definition at `web/src/hooks/useWebSocket.ts#L19`, enqueue behavior at `web/src/hooks/useWebSocket.ts#L58`.
Impact: memory growth under prolonged disconnect + frequent sends.

12. **Medium-Low: core complexity hotspots are concentrated in monolithic flows.**
Evidence: `Agent.runLoop` starts at `src/agents/agent.ts#L892` and handles planning/execution/verification/compaction/logging; `runCli` starts at `src/host/cli.ts#L607` and mixes infra startup, web, TUI, signals, and command handling.
Impact: higher regression risk and slower change velocity.

**3) Prioritized remediation**

- **Quick wins (<=1 day)**
1. Fix `runLoop` interruption/success semantics and remove double turn increment.
2. Add `apply_patch` to write-constraint enforcement (including `moveTo`) and add focused tests.
3. Fix the two timer mock typings so `bun run typecheck` is green.
4. Make `useWebSocket` recreate client on URL change and cap queued outbound messages.

- **Medium (<=1 week)**
1. Add explicit auth/CSRF boundary for web command channel when binding non-localhost.
2. Add timeout/error propagation for bus subscribe acknowledgments.
3. Consolidate replay parsing into one shared utility (`host` + `bus`).
4. Make logger write failures observable (counter/event/stderr fallback).

- **Structural (<=1 month)**
1. Split `Agent.runLoop` into smaller orchestrated units (plan, act, verify, compaction, end-state).
2. Split `runCli` into command handlers + runtime bootstrap modules.
3. Add boundary-focused test suites for constrained writes, provider alignment, and exposed web mode.

**4) High-quality areas to preserve**

1. Strict TypeScript posture is strong: `tsconfig.json#L17`, `tsconfig.json#L20`, `tsconfig.json#L22`.
2. Test breadth is excellent (`1535` unit tests passing) and should be kept as a release gate.
3. Static serving has traversal protection: `src/web/server.ts#L164`.
4. Event buffer caps prevent unbounded growth: `src/host/event-bus.ts#L56`, `src/web/server.ts#L73`.
5. Exec env filters sensitive env vars before subprocess execution: `src/kernel/execution-env.ts#L33`, `src/kernel/execution-env.ts#L160`.
6. Spawner enforces handle ownership checks: `src/bus/spawner.ts#L293`, `src/bus/spawner.ts#L335`.

No files were modified; this was a read-only audit.
