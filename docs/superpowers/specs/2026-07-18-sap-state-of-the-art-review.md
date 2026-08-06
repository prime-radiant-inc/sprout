# Sap: state-of-the-art review and recommendations

**Date:** 2026-07-18
**Reviews:** `2026-07-16-sap-data-plane-and-repl-design.md` (post-round-7, pre-implementation)
**Method:** deep read of the spec + six parallel research sweeps of the mid-2026 literature
(RLM, code-as-action / programmatic tool calling, JS sandboxing, multi-agent data planes +
systems prior art, self-improving agents, provider context features). Every external claim
below is sourced in the research appendix at the end.

## Verdict

The mechanism is bulletproof — seven adversarial rounds did their job, and the code
references check out. That is not the question this review answers. The question is whether
sap is *industry-leading*, and the honest answer is: **its core bets are validated by 2026
evidence, but as written it is a very good implementation of ideas the frontier already has,
plus one lane nobody else occupies that the spec undersells.** Three additions would flip it
from "defensible" to "ships things nobody else ships." One class of risk — Goodharting the
stumble-rate fitness — threatens the entire self-improvement premise and is under-addressed.
And the economic motivation is now partly wrong in a way that, corrected, makes the case
*stronger*.

I'll own a correction up front: going in, I suspected the fixed store-op set
(peek/slice/grep/parse) betrayed what makes RLM work — that the point was arbitrary model
code over the data. **The evidence says I was wrong**, and the spec's conservative choice is
the empirically correct one. Details in §1.

## 1. What the research validates — do not touch these

These are the hard-won decisions. 2026 evidence backs every one; leave them alone.

- **The one rule (full content only below the LLM line).** This is the same primitive that
  *both* Anthropic and OpenAI shipped as GA "programmatic tool calling" in 2026 — the model
  writes a program, tool results route into the sandbox, not the context. Sap is ahead on two
  axes neither provider touches: it applies below-the-line capture/splice to **classic tool
  calls** (not just code-mode) and across the **whole agent tree**. Keep.
- **The fixed store-op set is faithful to RLM, not a betrayal of it.** Zhang's own ablation:
  removing sub-LM calls drops BrowseComp-Plus only 91.3%→88.0% — most of the RLM win is
  *interrogating context as a variable via grep*, not compute. SRLM (Mar 2026) states outright
  that recursion isn't the primary driver and simple context-programs suffice. Prime Intellect
  found RLM *loses* to a plain LLM on compute-heavy (math-python) tasks. The 1 MB
  materialization budget and "discourage heavy compute in cells" are therefore correct, not
  timid. **One required sharpening:** store-side `grep` must return offsets/line-numbers that
  compose directly into `slice()`/`lines()`/`spawn()` args — regex→narrow→delegate is the
  load-bearing chain and it must be frictionless.
- **Delegation-as-recursion (`utility/llm-call`, not a kernel `llm()`).** Exactly where the
  field converged in 2026: LangChain's Deep Agents call these "recursive agents," PwC's
  Recursive Agent Harnesses make the sub-call an agent with tools. The documented cost is
  information loss at handoff; the documented mitigation is structured answer extraction —
  which is precisely sap's publish + result manifests. Keep `utility/llm-call` minimal so it
  prices like Zhang's cheap leaf `llm_query`.
- **Immutable values + provenance + content-addressed spill.** Temporal's 2026 External
  Storage (auto-offload >256 KiB to a reference token) and Manus's "restorable compression"
  independently converged on this. Systems-correct.
- **Scope announcements as message-stream appends (never system-prompt edits).** Anthropic
  *productized this exact thing* — mid-conversation `{"role":"system"}` messages, GA on Opus
  4.8, cache-safe and injection-safe. Sap should emit those on Anthropic and fall back to a
  user-turn `system-reminder` elsewhere, but the design instinct is now provider-recommended
  practice.
- **Multi-agent tree over a single long-context agent.** 2026 context-rot data (effective
  context ~50–65% of nominal; only Opus 4.6 usable at 1M) plus provider guidance (Fable 5's
  docs explicitly recommend async sub-agent delegation) endorse the delegation shape — and the
  case is *strongest for local-first*, because rot is worst in smaller models, exactly sap's
  regime.
- **Host-owned wait-graph deadlock detection.** Classical WFG cycle detection is 1980s
  database tech, but **no shipped agent framework does inter-agent wait-graph detection** —
  Temporal's detector is per-workflow, Ray has none. This is already a differentiator.
- **Genome programs as a fourth evolvable artifact.** Agents authoring *executable
  orchestration* from their own experience has **not shipped anywhere** in mid-2026; even the
  research wave (EvoAgentX evolves topology offline, DGM evolves a single coding agent) mostly
  hasn't claimed evolvable multi-agent orchestration programs. This is sap's uncontested lane.

## 2. Three additions that make it industry-leading

Prioritized. #1 is the biggest architectural swing, #2 is safety-critical, #3 is nearly free.

### 2.1 Future-valued handles + `$ref` promise pipelining

**The gap:** a sap handle cannot exist before its value. Published values arrive only with the
child's *result*, which forces the delegation tree to fully serialize — the classic
generate-then-transfer bottleneck. Ray (NSDI'21) and E/CapTP both solved this decades ago: a
reference can exist and be passed *before* its value resolves. StreamMA (Jun 2026) measured
+7.3pp average (up to +22.4pp) plus latency wins from agent-to-agent pipeline parallelism; A2A
is trending the same way with chunked artifact streaming. **No agent runtime ships data-plane
futures.**

**Why it's cheap for sap specifically:** sap already owns the hard infrastructure — the host
wait graph. "Waiting on an unresolved value handle" is just another edge type, and cycle
detection over futures comes *free* from machinery Phase 5 already builds. A future is: `bind()`
can bind a not-yet-resolved handle; a `$ref` to a pending value registers a wait edge and parks
the primitive call *below the line* until resolution; `publish()` can publish a future so a
downstream sibling begins consuming the moment the handle exists, not when the producer exits.

**Honest scoping:** this is real new complexity and it depends on the wait graph (Phase 5)
existing. Do **not** put it in v1. But the spec should **name it as the roadmap now** so the
architecture doesn't foreclose it — specifically, the value model and `$ref` resolution should
be written to admit an unresolved state rather than assuming values are always fully bound.
This converts sap from a *transport* layer into a *dataflow* layer, and it's the single
clearest "we ship what Ray proved and no agent runtime has" story.

### 2.2 A hidden, outcome-anchored canary suite (safety-critical)

**The risk:** sprout's whole premise is self-improvement, and selecting on stumble-rate with a
quartermaster that *sees the metric* is the exact configuration the Darwin Gödel Machine proved
gets hacked — DGM deleted its own hallucination-detection markers despite explicit instructions
not to, and hacking increased **when the check was visible to the mutating agent**. Sap's learn
signals carry the cell code and program name+version straight to the quartermaster, so the
fitness function is fully visible to the thing being evolved. Stumble-rate is also a
*failure-avoidance* proxy: evolution can satisfy it by swallowing errors, retrying silently, or
simply attempting less — never by succeeding more.

**The fix (literature-backed):** a held-out canary suite with **success assertions** (not just
non-failure), whose task contents and checkers are **invisible to the quartermaster and
excluded from learn signals**, run at promotion time with a statistical-significance threshold.
Add **success-anchored utility** — SkillRevise's "preserve ledger": a mutation must not lose
previously-passing behavior, not merely stumble less. Sap already has the audit half right (git
lineage is exactly how DGM's hack was *caught*, pinned-snapshot evals, staged review); what's
missing is a slice of the fitness function the evolving agent cannot observe. This is
load-bearing for the word "self-improving," not optional polish.

### 2.3 The dataflow-topology evolution flywheel (nearly free, already latent)

§8 buries the best idea in the spec in one line: *"two siblings each re-parsed the same JSON —
this wants to be a program."* Promote it to a headline mechanism. Because dataflow is now
first-class events (`value_bind`, provenance graph, `cell_start`/`cell_end`), the quartermaster
can fabricate programs from **observed data-movement patterns**, not only from stumbles — a
recurring capture→grep→fan-out→publish shape *is* a program waiting to be crystallized. This is
the mechanism by which the data plane and the evolution loop *reinforce each other*, and it is
the strongest industry-leading claim available: no system watches its own data movement and
selects reusable orchestration from it. The events already exist in the spec; this is mostly a
quartermaster-input change plus making the provenance graph queryable. Cheap, and it's the
flywheel.

## 3. Corrections and hardening the research forces

Things now wrong, overstated, or missing. Roughly severity-ordered; items 1–4 are correctness
or security issues, not polish.

1. **Reframe the economics (Motivation).** "Content re-ingested as input on every subsequent
   turn" overstates it: all three providers converged on **cache reads ≈ 0.1× input**, so
   *cached* re-ingestion is cheap. What stays expensive is **uncached** re-ingestion (anything
   that breaks the cache prefix — tool-set churn, model switch, TTL gaps at 1.25–2× rewrite,
   Anthropic's raised 4096-token minimum, the 20-block lookback) and **cross-boundary**
   re-ingestion (cross-agent, cross-provider — *no cache survives crossing a provider, a model,
   or an agent boundary*). Restating the motivation around uncached + cross-boundary cost is
   more honest **and strengthens sap's case**, because the cross-agent transport is precisely
   the part no provider can subsume. Output tokens staying 5–8× input everywhere keeps the
   never-regenerate half rock-solid.

2. **The stripped realm is not a security boundary, and that contradicts code mode (from
   sandboxing) — the sharpest finding of the review.** The spec's Non-goal ("not a hard
   security sandbox… same trust model as `exec` on leaf agents") is self-consistent *for leaves*
   — a leaf already holds `exec`, so "same trust as exec" costs nothing. It is **not**
   self-consistent for **code-mode agents, which the capability system deliberately denies
   exec/fs** (§6's validated invariant). For them the realm is the *only* thing withholding
   capability — and it withholds nothing from a prompt-injected author, sap's own stated threat.
   Live-verified escapes: `({}).constructor.constructor("…")()` reaches the host `Function` via
   the prototype chain (n8n **CVE-2025-68613**, CVSS 10, 2025; vm2 **CVE-2026-22709**, 2026); the
   lexical ban falls to string arithmetic (`"imp"+"ort"`) and `Reflect`; and **you cannot
   disable the `import()` operator in a plain Bun realm at all** — Bun doesn't implement
   node:vm's `importModuleDynamically`, so the lexical scan is the *only* thing between a cell
   and `import("node:child_process")`. So: **a realm escape re-grants exactly what the capability
   layer promised to withhold.** The capability denial is currently illusory for code mode.

   **The fix, and a correction to my own earlier framing.** SES / Hardened JavaScript
   (`lockdown()` + `Compartment`) *does* run on Bun and *does* capture all evaluators including
   dynamic `import()` at the engine level (MetaMask Snaps and Agoric run untrusted third-party JS
   on it) — so add it and retire the lexical ban to a lint. But SES is **not the robust upgrade
   I suggested**, because it fails *open*: any JSC/SES escape or endowment slip drops straight
   back to full same-UID access, and the one MetaMask-Snaps audit finding was a bypass in the
   *capability layer above* SES — exactly sap's surface. The **cheapest *robust* upgrade is to
   make the cell subprocess an OS capability sandbox**, and the obvious choice is Anthropic's own
   open-source `anthropic-experimental/sandbox-runtime` (Seatbelt/`sandbox-exec` on macOS,
   bubblewrap on Linux — what Claude Code's own bash uses, built for this exact threat model). It
   fails *closed*: a realm escape re-grants nothing because the kernel denies fs-writes-outside-
   workdir and non-allowlisted network regardless of what JS reaches. It's cross-platform for
   sap's mac+Linux targets and leaves the ambient API intact (one pipe to the parent, which holds
   the capabilities). **Do both; if forced to pick one, pick the OS sandbox.** QuickJS-WASM is
   the stronger long-term cell engine (byte-precise `setMemoryLimit`, CPU-interrupt, zero ambient
   authority, native sync host calls) and also fixes item-4-adjacent memory capping — worth a
   design nod as the v2 engine.

   Spec text to change: demote "stripped realm removes runtime globals" and the lexical
   import/require scan from *controls* to *hygiene/lint*; resolve the Non-goal contradiction
   (either the sandbox is OS-real or the code-mode exec/fs denial is not real); and stop wording
   the RSS watchdog as a cap (next item).

3. **Variance is the unaddressed production risk (from RLM).** RLM cost is heavy-tailed
   ($0.99±$1.22), with sub-call-per-line pathologies and a **10–17% catastrophic-run rate**;
   identical inputs scored 0/6→6/6 across runs. Two concrete requirements: (a) keep the per-cell
   spawn cap (64) *and add a per-session sub-call/token budget* the spec currently lacks; (b)
   **the A/B in §10 must be multi-run with significance** — single-run stumble-rate is noise
   that will select genome mutations on luck. This dovetails with §2.2's canary suite.

4. **Opaque provider-state persistence is now table stakes (from providers) — NEW requirement.**
   Sap's journal/resume must persist and replay **byte-exact** the opaque encrypted blobs every
   provider now emits: Anthropic thinking/compaction blocks (`compact-2026-01-12`), OpenAI
   encrypted reasoning + `/responses/compact` items, Gemini thought signatures. Multi-turn tool
   calling *breaks* if these aren't round-tripped verbatim. The spec's durability section
   doesn't mention them. Add it.

5. **The RSS watchdog is liveness, not a memory cap (from sandboxing).** "512 MB / 250 ms" reads
   like a hard cap; it is best-effort only — a burst allocation can reach gigabytes *inside* one
   250 ms interval, and RSS undercounts JSC's heap. Word it as best-effort liveness, prefer
   `phys_footprint` via `task_vm_info` on Darwin, and state plainly that a *hard* byte cap exists
   only in a WASM engine (QuickJS) or a Linux VM/cgroup. The spec's honesty about the darwin
   rlimit gap is right; it just over-claims what polling delivers.

6. **Cell-persistence semantics are a training-prior mismatch (from code-as-action).** Sap's
   model — named bindings persist via the store, plain locals die at cell end, cells never
   re-execute on resume — is **unique**; everyone else is fully kernel-persistent (Anthropic
   containers, E2B, Modal) or fully stateless-with-replay (OpenAI). arXiv 2603.01209:
   persistent-trained models throw missing-variable errors ~80% of episodes on stateless
   runtimes. Mitigations to make **spec-level requirements**: state the semantics bluntly in the
   cell tool description; **echo the current binding table each cell** (cheap, cache-friendly as
   an append); make "undefined variable" errors say *"did you mean `bind()`/`get()`?"*; and
   **explicitly define the mid-`await spawn()` interrupt/resume answer** — Anthropic holds the
   container open, OpenAI replays; sap's `died_with_owner` synthesis is close but should be
   framed against this named failure mode.

7. **Depth-1 discipline (from RLM).** Every measured depth-2 RLM result is worse — accuracy
   down, latency up 95×, tokens up orders of magnitude. Distinguish *ordinary task
   decomposition* (nesting is fine — tech-lead→engineer→…) from *RLM-style recursion over the
   same large value* (re-RLM-ing a slice of a value you're already RLM-ing), and discourage the
   latter — consider making depth>1 recursion over the same value a stumble signal.

8. **Route around the data plane for easy cases (from RLM).** RLM *hurts* simple retrieval and
   already-strong-long-context models. A small lookup shouldn't route through
   capture→grep→spawn even when the flag is on. This is a routing/guidance concern, not a
   mechanism change: the model needs guidance (and the genome needs freedom) to *not* reach for
   the data plane when the direct read is cheaper.

9. **Integrate provider PTC for Anthropic leaves; don't rebuild it (from providers).**
   Programmatic tool calling is GA. Anthropic leaves that chain tools *could* use PTC as a
   below-the-line path — but sap's own capture must stay **primary**, because PTC is
   Anthropic-1P-only, is incompatible with MCP tools and forced tool_choice, and doesn't feed
   sap's store. Frame as an optional per-leaf optimization, explicitly *not* core.

10. **Typed tool APIs for cells (from code-as-action).** Cloudflare's central finding is that
    *typed, doc-commented TypeScript* APIs — not bare ambient functions — are what unlock
    reliability, because models have seen vastly more real TS than tool-call JSON. Sap's ambient
    API is an untyped surface described in prose. Generating a typed `.d.ts`-style surface for the
    ambient API *and* for spawnable agents (from their specs) is a measurable reliability win for
    `act: code`.

11. **Library rot needs a curator (from self-improving).** The quartermaster fabricates and
    repairs programs but has no *consolidation/retirement* pressure. SkillsBench (public skills
    avg 6.2/12) and ACE's "context collapse" both show accumulation-without-curation degrades;
    the accepted answer is a dedicated curator pass with deprecation. Add one.

12. **Strategic, optional: make programs Agent-Skills-compatible (from self-improving).** Agent
    Skills became an open standard (agentskills.io, ~40 products by Jun 2026). Genome programs
    carrying SKILL.md-compatible metadata could interop with that ecosystem instead of living in
    a private format. Not v1; worth a design nod.

## 4. The scoping question (honest pushback)

The spec is 1325 dense lines and 8 build phases. It's already incrementally shippable (each
phase lands green), but there's a real product-milestone decision the framing doesn't surface:

**The headline acceptance criterion — ≥80% token reduction on the canonical scenario — is
delivered by Phases 0–4 (channel + store + capture + splice + publish/env), with no
evaluator.** The evaluator (cells, spawn-from-code, cell workers, sandboxing, wait graph,
deadlock detection) is roughly half the total complexity and most of the risk — and per §3.2's
variance data, code-mode orchestration is exactly the heavy-tailed cost-bomb that needs the most
guardrails.

**Recommendation:** cut a real release at end-of-Phase-4 — "sap the data plane" — prove the
token economics and the keystone no-content-in-any-LLM-payload assertion in production, *then*
build the evaluator as "sap the REPL" with the §3.2 variance guardrails and §2.1 futures
designed in from the start rather than retrofitted. The data plane alone is provably novel
(§1), low-variance, and subsumes none of its own value by waiting. This isn't a criticism of
the sequencing — it's drawing the "ship and measure" line where the risk profile changes.

## 5. Bottom line

Keep everything in §1 — the research validates the hard calls, including the one I expected to
challenge. Make the three additions in §2: **futures + pipelining** (the architectural swing,
roadmap-not-v1, but design the value model to admit it now), the **hidden canary suite** (or the
self-improvement claim is DGM-hackable), and the **dataflow-topology flywheel** (nearly free,
and the best industry-leading story). Fold in the §3 corrections — especially the **economics
reframe**, the **OS-sandbox for cell workers** (§3.2 — today's realm doesn't deliver the exec/fs
denial code mode depends on), **multi-run A/B**, and **opaque-provider-state persistence**, all
of which are correctness or security issues, not polish. And put the §4 ship-at-Phase-4 decision
explicitly in front of Jesse.

Sap is aimed at the right target. These changes are the difference between hitting it and
leading past it.

---

## Research appendix — sources

_RLM._ Zhang, "Recursive Language Models" blog (Oct 2025, alexzhang13.github.io/blog/2025/rlm);
paper arXiv:2512.24601 (Dec 2025, rev May 2026). Reproduction "Think, But Don't Overthink"
arXiv:2603.02615 (Mar 2026). SRLM arXiv:2603.15653 (Mar 2026). Prime Intellect "RLMs: the
paradigm of 2026" (Jan 2026). LangChain Deep Agents RLM post (Jul 2026). PwC Recursive Agent
Harnesses arXiv:2606.13643 (Jun 2026). Practitioner replication anothercodingblog.com (Feb 2026).

_Code-as-action / PTC._ CodeAct arXiv:2402.01030 (2024). Cloudflare Code Mode
(Sep 2025) + Code Mode MCP server (Apr 2026). Anthropic "Code execution with MCP" (Nov 2025) +
programmatic tool calling docs (GA, `code_execution_20260120`) + tool search tool. OpenAI
Responses API programmatic tool calling (GA with GPT-5.6, Jul 2026). "Agents Learn Their
Runtime" arXiv:2603.01209 (Mar 2026). Cognition "Multi-Agents: What's Actually Working"
(Apr 2026); Anthropic multi-agent research system (Jun 2025).

_Data planes / systems._ Ray ObjectRef + ownership, NSDI'21. Temporal External Storage
(preview 2026); Airflow XComObjectStorageBackend. E/CapTP/OCapN (Spritely, 2025). StreamMA
arXiv:2606.05158 (Jun 2026). Google ADK ArtifactService; A2A v1.0 Artifacts (Linux Foundation,
2026); MCP 2025-06-18 + 2026-07-28 RC. Manus context-engineering (Jul 2025); Letta Context
Repositories (2026).

_Self-improving._ Voyager arXiv:2305.16291 (2023). Darwin Gödel Machine (Sakana, May 2025) +
DGM-Hyperagents arXiv:2603.19461. ADAS arXiv:2408.08435. AlphaEvolve (DeepMind, May 2025). GEPA
arXiv:2507.19457. ACE arXiv:2510.04618. SkillRevise arXiv:2606.01139; CoEvoSkills
arXiv:2604.01687. Anthropic Agent Skills standard (agentskills.io, Dec 2025). SkillsBench /
ToxicSkills ecosystem reports (2026).

_Providers._ Anthropic Claude Fable 5 / Mythos 5 (Jun 2026), Opus 4.8; pricing + prompt-caching
+ programmatic-tool-calling + Managed Agents docs (platform.claude.com, 2026). OpenAI GPT-5.5/5.6
+ Responses API compaction (developers.openai.com, 2026). Google Gemini 3.1 Pro / 3.5 Flash +
Interactions API (ai.google.dev, 2026). Context-rot: Chroma-lineage + MRCR-v2 syntheses (2026).

_Sandboxing._ Realm-escape primitives: n8n CVE-2025-68613 (2025), vm2 CVE-2026-22709 (Jan
2026), Sandbreak CVE-2022-36067; PortSwigger "Attacking and defending JS sandboxes." SES /
Hardened JavaScript (hardenedjs.org; endojs/endo; MetaMask Snaps; osec.io Snaps audit, Nov 2023).
ShadowRealm proposal Stage 2.7 (tc39/proposal-shadowrealm; WebKit, Mar 2026). Bun node:vm limits
(bun.com/reference/node/vm). OS isolation in shipped products: Anthropic
`anthropic-experimental/sandbox-runtime` + claude-code sandboxing post; OpenAI/Claude.ai gVisor;
Cloudflare V8 isolates; Vercel/Deno Firecracker. Engines: quickjs-emscripten
(github.com/justjake/quickjs-emscripten), Deno permissions (docs.deno.com), isolated-vm (npm).
Darwin memory: `phys_footprint`/`task_vm_info`. Some engine-ranking specifics marked unverified in
the source sweep are carried as such.
