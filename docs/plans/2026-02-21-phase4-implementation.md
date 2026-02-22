# Phase 4: Genome Storage and Recall — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement persistent genome storage (agent specs as YAML, memories as JSONL, routing rules as YAML, all git-versioned) and deterministic Recall (search over genome to inform Plan).

**Architecture:** A `Genome` class manages a git-versioned directory with three data types. `MemoryStore` handles JSONL memory storage with keyword search and confidence decay. A standalone `recall()` function searches the genome and returns `RecallResult`. Render functions inject memories and routing hints into the system prompt as XML blocks (spec Section 5.4).

**Tech Stack:** TypeScript/Bun, `yaml` package (existing dep — use `parse`/`stringify`), git CLI via `Bun.spawn`, `bun test`

---

## Context

**Existing files you'll reference:**
- `src/kernel/types.ts` — `Memory`, `RoutingRule`, `AgentSpec`, `RecallResult`, `DEFAULT_CONSTRAINTS` (already defined)
- `src/agents/loader.ts` — `loadAgentSpec(path)` reads YAML → AgentSpec with validation + default merging. Uses `import { parse } from "yaml"`.
- `src/agents/plan.ts` — `buildSystemPrompt()` constructs system prompt + environment XML. Will be extended with memories/routing hints.
- `bootstrap/` — 4 bootstrap YAML specs: root.yaml, code-reader.yaml, code-editor.yaml, command-runner.yaml
- `package.json` — YAML library is `yaml` (v2.8.2), NOT `js-yaml`. Use `import { parse, stringify } from "yaml"`.

**Directory structure being created:**
```
src/genome/
  genome.ts         — Genome class + git() helper
  memory-store.ts   — MemoryStore class (JSONL + search)
  recall.ts         — recall() + renderMemories() + renderRoutingHints()
  embedding.ts      — EmbeddingIndex interface (stub)
  index.ts          — barrel exports

test/genome/
  memory-store.test.ts
  genome.test.ts
  recall.test.ts
```

---

### Task 1: MemoryStore — JSONL Storage with Keyword Search

**Files:**
- Create: `src/genome/memory-store.ts`
- Create: `test/genome/memory-store.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/genome/memory-store.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/genome/memory-store.ts";
import type { Memory } from "../../src/kernel/types.ts";

function makeMemory(overrides: Partial<Memory> & { id: string; content: string }): Memory {
	return {
		tags: [],
		source: "test",
		created: Date.now(),
		last_used: Date.now(),
		use_count: 0,
		confidence: 1.0,
		...overrides,
	};
}

describe("MemoryStore", () => {
	let tempDir: string;
	let jsonlPath: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-memstore-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		jsonlPath = join(tempDir, `memories-${Date.now()}.jsonl`);
	});

	test("starts empty", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		expect(store.all()).toEqual([]);
	});

	test("add() appends memory to JSONL file", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		const mem = makeMemory({ id: "mem-1", content: "pytest is the test framework" });
		await store.add(mem);
		expect(store.all()).toHaveLength(1);
		expect(store.all()[0]!.id).toBe("mem-1");

		// Verify file on disk
		const raw = await Bun.file(jsonlPath).text();
		expect(raw.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(raw.trim())).toMatchObject({ id: "mem-1" });
	});

	test("load() reads existing JSONL file", async () => {
		// Write first
		const store1 = new MemoryStore(jsonlPath);
		await store1.load();
		await store1.add(makeMemory({ id: "mem-1", content: "fact one" }));
		await store1.add(makeMemory({ id: "mem-2", content: "fact two" }));

		// Load in a new instance
		const store2 = new MemoryStore(jsonlPath);
		await store2.load();
		expect(store2.all()).toHaveLength(2);
		expect(store2.all()[0]!.id).toBe("mem-1");
		expect(store2.all()[1]!.id).toBe("mem-2");
	});

	test("search() finds memories by keyword in content", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		await store.add(makeMemory({ id: "m1", content: "this project uses pytest for testing" }));
		await store.add(makeMemory({ id: "m2", content: "the auth module is at src/auth/" }));
		await store.add(makeMemory({ id: "m3", content: "vitest is configured in vite.config" }));

		const results = store.search("testing pytest");
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("m1");
	});

	test("search() finds memories by keyword in tags", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		await store.add(makeMemory({ id: "m1", content: "some fact", tags: ["python", "testing"] }));
		await store.add(makeMemory({ id: "m2", content: "another fact", tags: ["javascript"] }));

		const results = store.search("python");
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("m1");
	});

	test("search() filters by minConfidence using effective confidence", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		// Memory used very recently — high effective confidence
		await store.add(makeMemory({ id: "m1", content: "recent fact about testing", last_used: Date.now() }));
		// Memory with low stored confidence
		await store.add(makeMemory({ id: "m2", content: "old fact about testing", confidence: 0.1 }));

		const results = store.search("testing", 5, 0.3);
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("m1");
	});

	test("search() respects limit", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		for (let i = 0; i < 10; i++) {
			await store.add(makeMemory({ id: `m${i}`, content: `testing fact number ${i}` }));
		}

		const results = store.search("testing", 3);
		expect(results).toHaveLength(3);
	});

	test("search() returns empty for empty query", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		await store.add(makeMemory({ id: "m1", content: "something" }));

		expect(store.search("")).toEqual([]);
		expect(store.search("   ")).toEqual([]);
	});

	test("markUsed() updates last_used and use_count", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		const before = Date.now();
		await store.add(makeMemory({ id: "m1", content: "fact", last_used: before - 10000, use_count: 2 }));

		store.markUsed("m1");

		const mem = store.getById("m1")!;
		expect(mem.use_count).toBe(3);
		expect(mem.last_used).toBeGreaterThanOrEqual(before);
	});

	test("effectiveConfidence() decays based on time since last use", () => {
		const store = new MemoryStore(jsonlPath);
		const now = Date.now();
		const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

		const recent = makeMemory({ id: "m1", content: "x", confidence: 1.0, last_used: now });
		const old = makeMemory({ id: "m2", content: "y", confidence: 1.0, last_used: thirtyDaysAgo });

		// Recently used: effective ≈ stored
		expect(store.effectiveConfidence(recent)).toBeCloseTo(1.0, 1);

		// 30 days old: half-life decay, should be ≈ 0.5
		expect(store.effectiveConfidence(old)).toBeCloseTo(0.5, 1);
	});

	test("getById() returns specific memory", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		await store.add(makeMemory({ id: "m1", content: "fact one" }));
		await store.add(makeMemory({ id: "m2", content: "fact two" }));

		expect(store.getById("m1")?.content).toBe("fact one");
		expect(store.getById("m2")?.content).toBe("fact two");
		expect(store.getById("nonexistent")).toBeUndefined();
	});

	test("save() rewrites entire JSONL file", async () => {
		const store = new MemoryStore(jsonlPath);
		await store.load();
		await store.add(makeMemory({ id: "m1", content: "fact", use_count: 0 }));

		// Mutate in memory
		store.markUsed("m1");

		// Save rewrites the file
		await store.save();

		// Load in new instance to verify
		const store2 = new MemoryStore(jsonlPath);
		await store2.load();
		expect(store2.getById("m1")!.use_count).toBe(1);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/genome/memory-store.test.ts`
Expected: FAIL — cannot find module `../../src/genome/memory-store.ts`

**Step 3: Write minimal implementation**

```typescript
// src/genome/memory-store.ts
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Memory } from "../kernel/types.ts";

const HALF_LIFE_DAYS = 30;

export class MemoryStore {
	private entries: Memory[] = [];
	private readonly path: string;

	constructor(jsonlPath: string) {
		this.path = jsonlPath;
	}

	async load(): Promise<void> {
		try {
			const content = await readFile(this.path, "utf-8");
			this.entries = content
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Memory);
		} catch {
			this.entries = [];
		}
	}

	async add(memory: Memory): Promise<void> {
		this.entries.push(memory);
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(memory)}\n`);
	}

	search(query: string, limit = 5, minConfidence = 0.3): Memory[] {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) return [];

		return this.entries
			.filter((m) => this.effectiveConfidence(m) >= minConfidence)
			.map((m) => {
				const text = `${m.content} ${m.tags.join(" ")}`.toLowerCase();
				let score = 0;
				for (const token of tokens) {
					if (text.includes(token)) score++;
				}
				return { memory: m, score };
			})
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((r) => r.memory);
	}

	markUsed(id: string): void {
		const mem = this.entries.find((m) => m.id === id);
		if (mem) {
			mem.last_used = Date.now();
			mem.use_count++;
		}
	}

	async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const content =
			this.entries.length > 0
				? this.entries.map((m) => JSON.stringify(m)).join("\n") + "\n"
				: "";
		await writeFile(this.path, content);
	}

	effectiveConfidence(memory: Memory): number {
		const daysSinceUse = (Date.now() - memory.last_used) / (1000 * 60 * 60 * 24);
		return memory.confidence * Math.pow(0.5, daysSinceUse / HALF_LIFE_DAYS);
	}

	all(): Memory[] {
		return [...this.entries];
	}

	getById(id: string): Memory | undefined {
		return this.entries.find((m) => m.id === id);
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/genome/memory-store.test.ts`
Expected: All 11 tests PASS

**Step 5: Commit**

```bash
git add src/genome/memory-store.ts test/genome/memory-store.test.ts
git commit -m "feat: add MemoryStore with JSONL storage and keyword search"
```

---

### Task 2: Genome Class — Init, Git, and Agent CRUD

**Files:**
- Create: `src/genome/genome.ts`
- Create: `test/genome/genome.test.ts`

**Docs to read:** `src/agents/loader.ts` (reuse `loadAgentSpec` for reading agent YAML), `src/kernel/types.ts:19-29` (AgentSpec), `src/kernel/types.ts:11-17` (DEFAULT_CONSTRAINTS)

**Step 1: Write the failing tests**

```typescript
// test/genome/genome.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome, git } from "../../src/genome/genome.ts";
import { DEFAULT_CONSTRAINTS, type AgentSpec } from "../../src/kernel/types.ts";

function makeSpec(name: string, overrides?: Partial<AgentSpec>): AgentSpec {
	return {
		name,
		description: `Test agent ${name}`,
		system_prompt: `You are ${name}.`,
		model: "fast",
		capabilities: ["read_file"],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: ["test"],
		version: 1,
		...overrides,
	};
}

describe("Genome", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-genome-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("init", () => {
		test("creates directory structure", async () => {
			const root = join(tempDir, "init-test");
			const genome = new Genome(root);
			await genome.init();

			// Check directories exist
			for (const dir of ["agents", "memories", "routing", "embeddings", "metrics"]) {
				const stat = await Bun.file(join(root, dir)).exists();
				// Directories won't show as files, use a different check
				expect(async () => {
					await Bun.spawn(["ls", join(root, dir)]).exited;
				}).not.toThrow();
			}
		});

		test("initializes git repo with initial commit", async () => {
			const root = join(tempDir, "git-test");
			const genome = new Genome(root);
			await genome.init();

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: initialize");
		});

		test("is idempotent (calling init twice does not error)", async () => {
			const root = join(tempDir, "idempotent-test");
			const genome = new Genome(root);
			await genome.init();
			await genome.init(); // second call should not throw
		});

		test("creates empty routing rules file", async () => {
			const root = join(tempDir, "routing-init-test");
			const genome = new Genome(root);
			await genome.init();

			const content = await readFile(join(root, "routing", "rules.yaml"), "utf-8");
			expect(content).toBeDefined();
		});
	});

	describe("agent CRUD", () => {
		test("addAgent writes YAML and commits", async () => {
			const root = join(tempDir, "agent-add-test");
			const genome = new Genome(root);
			await genome.init();

			const spec = makeSpec("test-agent");
			await genome.addAgent(spec);

			expect(genome.getAgent("test-agent")).toBeDefined();
			expect(genome.agentCount()).toBe(1);

			// YAML file exists on disk
			const yamlContent = await readFile(join(root, "agents", "test-agent.yaml"), "utf-8");
			expect(yamlContent).toContain("test-agent");

			// Git committed
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("add agent 'test-agent'");
		});

		test("getAgent returns undefined for nonexistent agent", async () => {
			const root = join(tempDir, "agent-get-test");
			const genome = new Genome(root);
			await genome.init();

			expect(genome.getAgent("nonexistent")).toBeUndefined();
		});

		test("allAgents returns all agents", async () => {
			const root = join(tempDir, "agent-all-test");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec("agent-a"));
			await genome.addAgent(makeSpec("agent-b"));

			const all = genome.allAgents();
			expect(all).toHaveLength(2);
			expect(all.map((a) => a.name).sort()).toEqual(["agent-a", "agent-b"]);
		});

		test("updateAgent overwrites YAML, bumps version, and commits", async () => {
			const root = join(tempDir, "agent-update-test");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec("updatable", { version: 1 }));
			await genome.updateAgent(genome.getAgent("updatable")!);

			const updated = genome.getAgent("updatable")!;
			expect(updated.version).toBe(2);

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("update agent 'updatable' to v2");
		});

		test("removeAgent deletes YAML and commits", async () => {
			const root = join(tempDir, "agent-remove-test");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec("removable"));
			expect(genome.getAgent("removable")).toBeDefined();

			await genome.removeAgent("removable");
			expect(genome.getAgent("removable")).toBeUndefined();
			expect(genome.agentCount()).toBe(0);

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("remove agent 'removable'");
		});
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/genome/genome.test.ts`
Expected: FAIL — cannot find module `../../src/genome/genome.ts`

**Step 3: Write minimal implementation**

```typescript
// src/genome/genome.ts
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadAgentSpec } from "../agents/loader.ts";
import type { AgentSpec, Memory, RoutingRule } from "../kernel/types.ts";
import { MemoryStore } from "./memory-store.ts";

/**
 * Run a git command in the given directory. Returns stdout.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return stdout.trim();
}

export class Genome {
	private readonly rootPath: string;
	private agents: Map<string, AgentSpec> = new Map();
	private routingRules: RoutingRule[] = [];
	readonly memories: MemoryStore;

	constructor(rootPath: string) {
		this.rootPath = rootPath;
		this.memories = new MemoryStore(join(rootPath, "memories", "memories.jsonl"));
	}

	// --- Lifecycle ---

	async init(): Promise<void> {
		// Create directory structure (idempotent)
		for (const dir of ["agents", "memories", "routing", "embeddings", "metrics"]) {
			await mkdir(join(this.rootPath, dir), { recursive: true });
		}

		// Git init if not already a repo
		if (!(await this.isGitRepo())) {
			await git(this.rootPath, "init");
			await git(this.rootPath, "config", "user.name", "sprout");
			await git(this.rootPath, "config", "user.email", "sprout@local");

			// Create empty routing rules file
			await writeFile(join(this.rootPath, "routing", "rules.yaml"), stringify([]));

			// Initial commit
			await git(this.rootPath, "add", ".");
			await git(this.rootPath, "commit", "-m", "genome: initialize");
		}
	}

	async loadFromDisk(): Promise<void> {
		// Load agents
		const agentsDir = join(this.rootPath, "agents");
		try {
			const files = await readdir(agentsDir);
			const yamlFiles = files
				.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
				.sort();
			for (const file of yamlFiles) {
				const spec = await loadAgentSpec(join(agentsDir, file));
				this.agents.set(spec.name, spec);
			}
		} catch {
			// No agents directory — fine
		}

		// Load memories
		await this.memories.load();

		// Load routing rules
		try {
			const content = await readFile(
				join(this.rootPath, "routing", "rules.yaml"),
				"utf-8",
			);
			this.routingRules = (parse(content) as RoutingRule[]) ?? [];
		} catch {
			this.routingRules = [];
		}
	}

	async initFromBootstrap(bootstrapDir: string): Promise<void> {
		if (this.agents.size > 0) {
			throw new Error("Cannot bootstrap a genome that already has agents");
		}

		const files = await readdir(bootstrapDir);
		const yamlFiles = files
			.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
			.sort();

		for (const file of yamlFiles) {
			const spec = await loadAgentSpec(join(bootstrapDir, file));
			const content = stringify(this.specToYamlObj(spec));
			await writeFile(join(this.rootPath, "agents", `${spec.name}.yaml`), content);
			this.agents.set(spec.name, spec);
		}

		await git(this.rootPath, "add", ".");
		await git(this.rootPath, "commit", "-m", "genome: initialize from bootstrap agents");
	}

	// --- Agent CRUD ---

	agentCount(): number {
		return this.agents.size;
	}

	allAgents(): AgentSpec[] {
		return [...this.agents.values()];
	}

	getAgent(name: string): AgentSpec | undefined {
		return this.agents.get(name);
	}

	async addAgent(spec: AgentSpec): Promise<void> {
		const content = stringify(this.specToYamlObj(spec));
		await writeFile(join(this.rootPath, "agents", `${spec.name}.yaml`), content);
		this.agents.set(spec.name, spec);
		await git(this.rootPath, "add", `agents/${spec.name}.yaml`);
		await git(this.rootPath, "commit", "-m", `genome: add agent '${spec.name}'`);
	}

	async updateAgent(spec: AgentSpec): Promise<void> {
		const updated = { ...spec, version: spec.version + 1 };
		const content = stringify(this.specToYamlObj(updated));
		await writeFile(join(this.rootPath, "agents", `${spec.name}.yaml`), content);
		this.agents.set(spec.name, updated);
		await git(this.rootPath, "add", `agents/${spec.name}.yaml`);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: update agent '${spec.name}' to v${updated.version}`,
		);
	}

	async removeAgent(name: string): Promise<void> {
		await rm(join(this.rootPath, "agents", `${name}.yaml`));
		this.agents.delete(name);
		await git(this.rootPath, "add", `agents/${name}.yaml`);
		await git(this.rootPath, "commit", "-m", `genome: remove agent '${name}'`);
	}

	// --- Routing Rules ---

	allRoutingRules(): RoutingRule[] {
		return [...this.routingRules];
	}

	matchRoutingRules(query: string): RoutingRule[] {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) return [];
		return this.routingRules
			.filter((rule) => {
				const condLower = rule.condition.toLowerCase();
				return tokens.some((t) => condLower.includes(t));
			})
			.sort((a, b) => b.strength - a.strength);
	}

	async addRoutingRule(rule: RoutingRule): Promise<void> {
		this.routingRules.push(rule);
		await this.saveRoutingRules();
		await git(this.rootPath, "add", "routing/rules.yaml");
		await git(this.rootPath, "commit", "-m", `genome: add routing rule '${rule.id}'`);
	}

	async removeRoutingRule(id: string): Promise<void> {
		this.routingRules = this.routingRules.filter((r) => r.id !== id);
		await this.saveRoutingRules();
		await git(this.rootPath, "add", "routing/rules.yaml");
		await git(this.rootPath, "commit", "-m", `genome: remove routing rule '${id}'`);
	}

	// --- Memory (delegates to MemoryStore + git) ---

	async addMemory(memory: Memory): Promise<void> {
		await this.memories.add(memory);
		await git(this.rootPath, "add", "memories/memories.jsonl");
		await git(this.rootPath, "commit", "-m", `genome: add memory '${memory.id}'`);
	}

	async markMemoriesUsed(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		for (const id of ids) {
			this.memories.markUsed(id);
		}
		await this.memories.save();
		await git(this.rootPath, "add", "memories/memories.jsonl");
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: mark ${ids.length} memories used`,
		);
	}

	// --- Helpers ---

	private async isGitRepo(): Promise<boolean> {
		try {
			await git(this.rootPath, "rev-parse", "--git-dir");
			return true;
		} catch {
			return false;
		}
	}

	private specToYamlObj(spec: AgentSpec): Record<string, unknown> {
		return {
			name: spec.name,
			description: spec.description,
			model: spec.model,
			capabilities: spec.capabilities,
			constraints: {
				max_turns: spec.constraints.max_turns,
				max_depth: spec.constraints.max_depth,
				timeout_ms: spec.constraints.timeout_ms,
				can_spawn: spec.constraints.can_spawn,
				can_learn: spec.constraints.can_learn,
			},
			tags: spec.tags,
			system_prompt: spec.system_prompt,
			version: spec.version,
		};
	}

	private async saveRoutingRules(): Promise<void> {
		await writeFile(
			join(this.rootPath, "routing", "rules.yaml"),
			stringify(this.routingRules),
		);
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/genome/genome.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add src/genome/genome.ts test/genome/genome.test.ts
git commit -m "feat: add Genome class with init, git versioning, and agent CRUD"
```

---

### Task 3: Genome — Routing Rules, Load, and Bootstrap

**Files:**
- Modify: `test/genome/genome.test.ts` (add routing, load, bootstrap tests)

**Step 1: Write the failing tests**

Add these test blocks to the existing `test/genome/genome.test.ts`:

```typescript
// Add these inside the main describe("Genome", ...) block:

describe("routing rules", () => {
	test("addRoutingRule appends to rules.yaml and commits", async () => {
		const root = join(tempDir, "routing-add-test");
		const genome = new Genome(root);
		await genome.init();

		const rule: RoutingRule = {
			id: "rule-1",
			condition: "Go project testing",
			preference: "test-runner-go",
			strength: 0.8,
			source: "test",
		};
		await genome.addRoutingRule(rule);

		expect(genome.allRoutingRules()).toHaveLength(1);
		expect(genome.allRoutingRules()[0]!.id).toBe("rule-1");

		const log = await git(root, "log", "--oneline");
		expect(log).toContain("add routing rule 'rule-1'");
	});

	test("removeRoutingRule removes and commits", async () => {
		const root = join(tempDir, "routing-remove-test");
		const genome = new Genome(root);
		await genome.init();

		await genome.addRoutingRule({
			id: "rule-1",
			condition: "testing",
			preference: "agent-a",
			strength: 0.5,
			source: "test",
		});
		await genome.removeRoutingRule("rule-1");

		expect(genome.allRoutingRules()).toHaveLength(0);

		const log = await git(root, "log", "--oneline");
		expect(log).toContain("remove routing rule 'rule-1'");
	});

	test("matchRoutingRules finds rules by keyword", async () => {
		const root = join(tempDir, "routing-match-test");
		const genome = new Genome(root);
		await genome.init();

		await genome.addRoutingRule({
			id: "r1",
			condition: "Go project testing",
			preference: "test-runner-go",
			strength: 0.9,
			source: "test",
		});
		await genome.addRoutingRule({
			id: "r2",
			condition: "Python project linting",
			preference: "linter-py",
			strength: 0.7,
			source: "test",
		});

		const matches = genome.matchRoutingRules("testing Go");
		expect(matches).toHaveLength(1);
		expect(matches[0]!.id).toBe("r1");
	});

	test("matchRoutingRules returns sorted by strength descending", async () => {
		const root = join(tempDir, "routing-sort-test");
		const genome = new Genome(root);
		await genome.init();

		await genome.addRoutingRule({
			id: "r1",
			condition: "testing framework",
			preference: "agent-a",
			strength: 0.3,
			source: "test",
		});
		await genome.addRoutingRule({
			id: "r2",
			condition: "testing framework",
			preference: "agent-b",
			strength: 0.9,
			source: "test",
		});

		const matches = genome.matchRoutingRules("testing");
		expect(matches[0]!.id).toBe("r2");
		expect(matches[1]!.id).toBe("r1");
	});
});

describe("loadFromDisk", () => {
	test("loads agents, memories, and routing rules from existing genome", async () => {
		const root = join(tempDir, "load-test");

		// Create and populate a genome
		const genome1 = new Genome(root);
		await genome1.init();
		await genome1.addAgent(makeSpec("loader-agent"));
		await genome1.addMemory({
			id: "mem-1",
			content: "a memory",
			tags: [],
			source: "test",
			created: Date.now(),
			last_used: Date.now(),
			use_count: 0,
			confidence: 1.0,
		});
		await genome1.addRoutingRule({
			id: "rule-1",
			condition: "testing",
			preference: "agent-a",
			strength: 0.5,
			source: "test",
		});

		// Load in a fresh Genome instance
		const genome2 = new Genome(root);
		await genome2.loadFromDisk();

		expect(genome2.agentCount()).toBe(1);
		expect(genome2.getAgent("loader-agent")).toBeDefined();
		expect(genome2.memories.all()).toHaveLength(1);
		expect(genome2.allRoutingRules()).toHaveLength(1);
	});
});

describe("initFromBootstrap", () => {
	test("copies bootstrap agents into genome and commits", async () => {
		const root = join(tempDir, "bootstrap-test");
		const genome = new Genome(root);
		await genome.init();

		const bootstrapDir = join(import.meta.dir, "../../bootstrap");
		await genome.initFromBootstrap(bootstrapDir);

		expect(genome.agentCount()).toBe(4);
		expect(genome.getAgent("root")).toBeDefined();
		expect(genome.getAgent("code-reader")).toBeDefined();
		expect(genome.getAgent("code-editor")).toBeDefined();
		expect(genome.getAgent("command-runner")).toBeDefined();

		const log = await git(root, "log", "--oneline");
		expect(log).toContain("bootstrap");
	});

	test("throws if genome already has agents", async () => {
		const root = join(tempDir, "bootstrap-guard-test");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec("existing"));

		const bootstrapDir = join(import.meta.dir, "../../bootstrap");
		expect(genome.initFromBootstrap(bootstrapDir)).rejects.toThrow(
			/already has agents/,
		);
	});
});

describe("memory CRUD via Genome", () => {
	test("addMemory writes JSONL and commits", async () => {
		const root = join(tempDir, "memory-add-test");
		const genome = new Genome(root);
		await genome.init();

		await genome.addMemory({
			id: "mem-1",
			content: "this project uses vitest",
			tags: ["testing"],
			source: "test",
			created: Date.now(),
			last_used: Date.now(),
			use_count: 0,
			confidence: 1.0,
		});

		expect(genome.memories.all()).toHaveLength(1);

		const log = await git(root, "log", "--oneline");
		expect(log).toContain("add memory 'mem-1'");
	});

	test("markMemoriesUsed updates and commits", async () => {
		const root = join(tempDir, "memory-mark-test");
		const genome = new Genome(root);
		await genome.init();

		await genome.addMemory({
			id: "mem-1",
			content: "fact",
			tags: [],
			source: "test",
			created: Date.now(),
			last_used: Date.now() - 100000,
			use_count: 0,
			confidence: 1.0,
		});

		await genome.markMemoriesUsed(["mem-1"]);

		expect(genome.memories.getById("mem-1")!.use_count).toBe(1);

		const log = await git(root, "log", "--oneline");
		expect(log).toContain("mark 1 memories used");
	});
});
```

Also add the `RoutingRule` import at the top of the file:
```typescript
import type { AgentSpec, RoutingRule } from "../../src/kernel/types.ts";
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/genome/genome.test.ts`
Expected: New tests FAIL (routing/load/bootstrap tests should fail since the implementation already exists from Task 2 — but the loadFromDisk, bootstrap, and memory tests may require verifying the implementation handles all cases)

Note: If all tests pass immediately, that means the Task 2 implementation already covers these cases. Review the tests to ensure they're testing real behavior, not tautologies.

**Step 3: Verify implementation handles all cases**

The implementation from Task 2 should already handle routing rules, loadFromDisk, initFromBootstrap, and memory CRUD. If any tests fail, fix the implementation.

**Step 4: Run tests to verify they pass**

Run: `bun test test/genome/genome.test.ts`
Expected: All tests PASS (both old and new)

**Step 5: Commit**

```bash
git add test/genome/genome.test.ts
git commit -m "test: add routing rules, loadFromDisk, bootstrap, and memory CRUD tests"
```

---

### Task 4: Recall Function

**Files:**
- Create: `src/genome/recall.ts`
- Create: `test/genome/recall.test.ts`

**Docs to read:** Spec Section 5.3 (default retrieval strategy), Section 5.4 (injection into Plan as XML blocks)

**Step 1: Write the failing tests**

```typescript
// test/genome/recall.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome } from "../../src/genome/genome.ts";
import { recall, renderMemories, renderRoutingHints } from "../../src/genome/recall.ts";
import { DEFAULT_CONSTRAINTS, type AgentSpec, type Memory } from "../../src/kernel/types.ts";

function makeSpec(name: string): AgentSpec {
	return {
		name,
		description: `Agent ${name}`,
		system_prompt: `You are ${name}.`,
		model: "fast",
		capabilities: [],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: [],
		version: 1,
	};
}

function makeMemory(id: string, content: string, tags: string[] = []): Memory {
	return {
		id,
		content,
		tags,
		source: "test",
		created: Date.now(),
		last_used: Date.now(),
		use_count: 0,
		confidence: 1.0,
	};
}

describe("recall", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-recall-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns all agents when genome has < 20 agents", async () => {
		const root = join(tempDir, "recall-small");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec("agent-a"));
		await genome.addAgent(makeSpec("agent-b"));

		const result = await recall(genome, "find some code");

		expect(result.agents).toHaveLength(2);
		expect(result.agents.map((a) => a.name).sort()).toEqual(["agent-a", "agent-b"]);
	});

	test("returns matching memories by keyword", async () => {
		const root = join(tempDir, "recall-memories");
		const genome = new Genome(root);
		await genome.init();
		await genome.addMemory(makeMemory("m1", "this project uses pytest for testing"));
		await genome.addMemory(makeMemory("m2", "the auth module is at src/auth"));

		const result = await recall(genome, "testing pytest");

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]!.id).toBe("m1");
	});

	test("returns matching routing hints", async () => {
		const root = join(tempDir, "recall-routing");
		const genome = new Genome(root);
		await genome.init();
		await genome.addRoutingRule({
			id: "r1",
			condition: "Go project testing",
			preference: "test-runner-go",
			strength: 0.8,
			source: "test",
		});

		const result = await recall(genome, "run Go tests");

		expect(result.routing_hints).toHaveLength(1);
		expect(result.routing_hints[0]!.preference).toBe("test-runner-go");
	});

	test("marks used memories", async () => {
		const root = join(tempDir, "recall-mark");
		const genome = new Genome(root);
		await genome.init();
		await genome.addMemory(
			makeMemory("m1", "testing fact", []),
		);

		const before = genome.memories.getById("m1")!.use_count;
		await recall(genome, "testing");
		const after = genome.memories.getById("m1")!.use_count;

		expect(after).toBe(before + 1);
	});

	test("returns empty memories and routing when none match", async () => {
		const root = join(tempDir, "recall-empty");
		const genome = new Genome(root);
		await genome.init();
		await genome.addMemory(makeMemory("m1", "unrelated topic"));

		const result = await recall(genome, "testing framework");

		expect(result.memories).toHaveLength(0);
		expect(result.routing_hints).toHaveLength(0);
	});
});

describe("renderMemories", () => {
	test("renders memories as XML block", () => {
		const memories: Memory[] = [
			makeMemory("m1", "this project uses pytest"),
			makeMemory("m2", "auth module at src/auth"),
		];
		const rendered = renderMemories(memories);
		expect(rendered).toContain("<memories>");
		expect(rendered).toContain("this project uses pytest");
		expect(rendered).toContain("auth module at src/auth");
		expect(rendered).toContain("</memories>");
	});

	test("returns empty string when no memories", () => {
		expect(renderMemories([])).toBe("");
	});
});

describe("renderRoutingHints", () => {
	test("renders routing hints as XML block", () => {
		const hints = [
			{
				id: "r1",
				condition: "Go testing",
				preference: "test-runner-go",
				strength: 0.8,
				source: "test",
			},
		];
		const rendered = renderRoutingHints(hints);
		expect(rendered).toContain("<routing_hints>");
		expect(rendered).toContain("Go testing");
		expect(rendered).toContain("test-runner-go");
		expect(rendered).toContain("</routing_hints>");
	});

	test("returns empty string when no hints", () => {
		expect(renderRoutingHints([])).toBe("");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/genome/recall.test.ts`
Expected: FAIL — cannot find module `../../src/genome/recall.ts`

**Step 3: Write minimal implementation**

```typescript
// src/genome/recall.ts
import type { Memory, RecallResult, RoutingRule } from "../kernel/types.ts";
import type { Genome } from "./genome.ts";

/**
 * Search the genome for context relevant to the query.
 * Deterministic and cheap — never an LLM call.
 *
 * Default strategy (spec Section 5.3):
 * 1. If < 20 agents, return all. Else return all (placeholder for embedding search).
 * 2. Search memories by keyword (limit 5, minConfidence 0.3).
 * 3. Match routing rules by keyword.
 */
export async function recall(genome: Genome, query: string): Promise<RecallResult> {
	// 1. Agents: return all (placeholder until embeddings)
	const agents = genome.allAgents();

	// 2. Search memories
	const memories = genome.memories.search(query, 5, 0.3);

	// 3. Match routing rules
	const routing_hints = genome.matchRoutingRules(query);

	// Mark used memories (spec: confidence refreshed on use)
	if (memories.length > 0) {
		await genome.markMemoriesUsed(memories.map((m) => m.id));
	}

	return { agents, memories, routing_hints };
}

/**
 * Render memories as an XML block for injection into the system prompt.
 * Spec Section 5.4: <memories>...</memories>
 */
export function renderMemories(memories: Memory[]): string {
	if (memories.length === 0) return "";
	const items = memories.map((m) => `- ${m.content}`).join("\n");
	return `\n<memories>\n${items}\n</memories>`;
}

/**
 * Render routing hints as an XML block for injection into the system prompt.
 * Spec Section 5.4: <routing_hints>...</routing_hints>
 */
export function renderRoutingHints(hints: RoutingRule[]): string {
	if (hints.length === 0) return "";
	const items = hints
		.map((r) => `- When: ${r.condition} → prefer ${r.preference} (strength: ${r.strength})`)
		.join("\n");
	return `\n<routing_hints>\n${items}\n</routing_hints>`;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/genome/recall.test.ts`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add src/genome/recall.ts test/genome/recall.test.ts
git commit -m "feat: add recall function with keyword search and XML rendering"
```

---

### Task 5: Extend buildSystemPrompt with Memories and Routing Hints

**Files:**
- Modify: `src/agents/plan.ts` (add optional `memories` and `routingHints` params)
- Modify: `test/agents/plan.test.ts` (add tests for memory/routing rendering in prompt)

**Step 1: Write the failing tests**

Add these tests to `test/agents/plan.test.ts` inside the existing `describe("buildSystemPrompt", ...)`:

```typescript
test("includes rendered memories in system prompt", () => {
	const memories: Memory[] = [
		{
			id: "m1",
			content: "this project uses vitest",
			tags: ["testing"],
			source: "test",
			created: Date.now(),
			last_used: Date.now(),
			use_count: 1,
			confidence: 1.0,
		},
	];
	const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0", {
		memories,
	});
	expect(prompt).toContain("<memories>");
	expect(prompt).toContain("this project uses vitest");
	expect(prompt).toContain("</memories>");
});

test("includes rendered routing hints in system prompt", () => {
	const routingHints: RoutingRule[] = [
		{
			id: "r1",
			condition: "Go testing",
			preference: "test-runner-go",
			strength: 0.8,
			source: "test",
		},
	];
	const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0", {
		routingHints,
	});
	expect(prompt).toContain("<routing_hints>");
	expect(prompt).toContain("Go testing");
	expect(prompt).toContain("test-runner-go");
	expect(prompt).toContain("</routing_hints>");
});

test("omits memory/routing sections when empty", () => {
	const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0");
	expect(prompt).not.toContain("<memories>");
	expect(prompt).not.toContain("<routing_hints>");
});
```

Add imports at the top of `test/agents/plan.test.ts`:
```typescript
import type { Memory, RoutingRule } from "../../src/kernel/types.ts";
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/agents/plan.test.ts`
Expected: FAIL — buildSystemPrompt doesn't accept the 5th parameter yet

**Step 3: Modify buildSystemPrompt**

In `src/agents/plan.ts`, update the `buildSystemPrompt` function signature and implementation:

```typescript
import { renderMemories, renderRoutingHints } from "../genome/recall.ts";

// ...

export function buildSystemPrompt(
	spec: AgentSpec,
	workDir: string,
	platform: string,
	osVersion: string,
	recallContext?: { memories?: Memory[]; routingHints?: RoutingRule[] },
): string {
	const today = new Date().toISOString().slice(0, 10);
	let prompt = `${spec.system_prompt}

<environment>
Working directory: ${workDir}
Platform: ${platform}
OS version: ${osVersion}
Today's date: ${today}
</environment>`;

	if (recallContext?.memories && recallContext.memories.length > 0) {
		prompt += renderMemories(recallContext.memories);
	}
	if (recallContext?.routingHints && recallContext.routingHints.length > 0) {
		prompt += renderRoutingHints(recallContext.routingHints);
	}

	return prompt;
}
```

Add the import for Memory and RoutingRule types:
```typescript
import type { AgentSpec, Delegation, Memory, RoutingRule } from "../kernel/types.ts";
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/agents/plan.test.ts`
Expected: All tests PASS (old tests unaffected since the new param is optional)

Also run: `bun test`
Expected: All 159+ tests PASS (no regressions)

**Step 5: Commit**

```bash
git add src/agents/plan.ts test/agents/plan.test.ts
git commit -m "feat: extend buildSystemPrompt with memories and routing hints"
```

---

### Task 6: EmbeddingIndex Interface, Barrel Exports, and Wiring

**Files:**
- Create: `src/genome/embedding.ts`
- Create: `src/genome/index.ts`
- Modify: `src/index.ts` (add genome export)

**Step 1: Create the EmbeddingIndex interface**

```typescript
// src/genome/embedding.ts
import type { AgentSpec } from "../kernel/types.ts";

/**
 * Interface for embedding-based agent search.
 * Stub for Phase 4 — no implementation until genome exceeds 20 agents.
 * See spec Section 5.3 and Appendix D.11 question 5.
 */
export interface EmbeddingIndex {
	search(query: string, limit: number): Promise<AgentSpec[]>;
	rebuild(agents: AgentSpec[]): Promise<void>;
}
```

**Step 2: Create barrel exports**

```typescript
// src/genome/index.ts
export { Genome, git } from "./genome.ts";
export { MemoryStore } from "./memory-store.ts";
export { recall, renderMemories, renderRoutingHints } from "./recall.ts";
export type { EmbeddingIndex } from "./embedding.ts";
```

**Step 3: Add genome export to src/index.ts**

Add this line to `src/index.ts`:
```typescript
export * from "./genome/index.ts";
```

**Step 4: Run all tests**

Run: `bun test`
Expected: All tests PASS, typecheck passes

Run: `bun run typecheck`
Expected: No errors

**Step 5: Commit**

```bash
git add src/genome/embedding.ts src/genome/index.ts src/index.ts
git commit -m "feat: add EmbeddingIndex interface and genome barrel exports"
```

---

## Summary

After completing all 6 tasks, Phase 4 delivers:

| Component | What it does |
|-----------|-------------|
| `MemoryStore` | JSONL storage with keyword search, confidence decay, markUsed |
| `Genome` | Agent YAML CRUD, routing rule YAML CRUD, memory CRUD, git auto-commit per mutation |
| `recall()` | Deterministic search: all agents (< 20), keyword memory search (limit 5, minConfidence 0.3), keyword routing match |
| `renderMemories()` / `renderRoutingHints()` | XML block rendering for system prompt injection |
| `buildSystemPrompt()` | Extended with optional memories and routing hints |
| `EmbeddingIndex` | Interface stub for future embedding-based agent search |

**Integration point:** After Phase 4, the caller flow becomes:
```typescript
const genome = new Genome(genomePath);
await genome.init();
await genome.loadFromDisk(); // or initFromBootstrap() on first run

const recallResult = await recall(genome, userGoal);
const agent = new Agent({
  spec: rootSpec,
  env,
  client,
  primitiveRegistry,
  availableAgents: recallResult.agents,
});
// buildSystemPrompt now accepts { memories, routingHints: recallResult.routing_hints }
```
