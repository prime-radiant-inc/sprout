# Phase 4: Genome Storage and Recall — Design

## Goal

Implement the genome (persistent mutable state: agent specs, memories, routing rules) and recall (deterministic search over genome to inform Plan). Every mutation is git-committed. Recall is cheap and deterministic — never an LLM call.

## Architecture

Follows the spec's `Genome` record (Section 4.1):

```
src/genome/
  genome.ts         — Genome class: agents, MemoryStore, routing rules, git
  memory-store.ts   — MemoryStore: JSONL append/read/search, confidence decay
  recall.ts         — recall() function + render_memories() + render_routing_hints()
  embedding.ts      — EmbeddingIndex interface (stub, no implementation)
  index.ts          — barrel exports

test/genome/
  genome.test.ts
  memory-store.test.ts
  recall.test.ts
```

### Genome Class

```typescript
class Genome {
  constructor(rootPath: string)

  // Lifecycle
  async init(): Promise<void>           // mkdir -p structure, git init
  async loadFromDisk(): Promise<void>   // read all YAML/JSONL into memory
  async initFromBootstrap(dir: string): Promise<void>  // copy bootstrap YAMLs, commit

  // Agents (Map<string, AgentSpec>)
  agentCount(): number
  allAgents(): AgentSpec[]
  getAgent(name: string): AgentSpec | undefined
  async addAgent(spec: AgentSpec): Promise<void>       // write YAML, git commit
  async updateAgent(spec: AgentSpec): Promise<void>    // overwrite YAML, bump version, git commit
  async removeAgent(name: string): Promise<void>       // delete YAML, git commit

  // Memories (delegates to MemoryStore)
  readonly memories: MemoryStore

  // Routing Rules
  allRoutingRules(): RoutingRule[]
  async addRoutingRule(rule: RoutingRule): Promise<void>    // append to rules.yaml, git commit
  async removeRoutingRule(id: string): Promise<void>        // remove from rules.yaml, git commit
  matchRoutingRules(query: string): RoutingRule[]           // keyword match on condition field
}
```

Directory structure on disk (spec Section 4.5):
```
<rootPath>/
├── .git/
├── agents/
│   ├── root.yaml
│   ├── code-reader.yaml
│   └── ...
├── memories/
│   └── memories.jsonl
├── routing/
│   └── rules.yaml
├── embeddings/      (empty, future use)
└── metrics/         (empty, future use — Phase 6 stumble data)
```

### MemoryStore

```typescript
class MemoryStore {
  constructor(jsonlPath: string)

  async load(): Promise<void>                          // read JSONL into in-memory array
  async add(memory: Memory): Promise<string>           // append to JSONL, return path for git
  search(query: string, limit: number, minConfidence: number): Memory[]
  async markUsed(id: string): Promise<string>          // update last_used, use_count; return path
  all(): Memory[]
  getById(id: string): Memory | undefined
}
```

- JSONL format: one JSON object per line
- Search: keyword matching against `content` and `tags` fields
- Confidence: stored as-is. No automatic decay or pruning. Spec says memories decay (Section 4.3) — but per Jesse's instruction, we store the field without auto-removing. Learn (Phase 6) can explicitly manage confidence.
- `markUsed()` updates `last_used` to now and increments `use_count`

### Recall

```typescript
function recall(genome: Genome, query: string): RecallResult
```

Follows spec Section 5.3 default strategy:
1. If `genome.agentCount() < 20`: return all agents
2. Else: return all agents (placeholder until EmbeddingIndex is implemented — log a warning)
3. Search memories: `genome.memories.search(query, limit=5, minConfidence=0.3)`
4. Match routing rules: `genome.matchRoutingRules(query)`

Note: Step 1 of the spec ("always include primitives") is handled by Agent runtime, not Recall.

### Injection into Plan (Spec Section 5.4, 6.2)

Two rendering functions added to the recall module:

```typescript
function renderMemories(memories: Memory[]): string
// Returns <memories>\n- memory1\n- memory2\n</memories>
// Returns empty string if no memories

function renderRoutingHints(hints: RoutingRule[]): string
// Returns <routing_hints>\n- condition -> preference (strength)\n</routing_hints>
// Returns empty string if no hints
```

`buildSystemPrompt` in `plan.ts` is extended to accept optional memories and routing hints.

### EmbeddingIndex Interface

```typescript
interface EmbeddingIndex {
  search(query: string, limit: number): Promise<AgentSpec[]>
  rebuild(agents: AgentSpec[]): Promise<void>
}
```

Stub only. No implementation until genome exceeds 20 agents and we pick an embedding model (spec D.11 question 5).

### Git Auto-Versioning

Every mutation method (`addAgent`, `updateAgent`, `removeAgent`, `addMemory`, `addRoutingRule`, `removeRoutingRule`) does:
1. Write file to disk
2. `git add <file>`
3. `git commit -m "<descriptive message>"`

Descriptive messages follow pattern: `"genome: add agent 'test-runner'"`, `"genome: add memory mem-xxx"`, `"genome: add routing rule rule-xxx"`.

### Integration with Phase 3

Currently `Agent.constructor` takes `availableAgents: AgentSpec[]`. After Phase 4, the caller flow becomes:
1. `genome = new Genome(rootPath); await genome.loadFromDisk()`
2. `recallResult = recall(genome, userGoal)`
3. `agent = new Agent({ ..., availableAgents: recallResult.agents })`
4. `buildSystemPrompt` includes rendered memories and routing hints

The Agent class itself doesn't change — it already accepts agents as a list. The change is in how that list is populated (Recall instead of hardcoded bootstrap).

### Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Root path | Configurable (constructor injection) | Tests use temp dirs, production uses ~/.local/share/agent-genome |
| Search | Keyword matching only | Spec says start simple, upgrade to embeddings later |
| Embeddings | Interface stub only | Build prompt: "upgrade to embeddings later" |
| Memory decay | Store confidence field, no auto-decay or pruning | Jesse: "i don't think we EVER want to remove memories" |
| Git commits | Every mutation = 1 commit | Spec Section 4.5 |
| Memory format | JSONL (append-only) | Spec Section 4.5, D.9 |
| Agent format | YAML | Spec Section 4.5, D.9 |
| Routing format | YAML | Spec Section 4.5 |
