import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { Genome, git } from "../../src/genome/genome.ts";
import { loadManifest } from "../../src/genome/root-manifest.ts";
import type { AgentSpec, Memory, RoutingRule } from "../../src/kernel/types.ts";
import { makeSpec } from "../helpers/make-spec.ts";

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

	// --- Load/Init tests ---

	describe("load and init", () => {
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

		test("loadFromDisk loads .md agent files using parseAgentMarkdown", async () => {
			const root = join(tempDir, "load-disk-md");
			const genome = new Genome(root);
			await genome.init();

			// Write a .md agent file directly to the genome's agents directory
			const mdContent = [
				"---",
				"name: md-agent",
				"description: A markdown agent",
				"model: fast",
				"---",
				"You are a markdown-defined agent.",
			].join("\n");
			await writeFile(join(root, "agents", "md-agent.md"), mdContent);
			await git(root, "add", ".");
			await git(root, "commit", "-m", "add md agent");

			// Load from disk — should pick up the .md file
			const genome2 = new Genome(root);
			await genome2.loadFromDisk();

			const agent = genome2.getAgent("md-agent");
			expect(agent).toBeDefined();
			expect(agent!.description).toBe("A markdown agent");
			expect(agent!.system_prompt).toBe("You are a markdown-defined agent.");
		});

		test("loadFromDisk loads both .yaml and .md agent files", async () => {
			const root = join(tempDir, "load-disk-mixed");
			const genome = new Genome(root);
			await genome.init();

			// Add a YAML agent via the normal path
			await genome.addAgent(makeSpec({ name: "yaml-agent" }));

			// Write a .md agent file directly
			const mdContent = [
				"---",
				"name: md-agent",
				"description: A markdown agent",
				"model: fast",
				"---",
				"You are a markdown-defined agent.",
			].join("\n");
			await writeFile(join(root, "agents", "md-agent.md"), mdContent);
			await git(root, "add", ".");
			await git(root, "commit", "-m", "add md agent");

			// Load from disk — should pick up both
			const genome2 = new Genome(root);
			await genome2.loadFromDisk();

			expect(genome2.getAgent("yaml-agent")).toBeDefined();
			expect(genome2.getAgent("md-agent")).toBeDefined();
			expect(genome2.agentCount()).toBe(2);
		});

		test("initFromRoot copies root agents and commits", async () => {
			const root = join(tempDir, "init-from-root");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(import.meta.dir, "../../root");
			await genome.initFromRoot(rootDir);

			// Should have loaded all 20 agents from the markdown tree
			expect(genome.agentCount()).toBe(20);

			expect(genome.getAgent("root")).toBeDefined();
			expect(genome.getAgent("reader")).toBeDefined();
			expect(genome.getAgent("editor")).toBeDefined();
			expect(genome.getAgent("command-runner")).toBeDefined();
			expect(genome.getAgent("web-reader")).toBeDefined();
			expect(genome.getAgent("mcp")).toBeDefined();
			expect(genome.getAgent("quartermaster")).toBeDefined();
			expect(genome.getAgent("qm-fabricator")).toBeDefined();
			expect(genome.getAgent("qm-indexer")).toBeDefined();
			expect(genome.getAgent("qm-planner")).toBeDefined();

			// Verify git commit
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: initialize from root agents");

			// Verify files exist on disk
			const files = await readdir(join(root, "agents"));
			expect(files).toHaveLength(20);
		});

		test("initFromRoot throws if agents already exist", async () => {
			const root = join(tempDir, "init-existing");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "existing" }));

			const rootDir = join(import.meta.dir, "../../root");
			await expect(genome.initFromRoot(rootDir)).rejects.toThrow(/agents already exist/);
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

			const rootDir = join(import.meta.dir, "../../root");
			await genome.initFromRoot(rootDir);

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

	describe("Postscripts", () => {
		test("loadPostscripts returns empty strings when no postscripts exist", async () => {
			const root = join(tempDir, "ps-empty");
			const genome = new Genome(root);
			await genome.init();

			const ps = await genome.loadPostscripts();
			expect(ps.global).toBe("");
			expect(ps.orchestrator).toBe("");
			expect(ps.worker).toBe("");
		});

		test("loadPostscripts reads existing postscript files", async () => {
			const root = join(tempDir, "ps-read");
			const genome = new Genome(root);
			await genome.init();

			await writeFile(join(root, "postscripts", "global.md"), "global rules");
			await writeFile(join(root, "postscripts", "worker.md"), "worker rules");

			const ps = await genome.loadPostscripts();
			expect(ps.global).toBe("global rules");
			expect(ps.orchestrator).toBe("");
			expect(ps.worker).toBe("worker rules");
		});

		test("loadAgentPostscript returns empty string when not found", async () => {
			const root = join(tempDir, "ps-agent-missing");
			const genome = new Genome(root);
			await genome.init();

			const content = await genome.loadAgentPostscript("reader");
			expect(content).toBe("");
		});

		test("loadAgentPostscript reads agent-specific postscript", async () => {
			const root = join(tempDir, "ps-agent-read");
			const genome = new Genome(root);
			await genome.init();

			const agentsDir = join(root, "postscripts", "agents");
			await mkdir(agentsDir, { recursive: true });
			await writeFile(join(agentsDir, "reader.md"), "reader-specific rules");

			const content = await genome.loadAgentPostscript("reader");
			expect(content).toBe("reader-specific rules");
		});

		test("savePostscript writes file and commits", async () => {
			const root = join(tempDir, "ps-save");
			const genome = new Genome(root);
			await genome.init();

			await genome.savePostscript("global.md", "saved global rules");

			const content = await readFile(join(root, "postscripts", "global.md"), "utf-8");
			expect(content).toBe("saved global rules");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: save postscript global.md");
		});

		test("savePostscript creates agents subdirectory if needed", async () => {
			const root = join(tempDir, "ps-save-agent");
			const genome = new Genome(root);
			await genome.init();

			await genome.savePostscript("agents/editor.md", "editor-specific rules");

			const content = await readFile(join(root, "postscripts", "agents", "editor.md"), "utf-8");
			expect(content).toBe("editor-specific rules");
		});
	});

	describe("syncRoot (manifest-aware)", () => {
		/** Write a minimal valid root agent YAML file for sync tests. */
		function writeRootYaml(
			dir: string,
			name: string,
			overrides: Partial<AgentSpec> = {},
		): Promise<void> {
			const spec = makeSpec({ name, ...overrides });
			return writeFile(join(dir, `${name}.yaml`), stringify(spec));
		}

		test("adds new bootstrap agents and records manifest", async () => {
			const root = join(tempDir, "sync-manifest-add");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-manifest-add-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootYaml(rootDir, "alpha", { description: "Alpha agent" });
			await writeRootYaml(rootDir, "beta", { description: "Beta agent" });

			const result = await genome.syncRoot(rootDir);

			expect(result.added).toContain("alpha");
			expect(result.added).toContain("beta");
			expect(result.updated).toEqual([]);
			expect(result.conflicts).toEqual([]);

			// Agents exist in genome
			expect(genome.getAgent("alpha")).toBeDefined();
			expect(genome.getAgent("beta")).toBeDefined();

			// Manifest was saved
			const manifest = await loadManifest(join(root, "bootstrap-manifest.json"));
			expect(manifest.agents.alpha).toBeDefined();
			expect(manifest.agents.beta).toBeDefined();
			expect(manifest.synced_at).not.toBe("");
		});

		test("skips agents unchanged in both bootstrap and genome", async () => {
			const root = join(tempDir, "sync-manifest-noop");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-manifest-noop-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootYaml(rootDir, "stable");

			// First sync — adds the agent
			const first = await genome.syncRoot(rootDir);
			expect(first.added).toEqual(["stable"]);

			// Second sync — nothing should change
			const second = await genome.syncRoot(rootDir);
			expect(second.added).toEqual([]);
			expect(second.updated).toEqual([]);
			expect(second.conflicts).toEqual([]);

			// Working tree must be clean (no dirty manifest from timestamp churn)
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
		});

		test("updates genome agent when bootstrap changed but genome did not evolve", async () => {
			const root = join(tempDir, "sync-manifest-update");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-manifest-update-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootYaml(rootDir, "updatable", {
				description: "Original description",
			});

			// First sync
			await genome.syncRoot(rootDir);
			expect(genome.getAgent("updatable")!.description).toBe("Original description");

			// Change bootstrap file
			await writeRootYaml(rootDir, "updatable", {
				description: "Updated description",
			});

			// Second sync — should update
			const result = await genome.syncRoot(rootDir);
			expect(result.updated).toEqual(["updatable"]);
			expect(result.added).toEqual([]);
			expect(result.conflicts).toEqual([]);

			// Verify genome was updated
			expect(genome.getAgent("updatable")!.description).toBe("Updated description");
		});

		test("detects conflict when both bootstrap and genome evolved", async () => {
			const root = join(tempDir, "sync-manifest-conflict");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-manifest-conflict-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootYaml(rootDir, "contested", {
				description: "Bootstrap original",
			});

			// First sync
			await genome.syncRoot(rootDir);
			expect(genome.getAgent("contested")!.version).toBe(1);

			// Evolve genome (this bumps version to 2)
			await genome.updateAgent(makeSpec({ name: "contested", description: "Genome evolved" }));
			expect(genome.getAgent("contested")!.version).toBe(2);

			// Change bootstrap file
			await writeRootYaml(rootDir, "contested", {
				description: "Bootstrap also changed",
			});

			// Sync again — should detect conflict
			const result = await genome.syncRoot(rootDir);
			expect(result.conflicts).toEqual(["contested"]);
			expect(result.added).toEqual([]);
			expect(result.updated).toEqual([]);

			// Genome version is preserved (not overwritten)
			expect(genome.getAgent("contested")!.description).toBe("Genome evolved");
			expect(genome.getAgent("contested")!.version).toBe(2);
		});

		test("preserves genome evolution when bootstrap unchanged", async () => {
			const root = join(tempDir, "sync-manifest-preserve");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-manifest-preserve-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootYaml(rootDir, "evolved", {
				description: "Bootstrap original",
			});

			// First sync
			await genome.syncRoot(rootDir);

			// Evolve genome
			await genome.updateAgent(
				makeSpec({ name: "evolved", description: "Genome learned something" }),
			);
			expect(genome.getAgent("evolved")!.version).toBe(2);

			// Sync again with unchanged bootstrap
			const result = await genome.syncRoot(rootDir);
			expect(result.added).toEqual([]);
			expect(result.updated).toEqual([]);
			expect(result.conflicts).toEqual([]);

			// Genome version is preserved
			expect(genome.getAgent("evolved")!.description).toBe("Genome learned something");
			expect(genome.getAgent("evolved")!.version).toBe(2);
		});

		test("merges new capabilities into root agent when bootstrap root references them", async () => {
			const root = join(tempDir, "sync-cap-merge");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-cap-merge-bs");
			await mkdir(rootDir, { recursive: true });

			// Bootstrap has root with 3 capabilities and the corresponding agents
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "editor", "debugger"],
			});
			await writeRootYaml(rootDir, "reader");
			await writeRootYaml(rootDir, "editor");
			await writeRootYaml(rootDir, "debugger");

			// First sync — adds root, reader, editor, debugger
			await genome.syncRoot(rootDir);
			expect(genome.getAgent("root")!.capabilities).toEqual(["reader", "editor", "debugger"]);

			// Now update bootstrap root to add "verifier" capability, and add verifier.yaml
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "editor", "debugger", "verifier"],
			});
			await writeRootYaml(rootDir, "verifier");

			// Sync again
			await genome.syncRoot(rootDir);

			// Root's capabilities should now include verifier
			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.capabilities).toContain("reader");
			expect(rootAgent.capabilities).toContain("editor");
			expect(rootAgent.capabilities).toContain("debugger");
			expect(rootAgent.capabilities).toContain("verifier");
		});

		test("merges bootstrap capabilities into evolved root without removing genome-only caps", async () => {
			const root = join(tempDir, "sync-cap-merge-evolved");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-cap-merge-evolved-bs");
			await mkdir(rootDir, { recursive: true });

			// Bootstrap starts with root listing just ["reader"]
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader"],
			});
			await writeRootYaml(rootDir, "reader");

			// First sync — adds root and reader
			await genome.syncRoot(rootDir);
			expect(genome.getAgent("root")!.capabilities).toEqual(["reader"]);

			// Evolve genome root to add a custom capability
			const evolvedRoot = genome.getAgent("root")!;
			await genome.updateAgent({
				...evolvedRoot,
				capabilities: ["reader", "custom-agent"],
				system_prompt: "Evolved system prompt",
			});
			expect(genome.getAgent("root")!.capabilities).toEqual(["reader", "custom-agent"]);
			expect(genome.getAgent("root")!.system_prompt).toBe("Evolved system prompt");

			// Update bootstrap root to add "debugger" and add debugger.yaml
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "debugger"],
			});
			await writeRootYaml(rootDir, "debugger");

			// Sync again — root is a conflict (both sides changed), but capabilities should merge
			const result = await genome.syncRoot(rootDir);

			// Root agent should have all three: reader (shared), custom-agent (genome-only), debugger (bootstrap-new)
			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.capabilities).toContain("reader");
			expect(rootAgent.capabilities).toContain("custom-agent");
			expect(rootAgent.capabilities).toContain("debugger");

			// Genome's evolved system_prompt should be preserved (not overwritten by bootstrap)
			expect(rootAgent.system_prompt).toBe("Evolved system prompt");

			// Verify debugger was added as a new agent
			expect(result.added).toContain("debugger");
		});

		test("removes capabilities from genome root that bootstrap explicitly dropped", async () => {
			const root = join(tempDir, "sync-cap-remove");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-cap-remove-bs");
			await mkdir(rootDir, { recursive: true });

			// Bootstrap starts with root listing ["reader", "editor", "debugger"]
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "editor", "debugger"],
			});
			await writeRootYaml(rootDir, "reader");
			await writeRootYaml(rootDir, "editor");
			await writeRootYaml(rootDir, "debugger");

			// First sync — adds root, reader, editor, debugger
			await genome.syncRoot(rootDir);
			expect(genome.getAgent("root")!.capabilities).toEqual(["reader", "editor", "debugger"]);

			// Bootstrap drops "debugger" from root capabilities
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "editor"],
			});

			// Sync again
			await genome.syncRoot(rootDir);

			// Root should no longer have "debugger"
			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.capabilities).toContain("reader");
			expect(rootAgent.capabilities).toContain("editor");
			expect(rootAgent.capabilities).not.toContain("debugger");
		});

		test("commit message includes both capabilities and conflict info", async () => {
			const root = join(tempDir, "sync-commit-msg");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-commit-msg-bs");
			await mkdir(rootDir, { recursive: true });

			// Bootstrap with root listing ["reader"] and an agent "alpha"
			await writeRootYaml(rootDir, "root", { capabilities: ["reader"] });
			await writeRootYaml(rootDir, "reader");
			await writeRootYaml(rootDir, "alpha", { description: "Original alpha" });

			// First sync
			await genome.syncRoot(rootDir);

			// Evolve alpha in genome (creates conflict on next sync)
			await genome.updateAgent(makeSpec({ name: "alpha", description: "Genome-evolved alpha" }));

			// Bootstrap changes alpha AND adds "verifier" to root capabilities
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "verifier"],
			});
			await writeRootYaml(rootDir, "alpha", {
				description: "Bootstrap-updated alpha",
			});
			await writeRootYaml(rootDir, "verifier");

			// Sync again — should have capsMerged + conflict on alpha
			const result = await genome.syncRoot(rootDir);
			expect(result.conflicts).toContain("alpha");
			expect(result.added).toContain("verifier");

			// Check the git commit message mentions both
			const log = await git(root, "log", "--oneline", "-1");
			expect(log).toContain("alpha");
		});

		test("preserves genome-added capabilities when bootstrap drops its own", async () => {
			const root = join(tempDir, "sync-cap-remove-preserve");
			const genome = new Genome(root);
			await genome.init();

			const rootDir = join(tempDir, "sync-cap-remove-preserve-bs");
			await mkdir(rootDir, { recursive: true });

			// Bootstrap starts with root listing ["reader", "debugger"]
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "debugger"],
			});
			await writeRootYaml(rootDir, "reader");
			await writeRootYaml(rootDir, "debugger");

			// First sync
			await genome.syncRoot(rootDir);

			// Genome evolves root to add "custom-agent"
			const evolvedRoot = genome.getAgent("root")!;
			await genome.updateAgent({
				...evolvedRoot,
				capabilities: ["reader", "debugger", "custom-agent"],
				system_prompt: "Evolved root",
			});

			// Bootstrap drops "debugger" and adds "editor"
			await writeRootYaml(rootDir, "root", {
				capabilities: ["reader", "editor"],
			});
			await writeRootYaml(rootDir, "editor");

			// Sync again
			await genome.syncRoot(rootDir);

			// Root should have: reader (kept), editor (added by bootstrap), custom-agent (genome-only)
			// But NOT debugger (dropped by bootstrap)
			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.capabilities).toContain("reader");
			expect(rootAgent.capabilities).toContain("editor");
			expect(rootAgent.capabilities).toContain("custom-agent");
			expect(rootAgent.capabilities).not.toContain("debugger");
		});
	});
});
