import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { Genome, git } from "../../src/genome/genome.ts";
import type { AgentSpec, Memory, RoutingRule } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: overrides.name ?? "test-agent",
		description: overrides.description ?? "A test agent",
		system_prompt: overrides.system_prompt ?? "You are a test agent.",
		model: overrides.model ?? "fast",
		capabilities: overrides.capabilities ?? ["read_file"],
		constraints: overrides.constraints ?? { ...DEFAULT_CONSTRAINTS },
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		content: overrides.content ?? "default memory content",
		tags: overrides.tags ?? ["default"],
		source: overrides.source ?? "test",
		created: overrides.created ?? Date.now(),
		last_used: overrides.last_used ?? Date.now(),
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1.0,
	};
}

function makeRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
	return {
		id: overrides.id ?? `rule-${Date.now()}`,
		condition: overrides.condition ?? "typescript error",
		preference: overrides.preference ?? "code-editor",
		strength: overrides.strength ?? 0.8,
		source: overrides.source ?? "test",
	};
}

describe("Genome", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-genome-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	// --- Init tests ---

	describe("init", () => {
		test("creates directory structure including logs", async () => {
			const root = join(tempDir, "init-dirs");
			const genome = new Genome(root);
			await genome.init();

			const entries = await readdir(root);
			for (const dir of ["agents", "memories", "routing", "embeddings", "metrics", "logs"]) {
				expect(entries).toContain(dir);
			}
		});

		test("creates .gitignore excluding logs directory", async () => {
			const root = join(tempDir, "init-gitignore");
			const genome = new Genome(root);
			await genome.init();

			const content = await readFile(join(root, ".gitignore"), "utf-8");
			expect(content).toContain("logs/");
		});

		test("initializes git repo with initial commit", async () => {
			const root = join(tempDir, "init-git");
			const genome = new Genome(root);
			await genome.init();

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: initialize");
		});

		test("is idempotent", async () => {
			const root = join(tempDir, "init-idempotent");
			const genome = new Genome(root);
			await genome.init();
			await genome.init(); // should not throw

			const log = await git(root, "log", "--oneline");
			// Should still have exactly one commit
			const lines = log.trim().split("\n");
			expect(lines).toHaveLength(1);
		});

		test("creates empty routing rules file", async () => {
			const root = join(tempDir, "init-routing");
			const genome = new Genome(root);
			await genome.init();

			const content = await readFile(join(root, "routing", "rules.yaml"), "utf-8");
			const parsed = parse(content);
			expect(parsed).toEqual([]);
		});
	});

	// --- Agent CRUD tests ---

	describe("agent CRUD", () => {
		test("addAgent writes YAML and commits", async () => {
			const root = join(tempDir, "agent-add");
			const genome = new Genome(root);
			await genome.init();

			const spec = makeSpec({ name: "reader" });
			await genome.addAgent(spec);

			// File exists on disk
			const content = await readFile(join(root, "agents", "reader.yaml"), "utf-8");
			const parsed = parse(content);
			expect(parsed.name).toBe("reader");

			// Git status clean
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");

			// Git log has the commit
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: add agent 'reader'");
		});

		test("getAgent returns undefined for nonexistent", async () => {
			const root = join(tempDir, "agent-get-missing");
			const genome = new Genome(root);
			await genome.init();

			expect(genome.getAgent("nonexistent")).toBeUndefined();
		});

		test("allAgents returns all agents", async () => {
			const root = join(tempDir, "agent-all");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec({ name: "alpha" }));
			await genome.addAgent(makeSpec({ name: "beta" }));

			const agents = genome.allAgents();
			expect(agents).toHaveLength(2);
			const names = agents.map((a) => a.name);
			expect(names).toContain("alpha");
			expect(names).toContain("beta");

			// Verify it's a copy (modifying returned array shouldn't affect internal state)
			agents.pop();
			expect(genome.allAgents()).toHaveLength(2);
		});

		test("agentCount returns correct count", async () => {
			const root = join(tempDir, "agent-count");
			const genome = new Genome(root);
			await genome.init();

			expect(genome.agentCount()).toBe(0);
			await genome.addAgent(makeSpec({ name: "one" }));
			expect(genome.agentCount()).toBe(1);
			await genome.addAgent(makeSpec({ name: "two" }));
			expect(genome.agentCount()).toBe(2);
		});

		test("updateAgent bumps version and commits", async () => {
			const root = join(tempDir, "agent-update");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec({ name: "updater", version: 1 }));
			await genome.updateAgent(makeSpec({ name: "updater", description: "Updated desc" }));

			const agent = genome.getAgent("updater")!;
			expect(agent.version).toBe(2);
			expect(agent.description).toBe("Updated desc");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: update agent 'updater' to v2");
		});

		test("removeAgent deletes YAML and commits", async () => {
			const root = join(tempDir, "agent-remove");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec({ name: "doomed" }));
			expect(genome.getAgent("doomed")).toBeDefined();

			await genome.removeAgent("doomed");
			expect(genome.getAgent("doomed")).toBeUndefined();
			expect(genome.agentCount()).toBe(0);

			// Git status clean
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: remove agent 'doomed'");
		});
	});

	// --- Routing rule tests ---

	describe("routing rules", () => {
		test("addRoutingRule appends and commits", async () => {
			const root = join(tempDir, "rule-add");
			const genome = new Genome(root);
			await genome.init();

			const rule = makeRule({ id: "r1", condition: "typescript" });
			await genome.addRoutingRule(rule);

			const rules = genome.allRoutingRules();
			expect(rules).toHaveLength(1);
			expect(rules[0]!.id).toBe("r1");

			// Verify on disk
			const content = await readFile(join(root, "routing", "rules.yaml"), "utf-8");
			const parsed = parse(content) as RoutingRule[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]!.id).toBe("r1");

			// Git log
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: add routing rule 'r1'");
		});

		test("removeRoutingRule removes and commits", async () => {
			const root = join(tempDir, "rule-remove");
			const genome = new Genome(root);
			await genome.init();

			await genome.addRoutingRule(makeRule({ id: "r1" }));
			await genome.addRoutingRule(makeRule({ id: "r2" }));
			expect(genome.allRoutingRules()).toHaveLength(2);

			await genome.removeRoutingRule("r1");
			const rules = genome.allRoutingRules();
			expect(rules).toHaveLength(1);
			expect(rules[0]!.id).toBe("r2");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: remove routing rule 'r1'");
		});

		test("matchRoutingRules finds by keyword", async () => {
			const root = join(tempDir, "rule-match");
			const genome = new Genome(root);
			await genome.init();

			await genome.addRoutingRule(
				makeRule({ id: "r1", condition: "typescript error", preference: "code-editor" }),
			);
			await genome.addRoutingRule(
				makeRule({ id: "r2", condition: "python testing", preference: "command-runner" }),
			);

			const matches = genome.matchRoutingRules("typescript");
			expect(matches).toHaveLength(1);
			expect(matches[0]!.id).toBe("r1");
		});

		test("matchRoutingRules sorts by strength descending", async () => {
			const root = join(tempDir, "rule-sort");
			const genome = new Genome(root);
			await genome.init();

			await genome.addRoutingRule(
				makeRule({ id: "weak", condition: "code review", strength: 0.3 }),
			);
			await genome.addRoutingRule(
				makeRule({ id: "strong", condition: "code analysis", strength: 0.9 }),
			);
			await genome.addRoutingRule(
				makeRule({ id: "medium", condition: "code formatting", strength: 0.6 }),
			);

			const matches = genome.matchRoutingRules("code");
			expect(matches).toHaveLength(3);
			expect(matches[0]!.id).toBe("strong");
			expect(matches[1]!.id).toBe("medium");
			expect(matches[2]!.id).toBe("weak");
		});

		test("matchRoutingRules returns empty for empty query", async () => {
			const root = join(tempDir, "rule-empty");
			const genome = new Genome(root);
			await genome.init();

			await genome.addRoutingRule(makeRule({ id: "r1" }));

			expect(genome.matchRoutingRules("")).toEqual([]);
			expect(genome.matchRoutingRules("   ")).toEqual([]);
		});
	});

	// --- Load/Bootstrap tests ---

	describe("load and bootstrap", () => {
		test("loadFromDisk loads agents, memories, and routing rules", async () => {
			const root = join(tempDir, "load-disk");
			const genome = new Genome(root);
			await genome.init();

			// Add some data
			await genome.addAgent(makeSpec({ name: "loader-agent" }));
			await genome.addRoutingRule(makeRule({ id: "loader-rule" }));
			await genome.addMemory(makeMemory({ id: "loader-mem", content: "loaded memory" }));

			// Create a fresh Genome pointing at the same dir and load
			const genome2 = new Genome(root);
			await genome2.loadFromDisk();

			expect(genome2.getAgent("loader-agent")).toBeDefined();
			expect(genome2.allRoutingRules()).toHaveLength(1);
			expect(genome2.allRoutingRules()[0]!.id).toBe("loader-rule");
			expect(genome2.memories.all()).toHaveLength(1);
			expect(genome2.memories.all()[0]!.id).toBe("loader-mem");
		});

		test("initFromBootstrap copies 5 bootstrap agents and commits", async () => {
			const root = join(tempDir, "bootstrap-init");
			const genome = new Genome(root);
			await genome.init();

			const bootstrapDir = join(import.meta.dir, "../../bootstrap");
			await genome.initFromBootstrap(bootstrapDir);

			expect(genome.agentCount()).toBe(5);
			expect(genome.getAgent("root")).toBeDefined();
			expect(genome.getAgent("reader")).toBeDefined();
			expect(genome.getAgent("editor")).toBeDefined();
			expect(genome.getAgent("command-runner")).toBeDefined();
			expect(genome.getAgent("web-reader")).toBeDefined();

			// Verify git commit
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: initialize from bootstrap agents");

			// Verify files exist on disk
			const files = await readdir(join(root, "agents"));
			expect(files).toHaveLength(5);
		});

		test("initFromBootstrap throws if agents already exist", async () => {
			const root = join(tempDir, "bootstrap-existing");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "existing" }));

			const bootstrapDir = join(import.meta.dir, "../../bootstrap");
			await expect(genome.initFromBootstrap(bootstrapDir)).rejects.toThrow(/agents already exist/);
		});
	});

	describe("error guards", () => {
		test("updateAgent throws if agent does not exist", async () => {
			const root = join(tempDir, "update-guard");
			const genome = new Genome(root);
			await genome.init();

			await expect(genome.updateAgent(makeSpec({ name: "ghost" }))).rejects.toThrow(/not found/);
		});

		test("removeAgent throws if agent does not exist", async () => {
			const root = join(tempDir, "remove-guard");
			const genome = new Genome(root);
			await genome.init();

			await expect(genome.removeAgent("ghost")).rejects.toThrow(/not found/);
		});
	});

	// --- Memory CRUD via Genome tests ---

	describe("memory CRUD", () => {
		test("addMemory writes JSONL and commits", async () => {
			const root = join(tempDir, "mem-add");
			const genome = new Genome(root);
			await genome.init();

			const mem = makeMemory({ id: "genome-mem-1", content: "important fact" });
			await genome.addMemory(mem);

			// Verify file exists
			const content = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			expect(content).toContain("genome-mem-1");

			// Git log
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: add memory 'genome-mem-1'");
		});

		test("markMemoriesUsed updates use_count and persists to disk", async () => {
			const root = join(tempDir, "mem-used");
			const genome = new Genome(root);
			await genome.init();

			const mem1 = makeMemory({ id: "used-1", use_count: 0 });
			const mem2 = makeMemory({ id: "used-2", use_count: 0 });
			await genome.addMemory(mem1);
			await genome.addMemory(mem2);

			await genome.markMemoriesUsed(["used-1", "used-2"]);

			// Verify in-memory state
			const all = genome.memories.all();
			const m1 = all.find((m) => m.id === "used-1")!;
			const m2 = all.find((m) => m.id === "used-2")!;
			expect(m1.use_count).toBe(1);
			expect(m2.use_count).toBe(1);

			// Verify persisted to disk by loading a fresh Genome
			const genome2 = new Genome(root);
			await genome2.loadFromDisk();
			const reloaded = genome2.memories.all();
			expect(reloaded.find((m) => m.id === "used-1")!.use_count).toBe(1);
			expect(reloaded.find((m) => m.id === "used-2")!.use_count).toBe(1);
		});
	});

	// --- Rollback tests ---

	describe("rollback", () => {
		test("rollback reverts the last mutation", async () => {
			const root = join(tempDir, "rollback-last");
			const genome = new Genome(root);
			await genome.init();

			const bootstrapDir = join(import.meta.dir, "../../bootstrap");
			await genome.initFromBootstrap(bootstrapDir);

			const agentCount = genome.agentCount();
			await genome.addAgent(makeSpec({ name: "extra-agent" }));
			expect(genome.agentCount()).toBe(agentCount + 1);

			await genome.rollback();

			// Verify disk state with a fresh Genome instance
			const genome2 = new Genome(root);
			await genome2.loadFromDisk();
			expect(genome2.agentCount()).toBe(agentCount);
			expect(genome2.getAgent("extra-agent")).toBeUndefined();
		});

		test("lastCommitHash returns the HEAD commit hash", async () => {
			const root = join(tempDir, "last-commit-hash");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec({ name: "hash-agent" }));

			const hash = await genome.lastCommitHash();
			expect(hash).toMatch(/^[0-9a-f]{40}$/);

			// Should match what git rev-parse HEAD returns
			const expected = await git(root, "rev-parse", "HEAD");
			expect(hash).toBe(expected);
		});

		test("rollbackCommit reverts a specific commit", async () => {
			const root = join(tempDir, "rollback-commit");
			const genome = new Genome(root);
			await genome.init();

			await genome.addAgent(makeSpec({ name: "first" }));
			const commitHash = await git(root, "rev-parse", "HEAD");

			await genome.addAgent(makeSpec({ name: "second" }));
			expect(genome.agentCount()).toBe(2);

			await genome.rollbackCommit(commitHash);

			// Verify disk state with a fresh Genome instance
			const genome2 = new Genome(root);
			await genome2.loadFromDisk();
			expect(genome2.agentCount()).toBe(1);
			expect(genome2.getAgent("first")).toBeUndefined();
			expect(genome2.getAgent("second")).toBeDefined();
		});
	});
});
