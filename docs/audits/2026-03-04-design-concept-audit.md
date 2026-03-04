# Design-Concept Audit (2026-03-04)

Source: subagent `Harvey` (`019cba9c-608a-7c23-b984-6df3bddbf5c9`)
Scope: read-only conceptual coherence and contract-drift audit

## 1) Concept Verdict
The product/runtime concept is **partially coherent but contract-fractured**: core mechanics are strong, but delegation rules, safety/determinism claims, and key docs/prompts drift from actual runtime behavior.

## 2) Top Findings (Ordered by Severity)
1. **[Critical] Delegation boundaries are not enforced in runtime.**
Evidence: `src/agents/agent.ts:395`, `src/agents/agent.ts:1000`, `src/agents/plan.ts:328`, `src/agents/agent.ts:438`, `docs/ROOT_AGENT_DELEGATION_ARCHITECTURE.md:123`, `docs/DELEGATION_DATA_STRUCTURES.md:519`

2. **[Critical] `qm-indexer` prompt contract is impossible under current runtime “delegate OR primitives” rule.**
Evidence: `root/agents/quartermaster/agents/qm-indexer.md:5`, `root/agents/quartermaster/agents/qm-indexer.md:10`, `src/agents/agent.ts:223`, `src/agents/agent.ts:225`

3. **[High] `--genome-path` conflicts with hardcoded quartermaster write paths.**
Evidence: `README.md:271`, `src/host/cli.ts:17`, `src/host/cli.ts:263`, `root/agents/quartermaster/agents/qm-indexer.md:17`, `root/agents/quartermaster/agents/qm-fabricator.md:16`, `src/kernel/path-constraints.ts:34`

4. **[High] Source-of-truth drift (copy-based docs vs overlay-based runtime).**
Evidence: `docs/architecture.md:60`, `src/genome/genome.ts:117`, `src/genome/genome.ts:375`, `src/genome/genome.ts:381`

5. **[High] Delegation docs are internally inconsistent and stale.**
Evidence: `docs/DELEGATION_DATA_STRUCTURES.md:5`, `docs/DELEGATION_CODE_FLOW.md:169`, `docs/DELEGATION_CODE_FLOW.md:263`, `docs/QUICK_START_DELEGATION_GUIDE.md:72`

6. **[High] “Immutable 8 primitives” concept no longer matches runtime.**
Evidence: `README.md:21`, `docs/architecture.md:30`, `src/kernel/primitives.ts:83`, `src/agents/agent.ts:801`, `src/agents/agent.ts:814`

7. **[Medium] Safety contract is narrower than implied.**
Evidence: `src/kernel/path-constraints.ts:5`, `src/kernel/path-constraints.ts:35`, `src/kernel/primitives.ts:629`, `src/kernel/primitives.ts:675`, `src/kernel/primitives.ts:752`, `README.md:96`

8. **[Medium] “Every mutation committed” claim misses behavior-affecting memory updates.**
Evidence: `README.md:20`, `src/genome/recall.ts:24`, `src/genome/genome.ts:251`

9. **[Medium] Learn trigger contract drift + stochastic mechanics reduce determinism.**
Evidence: `README.md:22`, `src/learn/should-learn.ts:12`, `src/learn/should-learn.ts:22`, `src/learn/learn-process.ts:385`, `src/learn/learn-process.ts:443`

10. **[Medium] Model-tier docs imply fixed mapping while runtime mapping is live/dynamic.**
Evidence: `README.md:137`, `src/agents/factory.ts:122`, `src/llm/client.ts:94`, `src/agents/model-resolver.ts:13`, `src/agents/model-resolver.ts:63`

## 3) Biggest Conceptual Risks
- Policy bypass risk: declared delegation topology is not enforceable at runtime.
- Operational fragility risk: quartermaster workflows can fail in non-default genome-path setups.
- Safety/audit overstatement risk: docs overstate path-constraint and commit guarantees.
- Team alignment risk: conflicting docs/prompts/contracts drive wrong fixes and reviews.

## 4) Simplification Recommendations (YAGNI + Determinism)
1. Enforce a single delegation rule in code: default strict allowlist (`children + spec.agents`) with one explicit opt-in for dynamic delegation.
2. Remove agent-name-as-tool auto-correction; require explicit `delegate(...)` calls.
3. Pick one orchestrator capability model: delegate-only or mixed-mode. For YAGNI, make `qm-indexer` leaf and remove delegation from it.
4. Eliminate hardcoded home paths from agent specs; derive from runtime (`SPROUT_GENOME_PATH` or injected env).
5. Publish one canonical runtime contract doc and deprecate stale delegation docs.
6. Add deterministic mode toggle: disable Learn by default in deterministic runs, pin model mapping per session, and document as reproducible baseline.
