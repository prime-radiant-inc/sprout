# Code-Quality Audit (2026-03-04)

Source: subagent `Dalton` (`019cba9c-6028-72d1-92fe-7b481943275b`)
Scope: read-only correctness/maintainability/test-quality audit

## 1) Overall Grade + Confidence
- Grade: **B-**
- Confidence: **Medium-high**
- Health snapshot from audit run:
  - `lint`: pass
  - `typecheck`: pass
  - `bun test`: pass (**2053 tests / 129 files / 38.55s**)
  - `test:unit:parallel`: pass
  - `test:integration`: pass
  - `test:parallel`: failed
  - `web:build`: failed

## 2) Findings (Ordered by Severity)
1. **[High] Interrupt handling race can miss cancellation under load.**
Evidence: `src/host/session-controller.ts:359`, `src/host/session-controller.ts:406`, `src/host/session-controller.ts:440`, `test/host/session-controller.test.ts:201`

2. **[High] Secret env filtering misses `GOOGLE_API_KEY`, risking leakage to subprocess env.**
Evidence: `src/kernel/execution-env.ts:33`, `src/kernel/execution-env.ts:39`, `src/llm/client.ts:68`, `README.md:130`

3. **[High] Fast full-suite path is unreliable (`test:parallel` fails while `bun test` passes).**
Evidence: `scripts/test-parallel.sh:41`, `test/host/session-controller.test.ts:201`

4. **[Medium] Frontend source is not linted by Biome.**
Evidence: `biome.json:10`

5. **[Medium] Pre-commit test gate excludes `web/src` tests.**
Evidence: `.githooks/pre-commit:25`, `scripts/test-unit-files.sh:20`, `scripts/test-parallel.sh:41`

6. **[Medium] Web build path broken after documented setup (`vite: command not found` during audit).**
Evidence: `README.md:123`, `README.md:224`, `package.json:25`, `web/package.json:8`, `web/package.json:23`

7. **[Medium] Integration test selection is hardcoded and drift-prone.**
Evidence: `scripts/test-integration-files.sh:4`

8. **[Medium] Browser auto-open is macOS-only (`open`).**
Evidence: `src/host/cli-interactive.ts:151`, `src/host/cli-interactive.ts:249`

9. **[Medium] Conversation streaming state remains fragile for multi-agent interleaving.**
Evidence: `web/src/components/ConversationView.tsx:33`, `web/src/components/ConversationView.tsx:36`

10. **[Medium] Fixed sleeps/fixed delays increase flake risk under CPU contention.**
Evidence: `test/host/session-controller.test.ts:151`, `test/host/session-controller.test.ts:196`, `test/web/e2e.test.ts:84`, `test/web/e2e.test.ts:91`

11. **[Medium] Genome tests are git-process heavy and dominate runtime.**
Evidence: `test/genome/genome.test.ts:83`, `test/genome/genome.test.ts:126`, `src/genome/genome.ts:21`

12. **[Low-Medium] Unit test depends on external network (`httpbin`).**
Evidence: `test/kernel/primitives.test.ts:285`

## 3) Easy Fixes (Small, Safe, High Leverage)
1. Add `GOOGLE_API_KEY` to sensitive env filtering in execution env.
2. Include `web/src/**` in `biome.json` includes.
3. Expand `test:unit` selection to include `web/src/**/*.test.ts(x)` or add dedicated `test:web` in pre-commit.
4. Replace fixed sleeps with condition polling in the flakiest tests.
5. Make browser open cross-platform (`open`/`xdg-open`/`start`).
6. Replace hardcoded integration lists with discovery by naming convention/tags.
7. Add a non-mutating CI script (`check:ci`) rather than relying on `--write` flows.
8. Clarify web dependency installation (workspace config or explicit `bun install` in `web/`).

## 4) Larger Refactors (Minimal / YAGNI)
1. Refactor SessionController cancellation to a run-scoped controller/token model.
2. Further split `src/agents/agent.ts` around planning/delegation/finalization.
3. Add deterministic test utilities (fake clock + deterministic ephemeral-port allocator) for websocket/session tests.

## 5) Verification Gaps
- Live provider integration (`VCR_MODE=off`) not audited in this run.
- Full web build not fully verifiable in this environment (`vite` missing during subagent run).
- No Linux/Windows cross-platform execution verification in this pass.
