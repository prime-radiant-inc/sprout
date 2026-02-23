# Deferred Features: Genome Scale

These features are specified in the self-improving-agent spec but are only needed once the genome grows beyond the bootstrap phase. They are intentionally deferred — not missing. Implement them when the genome reaches the thresholds described below.

---

## 1. Embedding-Based Recall (Spec §5.3)

**Trigger:** Genome reaches 20+ agents.

**Current behavior:** `recall()` in `src/genome/recall.ts:14` returns `genome.allAgents()` — every agent, every time. This is correct per spec: "At small scale (< 20 agents): return all agents. Plan sees everything and picks."

**What to build when triggered:**
- Embed agent descriptions using a local model (e.g., `all-MiniLM-L6-v2` — spec §D.11 says "start with whatever's cheapest and local")
- Store embeddings in `~/.local/share/sprout-genome/embeddings/agents.index`
- At recall time, embed the perception/query, compare via cosine similarity, return top-k (spec says limit=10)
- Rebuild the index whenever an agent is added, updated, or removed
- The retrieval strategy itself should be part of the genome and improvable by Learn (spec §5.3)

**Why not now:** With 4 bootstrap agents and even 10-15 learned agents, returning all of them costs negligible tokens. Embedding search adds a dependency (model download, inference latency) without benefit at this scale.

**Spec references:** §5.3 (retrieval strategy tiers), §D.11 Q5 (embedding model choice)

---

## 2. Memory Scoping (Spec §D.11 Q2)

**Trigger:** Agent is used across multiple projects and memories interfere.

**Current behavior:** All memories are global. A memory like "this project uses vitest" is returned for every project, even ones that use pytest.

**What to build when triggered:**
- Add a `scope` field to `Memory`: `"global" | "project:<path>" | "user"`
- `recall()` filters memories by the current working directory
- Learn tags new memories with the project scope where they were learned
- Global memories (e.g., "use more context lines when edit_file fails with ambiguous match") remain unscoped

**Why not now:** Sprout isn't used across multiple projects yet. The spec explicitly says "start without scoping and add it if memory interference becomes a problem" (§D.11 Q2).

---

## 3. Agent Pruning for Unused Agents (Spec §8.7)

**Trigger:** Genome has 15+ agents and some have zero usage for 20+ sessions.

**Current behavior:** Memory pruning and routing rule pruning exist (`genome.pruneMemories()`, `genome.pruneUnusedRoutingRules()`). Agent pruning does not.

**What to build when triggered:**
- Track per-agent usage in `MetricsStore` (already tracks actions per agent — need session-level "was this agent used?" tracking)
- Add `Genome.pruneUnusedAgents(sessionThreshold: number)` — remove agents with zero usage for N sessions
- Before pruning, check if the agent is referenced in any other agent's `capabilities` list
- Consider merging similar agents instead of pruning (spec §8.7: "Agents that are strict subsets of other agents are candidates for merging")
- Learn's simplicity pressure: "fewer, more general agents are preferred over many specialized ones"

**Why not now:** The genome has 4 agents. There's nothing to prune. The pruning threshold (spec §D.11 Q3: "Start conservative, N = 20 sessions") means this only matters after sustained usage.

---

## 4. Re-ranking and Layered Retrieval (Spec §5.3)

**Trigger:** Genome reaches 200+ agents.

**Current behavior:** Returns all agents.

**What to build when triggered:**
- Category filtering → embedding similarity → re-ranking pipeline
- The retrieval strategy itself becomes part of the genome (Learn can improve it)
- This is explicitly the "large scale" tier from spec §5.3

**Why not now:** 200+ agents is far future. The medium-scale embedding approach (feature #1 above) will be sufficient for a long time.

---

## 5. Benchmark Evaluation Loop (Spec Appendix C)

**Trigger:** Sprout is stable enough to run against coding benchmarks (SWE-bench).

**Current behavior:** Only production loop exists (learn from real usage).

**What to build when triggered:**
- Benchmark harness that runs the agent against a suite of known tasks
- Measures performance, applies improvements, re-runs
- Both loops write to the same genome
- The benchmark loop provides rapid iteration (hundreds of runs against known tasks)

**Why not now:** The spec says "The benchmark harness is external to this spec. The agent's improvement loop does not depend on it." This is an optimization for faster genome evolution, not a correctness requirement.

---

## 6. Learn Frequency Expansion (Spec §8.5)

**Trigger:** Per-stumble learning is working well; want broader pattern detection.

**Current behavior:** Learn processes individual stumble signals as they arrive. Only per-stumble frequency.

**What to build when triggered:**
- **Per-task learning:** At end of each agent.run(), analyze the full sequence of actions for patterns (e.g., "the agent read 6 files to find one function")
- **Per-session learning:** At session end, look for cross-task patterns
- **Periodic review:** Every N sessions, assess genome health — are there redundant agents? Stale memories? Imbalanced routing?

**Why not now:** Per-stumble learning is the foundation. The higher-frequency triggers produce the most actionable improvements. The lower-frequency triggers require enough session data to find meaningful patterns. Need 10+ sessions before per-session analysis is useful.

---

## Review Schedule

Check these thresholds after every 10 sessions:
- Agent count (triggers #1 at 20, #3 at 15, #4 at 200)
- Cross-project usage (triggers #2)
- Per-stumble learning effectiveness (triggers #6)
- Overall stability (triggers #5)
