import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { parseAgentMarkdown, serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { Genome, git, sanitizeGitEnv } from "../../src/genome/genome.ts";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import { loadManifest } from "../../src/genome/root-manifest.ts";
import type { MemorySegment } from "../../src/genome/segments.ts";
import type { AgentSpec, Memory, RoutingRule } from "../../src/kernel/types.ts";
import type { EmbeddingProvider } from "../../src/llm/embeddings.ts";
import { makeSpec } from "../helpers/make-spec.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

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

function makeSegment(overrides: Partial<MemorySegment> = {}): MemorySegment {
	return {
		id: overrides.id ?? "segment-1",
		session_id: overrides.session_id ?? "session-1",
		summary: overrides.summary ?? "Implemented memory persistence.",
		title: overrides.title ?? "Memory persistence",
		started_at: overrides.started_at ?? 100,
		ended_at: overrides.ended_at ?? 200,
		created_at: overrides.created_at ?? 200,
		message_count: overrides.message_count ?? 3,
		project_id: overrides.project_id ?? "sprout",
		project_confidence: overrides.project_confidence ?? 1,
		complexity: overrides.complexity ?? 2,
		source: "session-collapse",
		...overrides,
	};
}

async function readOptionalFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch (err) {
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return "";
		}
		throw err;
	}
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
	let initTemplateDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-genome-"));
		initTemplateDir = join(tempDir, "__init-template");
		const template = new Genome(initTemplateDir);
		await template.init();
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function createInitializedGenome(rootPath: string, rootDir?: string): Promise<Genome> {
		await cp(initTemplateDir, rootPath, { recursive: true });
		return createTestGenome(rootPath, rootDir);
	}

	// --- Init tests ---

	describe("init", () => {
		test("creates directory structure including logs", async () => {
			const root = join(tempDir, "init-dirs");
			const genome = new Genome(root);
			await genome.init();

			const entries = await readdir(root);
			for (const dir of [
				"agents",
				"memories",
				"routing",
				"embeddings",
				"metrics",
				"logs",
				".cache",
			]) {
				expect(entries).toContain(dir);
			}
		});

		test("creates .gitignore excluding logs directory", async () => {
			const root = join(tempDir, "init-gitignore");
			const genome = new Genome(root);
			await genome.init();

			const content = await readFile(join(root, ".gitignore"), "utf-8");
			expect(content).toContain("logs/");
			expect(content).toContain(".cache/");
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

	describe("git helper", () => {
		test("strips inherited git repo selection env", () => {
			const sanitized = sanitizeGitEnv({
				...process.env,
				GIT_DIR: "/tmp/outer/.git",
				GIT_WORK_TREE: "/tmp/outer",
				GIT_INDEX_FILE: "/tmp/outer/.git/index",
				GIT_COMMON_DIR: "/tmp/outer/.git",
				GIT_PREFIX: "nested/",
				KEEP_ME: "yes",
			});

			expect(sanitized.GIT_DIR).toBeUndefined();
			expect(sanitized.GIT_WORK_TREE).toBeUndefined();
			expect(sanitized.GIT_INDEX_FILE).toBeUndefined();
			expect(sanitized.GIT_COMMON_DIR).toBeUndefined();
			expect(sanitized.GIT_PREFIX).toBeUndefined();
			expect(sanitized.KEEP_ME).toBe("yes");
		});
	});

	// --- Agent CRUD tests ---

	describe("agent CRUD", () => {
		test("addAgent writes .md file and commits", async () => {
			const root = join(tempDir, "agent-add");
			const genome = await createInitializedGenome(root);

			const spec = makeSpec({ name: "reader" });
			await genome.addAgent(spec);

			// File exists on disk as .md
			const content = await readFile(join(root, "agents", "reader.md"), "utf-8");
			const parsed = parseAgentMarkdown(content, "reader.md");
			expect(parsed.name).toBe("reader");

			// Git status clean
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");

			// Git log has the commit
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: add agent 'reader'");
		});

		test("addAgent writes .md not .yaml", async () => {
			const root = join(tempDir, "agent-add-no-yaml");
			const genome = await createInitializedGenome(root);

			await genome.addAgent(makeSpec({ name: "checker" }));

			const files = await readdir(join(root, "agents"));
			expect(files).toContain("checker.md");
			expect(files).not.toContain("checker.yaml");
		});

		test("getAgent returns undefined for nonexistent", async () => {
			const root = join(tempDir, "agent-get-missing");
			const genome = await createInitializedGenome(root);

			expect(genome.getAgent("nonexistent")).toBeUndefined();
		});

		test("allAgents returns all agents", async () => {
			const root = join(tempDir, "agent-all");
			const genome = await createInitializedGenome(root);

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
			const genome = await createInitializedGenome(root);

			expect(genome.agentCount()).toBe(0);
			await genome.addAgent(makeSpec({ name: "one" }));
			expect(genome.agentCount()).toBe(1);
			await genome.addAgent(makeSpec({ name: "two" }));
			expect(genome.agentCount()).toBe(2);
		});

		test("updateAgent bumps version and commits", async () => {
			const root = join(tempDir, "agent-update");
			const genome = await createInitializedGenome(root);

			await genome.addAgent(makeSpec({ name: "updater", version: 1 }));
			await genome.updateAgent(makeSpec({ name: "updater", description: "Updated desc" }));

			const agent = genome.getAgent("updater")!;
			expect(agent.version).toBe(2);
			expect(agent.description).toBe("Updated desc");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: update agent 'updater' to v2");
		});

		test("removeAgent deletes .md file and commits", async () => {
			const root = join(tempDir, "agent-remove");
			const genome = await createInitializedGenome(root);

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
			const genome = await createInitializedGenome(root);

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
			const genome = await createInitializedGenome(root);

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
			const genome = await createInitializedGenome(root);

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
			const genome = await createInitializedGenome(root);

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
			const genome = await createInitializedGenome(root);

			await genome.addRoutingRule(makeRule({ id: "r1" }));

			expect(genome.matchRoutingRules("")).toEqual([]);
			expect(genome.matchRoutingRules("   ")).toEqual([]);
		});
	});

	// --- Load/Init tests ---

	describe("load and init", () => {
		test("loadFromDisk loads agents, memories, and routing rules", async () => {
			const root = join(tempDir, "load-disk");
			const genome = await createInitializedGenome(root);

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
			await createInitializedGenome(root);

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

		test("initFromRoot loads root agents and saves manifest (no file copy)", async () => {
			const root = join(tempDir, "init-from-root");
			const rootDir = join(import.meta.dir, "../../root");
			const genome = await createInitializedGenome(root, rootDir);

			await genome.initFromRoot();

			// Should have loaded all 23 agents from root (via rootAgents)
			expect(genome.agentCount()).toBe(23);

			expect(genome.getAgent("root")).toBeDefined();
			expect(genome.getAgent("archivist")).toBeDefined();
			expect(genome.getAgent("reader")).toBeDefined();
			expect(genome.getAgent("editor")).toBeDefined();
			expect(genome.getAgent("command-runner")).toBeDefined();
			expect(genome.getAgent("web-reader")).toBeDefined();
			expect(genome.getAgent("mcp")).toBeDefined();
			expect(genome.getAgent("quartermaster")).toBeDefined();
			expect(genome.getAgent("qm-fabricator")).toBeDefined();
			expect(genome.getAgent("qm-indexer")).toBeDefined();
			expect(genome.getAgent("qm-planner")).toBeDefined();

			// Verify git commit (manifest saved)
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: initialize from root agents");

			// Verify NO agent files in genome's agents/ directory (overlay is empty)
			const files = await readdir(join(root, "agents"));
			expect(files).toHaveLength(0);

			// All agents resolve from root, none from overlay
			expect(genome.overlayAgents()).toHaveLength(0);
			expect(genome.isOverlay("root")).toBe(false);
		});
	});

	describe("error guards", () => {
		test("updateAgent throws if agent does not exist", async () => {
			const root = join(tempDir, "update-guard");
			const genome = await createInitializedGenome(root);

			await expect(genome.updateAgent(makeSpec({ name: "ghost" }))).rejects.toThrow(/not found/);
		});

		test("removeAgent throws if agent does not exist", async () => {
			const root = join(tempDir, "remove-guard");
			const genome = await createInitializedGenome(root);

			await expect(genome.removeAgent("ghost")).rejects.toThrow(/not found/);
		});
	});

	// --- Memory CRUD via Genome tests ---

	describe("memory CRUD", () => {
		test("addMemory writes JSONL and commits", async () => {
			const root = join(tempDir, "mem-add");
			const genome = await createInitializedGenome(root);

			const mem = makeMemory({ id: "genome-mem-1", content: "important fact" });
			await genome.addMemory(mem);

			// Verify file exists
			const content = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			expect(content).toContain("genome-mem-1");
			const parsed = JSON.parse(content.trim()) as Memory;
			expect(parsed.embedding?.status).toBe("ready");
			expect(parsed.embedding?.provider).toBe("fake");
			expect(parsed.embedding?.vector).toHaveLength(768);

			// Git log
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: add memory 'genome-mem-1'");

			const index = MemoryIndex.open(memoryIndexPath(root));
			try {
				expect(index.stats()).toMatchObject({ memoryCount: 1, embeddingCount: 1 });
			} finally {
				index.close();
			}
		});

		test("searchMemories reuses a fresh derived index", async () => {
			const root = join(tempDir, "mem-search-index-fresh");
			const genome = await createInitializedGenome(root);
			await genome.addMemory(makeMemory({ id: "indexed-memory", content: "SQLite recall fact" }));
			const indexPath = memoryIndexPath(root);
			const before = (await stat(indexPath)).mtimeMs;

			expect(await genome.searchMemories("SQLite recall", 1)).toHaveLength(1);
			const afterFirstSearch = (await stat(indexPath)).mtimeMs;
			expect(await genome.searchMemories("SQLite recall", 1)).toHaveLength(1);
			const afterSecondSearch = (await stat(indexPath)).mtimeMs;

			expect(afterFirstSearch).toBe(before);
			expect(afterSecondSearch).toBe(before);
		});

		test("searchMemories excludes superseded recall candidates", async () => {
			const root = join(tempDir, "mem-search-superseded");
			const genome = await createInitializedGenome(root);
			await genome.addMemory(
				makeMemory({ id: "old-memory", content: "Obsolete SQLite recall decision" }),
			);
			await genome.addMemory(
				makeMemory({ id: "new-memory", content: "Current memory decision uses SQLite recall" }),
			);
			const oldMemory = genome.memories.getById("old-memory")!;
			oldMemory.superseded_by = "new-memory";
			oldMemory.inbound_links = [
				{
					uuid: "new-memory",
					type: "supersedes",
					reasoning: "replaced",
					created_at: 123,
				},
			];
			await genome.saveMemoryMutation("genome: supersede old memory");

			const results = await genome.searchMemories("Obsolete SQLite recall", 5);

			expect(results.map((memory) => memory.id)).not.toContain("old-memory");
		});

		test("saveMemoryMutation commits JSONL changes and rebuilds index", async () => {
			const root = join(tempDir, "mem-mutation");
			const genome = await createInitializedGenome(root);

			await genome.addMemory(makeMemory({ id: "genome-mem-mutate", content: "mutable fact" }));
			const memory = genome.memories.getById("genome-mem-mutate");
			expect(memory).toBeDefined();
			memory!.archived_at = 12345;
			memory!.archived_reason = "mutation test";
			await genome.saveMemoryMutation("genome: archive memory 'genome-mem-mutate'");

			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: archive memory 'genome-mem-mutate'");
			const content = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			expect(content).toContain('"archived_at":12345');

			const index = MemoryIndex.open(memoryIndexPath(root));
			try {
				expect(index.stats()).toMatchObject({ memoryCount: 1, embeddingCount: 0 });
			} finally {
				index.close();
			}
		});

		test("recomputeMemoryScores commits score-based archival mutations", async () => {
			const root = join(tempDir, "mem-score-archive");
			const genome = await createInitializedGenome(root);
			await genome.addMemory(
				makeMemory({ id: "low-importance-memory", content: "old minor fact" }),
			);

			const result = await genome.recomputeMemoryScores({ now: 12345, minImportance: 1 });

			expect(result.archived).toEqual(["low-importance-memory"]);
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: archive 1 low-importance memories");
		});

		test("recomputeMemoryScores commits score-only metadata updates", async () => {
			const root = join(tempDir, "mem-score-update");
			const genome = await createInitializedGenome(root);
			await genome.addMemory(
				makeMemory({
					id: "score-only-memory",
					content: "recent useful fact",
					importance_score: 0,
					effective_importance: 0,
				}),
			);

			const result = await genome.recomputeMemoryScores({ now: 12345, minImportance: 0 });

			expect(result.updated).toEqual(["score-only-memory"]);
			expect(result.archived).toEqual([]);
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: update memory importance scores");
		});

		test("project activity mutations can be committed cleanly", async () => {
			const root = join(tempDir, "project-activity-commit");
			const genome = await createInitializedGenome(root);
			const changed = await genome.recordProjectActivity({
				id: "sprout",
				name: "Sprout",
				confidence: 1,
				source: "explicit",
			});

			expect(changed).toBe(true);
			await genome.saveProjectActivityMutation("genome: record project activity 'sprout'");

			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: record project activity 'sprout'");
		});

		test("addSegmentWithMemories restores JSONL files when save fails", async () => {
			const root = join(tempDir, "segment-memory-save-fails");
			const genome = await createInitializedGenome(root);
			const originalSave = genome.memories.save.bind(genome.memories);
			genome.memories.save = async () => {
				throw new Error("memory save failed");
			};

			await expect(
				genome.addSegmentWithMemories(makeSegment({ id: "segment-fail" }), [
					makeMemory({ id: "memory-fail", content: "will not persist" }),
				]),
			).rejects.toThrow("memory save failed");
			genome.memories.save = originalSave;

			expect(genome.segments.getById("segment-fail")).toBeUndefined();
			expect(genome.memories.getById("memory-fail")).toBeUndefined();
			expect(await readOptionalFile(join(root, "memories", "segments.jsonl"))).not.toContain(
				"segment-fail",
			);
			expect(await readOptionalFile(join(root, "memories", "memories.jsonl"))).not.toContain(
				"memory-fail",
			);
			expect(await git(root, "status", "--porcelain")).toBe("");
		});

		test("addMemory fails before writing when embedding generation fails", async () => {
			const root = join(tempDir, "mem-add-embedding-fails");
			await cp(initTemplateDir, root, { recursive: true });
			const brokenProvider: EmbeddingProvider = {
				provider: "broken",
				model: "broken",
				dimensions: 768,
				embedBatch: async () => {
					throw new Error("embedding model unavailable");
				},
			};
			const genome = new Genome(root, undefined, { embeddingProvider: brokenProvider });

			await expect(
				genome.addMemory(makeMemory({ id: "bad-memory", content: "will not persist" })),
			).rejects.toThrow("embedding model unavailable");

			expect(genome.memories.all()).toEqual([]);
			await expect(readFile(join(root, "memories", "memories.jsonl"), "utf-8")).rejects.toThrow();
		});

		test("markMemoriesUsed updates use_count and persists to disk", async () => {
			const root = join(tempDir, "mem-used");
			const genome = await createInitializedGenome(root);

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
			const rootDir = join(import.meta.dir, "../../root");
			const genome = await createInitializedGenome(root, rootDir);

			await genome.initFromRoot();

			const agentCount = genome.agentCount();
			await genome.addAgent(makeSpec({ name: "extra-agent" }));
			expect(genome.agentCount()).toBe(agentCount + 1);

			await genome.rollback();

			// Verify in-memory state of the original instance is correct
			expect(genome.agentCount()).toBe(agentCount);
			expect(genome.getAgent("extra-agent")).toBeUndefined();

			// Verify disk state with a fresh Genome instance
			const genome2 = new Genome(root, rootDir);
			await genome2.loadFromDisk();
			expect(genome2.agentCount()).toBe(agentCount);
			expect(genome2.getAgent("extra-agent")).toBeUndefined();
		});

		test("lastCommitHash returns the HEAD commit hash", async () => {
			const root = join(tempDir, "last-commit-hash");
			const genome = await createInitializedGenome(root);

			await genome.addAgent(makeSpec({ name: "hash-agent" }));

			const hash = await genome.lastCommitHash();
			expect(hash).toMatch(/^[0-9a-f]{40}$/);

			// Should match what git rev-parse HEAD returns
			const expected = await git(root, "rev-parse", "HEAD");
			expect(hash).toBe(expected);
		});

		test("rollbackCommit reverts a specific commit", async () => {
			const root = join(tempDir, "rollback-commit");
			const genome = await createInitializedGenome(root);

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
			const genome = await createInitializedGenome(root);

			const ps = await genome.loadPostscripts();
			expect(ps.global).toBe("");
			expect(ps.orchestrator).toBe("");
			expect(ps.worker).toBe("");
		});

		test("loadPostscripts reads existing postscript files", async () => {
			const root = join(tempDir, "ps-read");
			const genome = await createInitializedGenome(root);

			await writeFile(join(root, "postscripts", "global.md"), "global rules");
			await writeFile(join(root, "postscripts", "worker.md"), "worker rules");

			const ps = await genome.loadPostscripts();
			expect(ps.global).toBe("global rules");
			expect(ps.orchestrator).toBe("");
			expect(ps.worker).toBe("worker rules");
		});

		test("loadAgentPostscript returns empty string when not found", async () => {
			const root = join(tempDir, "ps-agent-missing");
			const genome = await createInitializedGenome(root);

			const content = await genome.loadAgentPostscript("reader");
			expect(content).toBe("");
		});

		test("loadAgentPostscript reads agent-specific postscript", async () => {
			const root = join(tempDir, "ps-agent-read");
			const genome = await createInitializedGenome(root);

			const agentsDir = join(root, "postscripts", "agents");
			await mkdir(agentsDir, { recursive: true });
			await writeFile(join(agentsDir, "reader.md"), "reader-specific rules");

			const content = await genome.loadAgentPostscript("reader");
			expect(content).toBe("reader-specific rules");
		});

		test("savePostscript writes file and commits", async () => {
			const root = join(tempDir, "ps-save");
			const genome = await createInitializedGenome(root);

			await genome.savePostscript("global.md", "saved global rules");

			const content = await readFile(join(root, "postscripts", "global.md"), "utf-8");
			expect(content).toBe("saved global rules");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: save postscript global.md");
		});

		test("savePostscript creates agents subdirectory if needed", async () => {
			const root = join(tempDir, "ps-save-agent");
			const genome = await createInitializedGenome(root);

			await genome.savePostscript("agents/editor.md", "editor-specific rules");

			const content = await readFile(join(root, "postscripts", "agents", "editor.md"), "utf-8");
			expect(content).toBe("editor-specific rules");
		});
	});

	describe("syncRoot (manifest-aware)", () => {
		/** Write a root agent Markdown file into the proper tree layout. */
		async function writeRootMd(
			dir: string,
			name: string,
			overrides: Partial<AgentSpec> = {},
		): Promise<void> {
			const spec = makeSpec({ name, ...overrides });
			if (name === "root") {
				await writeFile(join(dir, "root.md"), serializeAgentMarkdown(spec));
			} else {
				const agentsDir = join(dir, "agents");
				await mkdir(agentsDir, { recursive: true });
				await writeFile(join(agentsDir, `${name}.md`), serializeAgentMarkdown(spec));
			}
		}

		test("detects new root agents and records manifest", async () => {
			const rootDir = join(tempDir, "sync-manifest-add-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "alpha", { description: "Alpha agent" });
			await writeRootMd(rootDir, "beta", { description: "Beta agent" });

			const root = join(tempDir, "sync-manifest-add");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			const result = await genome.syncRoot();

			expect(result.added).toContain("alpha");
			expect(result.added).toContain("beta");
			expect(result.conflicts).toEqual([]);

			// Agents resolve from root (not overlay)
			expect(genome.getAgent("alpha")).toBeDefined();
			expect(genome.getAgent("beta")).toBeDefined();
			expect(genome.isOverlay("alpha")).toBe(false);

			// Manifest was saved
			const manifest = await loadManifest(join(root, "bootstrap-manifest.json"));
			expect(manifest.agents.alpha).toBeDefined();
			expect(manifest.agents.beta).toBeDefined();
			expect(manifest.synced_at).not.toBe("");
		});

		test("skips agents unchanged in both root and genome", async () => {
			const rootDir = join(tempDir, "sync-manifest-noop-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "stable");

			const root = join(tempDir, "sync-manifest-noop");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync — detects the agent
			const first = await genome.syncRoot();
			expect(first.added).toEqual(["stable"]);

			// Second sync — nothing should change
			const second = await genome.syncRoot();
			expect(second.added).toEqual([]);
			expect(second.conflicts).toEqual([]);

			// Working tree must be clean (no dirty manifest from timestamp churn)
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
		});

		test("root change auto-reflects when genome has no overlay", async () => {
			const rootDir = join(tempDir, "sync-manifest-update-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "updatable", {
				description: "Original description",
			});

			const root = join(tempDir, "sync-manifest-update");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();
			expect(genome.getAgent("updatable")!.description).toBe("Original description");

			// Change root file
			await writeRootMd(rootDir, "updatable", {
				description: "Updated description",
			});

			// Sync — refreshes rootAgents, auto-reflects the change
			const result = await genome.syncRoot();
			expect(result.added).toEqual([]);
			expect(result.conflicts).toEqual([]);

			// Verify agent was updated (resolved from root)
			expect(genome.getAgent("updatable")!.description).toBe("Updated description");
		});

		test("detects conflict when both root and genome evolved", async () => {
			const rootDir = join(tempDir, "sync-manifest-conflict-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "contested", {
				description: "Bootstrap original",
			});

			const root = join(tempDir, "sync-manifest-conflict");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();
			expect(genome.getAgent("contested")!.version).toBe(1);

			// Evolve genome (promotes to overlay, bumps version to 2)
			await genome.updateAgent(makeSpec({ name: "contested", description: "Genome evolved" }));
			expect(genome.getAgent("contested")!.version).toBe(2);

			// Change root file
			await writeRootMd(rootDir, "contested", {
				description: "Bootstrap also changed",
			});

			// Sync again — should detect conflict
			const result = await genome.syncRoot();
			expect(result.conflicts).toEqual(["contested"]);
			expect(result.added).toEqual([]);

			// Genome overlay is preserved (not overwritten)
			expect(genome.getAgent("contested")!.description).toBe("Genome evolved");
			expect(genome.getAgent("contested")!.version).toBe(2);
		});

		test("preserves genome evolution when root unchanged", async () => {
			const rootDir = join(tempDir, "sync-manifest-preserve-bs");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "evolved", {
				description: "Bootstrap original",
			});

			const root = join(tempDir, "sync-manifest-preserve");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();

			// Evolve genome (promotes to overlay)
			await genome.updateAgent(
				makeSpec({ name: "evolved", description: "Genome learned something" }),
			);
			expect(genome.getAgent("evolved")!.version).toBe(2);

			// Sync again with unchanged root
			const result = await genome.syncRoot();
			expect(result.added).toEqual([]);
			expect(result.conflicts).toEqual([]);

			// Genome overlay is preserved
			expect(genome.getAgent("evolved")!.description).toBe("Genome learned something");
			expect(genome.getAgent("evolved")!.version).toBe(2);
		});

		test("root tools auto-reflect when genome root is not in overlay", async () => {
			const rootDir = join(tempDir, "sync-cap-merge-bs");
			await mkdir(rootDir, { recursive: true });

			// Root has 3 tools
			await writeRootMd(rootDir, "root", {
				tools: ["reader", "editor", "debugger"],
			});
			await writeRootMd(rootDir, "reader");
			await writeRootMd(rootDir, "editor");
			await writeRootMd(rootDir, "debugger");

			const root = join(tempDir, "sync-cap-merge");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();
			expect(genome.getAgent("root")!.tools).toEqual(["reader", "editor", "debugger"]);

			// Root adds "verifier"
			await writeRootMd(rootDir, "root", {
				tools: ["reader", "editor", "debugger", "verifier"],
			});
			await writeRootMd(rootDir, "verifier");

			// Sync again — auto-reflects since root is not in overlay
			await genome.syncRoot();

			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.tools).toContain("reader");
			expect(rootAgent.tools).toContain("editor");
			expect(rootAgent.tools).toContain("debugger");
			expect(rootAgent.tools).toContain("verifier");
		});

		test("merges root tools into evolved root overlay without removing genome-only entries", async () => {
			const rootDir = join(tempDir, "sync-cap-merge-evolved-bs");
			await mkdir(rootDir, { recursive: true });

			// Root starts with just ["reader"]
			await writeRootMd(rootDir, "root", {
				tools: ["reader"],
			});
			await writeRootMd(rootDir, "reader");

			const root = join(tempDir, "sync-cap-merge-evolved");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();
			expect(genome.getAgent("root")!.tools).toEqual(["reader"]);

			// Evolve genome root to add a custom entry (promotes to overlay)
			const evolvedRoot = genome.getAgent("root")!;
			await genome.updateAgent({
				...evolvedRoot,
				tools: ["reader", "custom-agent"],
				system_prompt: "Evolved system prompt",
			});
			expect(genome.getAgent("root")!.tools).toEqual(["reader", "custom-agent"]);
			expect(genome.getAgent("root")!.system_prompt).toBe("Evolved system prompt");

			// Root adds "debugger"
			await writeRootMd(rootDir, "root", {
				tools: ["reader", "debugger"],
			});
			await writeRootMd(rootDir, "debugger");

			// Sync — root overlay conflict, but tools should merge
			await genome.syncRoot();

			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.tools).toContain("reader");
			expect(rootAgent.tools).toContain("custom-agent");
			expect(rootAgent.tools).toContain("debugger");

			// Genome's evolved system_prompt preserved
			expect(rootAgent.system_prompt).toBe("Evolved system prompt");
		});

		test("root tool removal auto-reflects when genome root is not in overlay", async () => {
			const rootDir = join(tempDir, "sync-cap-remove-bs");
			await mkdir(rootDir, { recursive: true });

			await writeRootMd(rootDir, "root", {
				tools: ["reader", "editor", "debugger"],
			});
			await writeRootMd(rootDir, "reader");
			await writeRootMd(rootDir, "editor");
			await writeRootMd(rootDir, "debugger");

			const root = join(tempDir, "sync-cap-remove");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();
			expect(genome.getAgent("root")!.tools).toEqual(["reader", "editor", "debugger"]);

			// Root drops "debugger"
			await writeRootMd(rootDir, "root", {
				tools: ["reader", "editor"],
			});

			// Sync — auto-reflects since root is not in overlay
			await genome.syncRoot();

			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.tools).toContain("reader");
			expect(rootAgent.tools).toContain("editor");
			expect(rootAgent.tools).not.toContain("debugger");
		});

		test("commit message includes conflict info", async () => {
			const rootDir = join(tempDir, "sync-commit-msg-bs");
			await mkdir(rootDir, { recursive: true });

			await writeRootMd(rootDir, "root", { tools: ["reader"] });
			await writeRootMd(rootDir, "reader");
			await writeRootMd(rootDir, "alpha", { description: "Original alpha" });

			const root = join(tempDir, "sync-commit-msg");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();

			// Evolve alpha in genome (creates conflict on next sync)
			await genome.updateAgent(makeSpec({ name: "alpha", description: "Genome-evolved alpha" }));

			// Root changes alpha
			await writeRootMd(rootDir, "alpha", {
				description: "Bootstrap-updated alpha",
			});

			// Sync again — should have conflict on alpha
			const result = await genome.syncRoot();
			expect(result.conflicts).toContain("alpha");

			// Check the git commit message mentions the conflict
			const log = await git(root, "log", "--oneline", "-1");
			expect(log).toContain("alpha");
		});

		test("reconciles path-style agent refs in overlay root", async () => {
			const rootDir = join(tempDir, "sync-path-agents-bs");
			await mkdir(rootDir, { recursive: true });

			// Root has tools and path-style agent refs
			await writeRootMd(rootDir, "root", {
				tools: ["read_file"],
				agents: ["utility/task-manager"],
			});

			const root = join(tempDir, "sync-path-agents");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();
			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.tools).toEqual(["read_file"]);
			expect(rootAgent.agents).toEqual(["utility/task-manager"]);

			// Genome evolves root to add a bare-name agent (promotes to overlay)
			await genome.updateAgent({
				...rootAgent,
				agents: ["utility/task-manager", "custom-helper"],
				system_prompt: "Evolved root",
			});
			expect(genome.getAgent("root")!.agents).toEqual(["utility/task-manager", "custom-helper"]);

			// Root adds a new tool and a new agent ref
			await writeRootMd(rootDir, "root", {
				tools: ["read_file", "write_file"],
				agents: ["utility/task-manager", "utility/planner"],
			});

			// Sync again
			await genome.syncRoot();

			const updated = genome.getAgent("root")!;
			// Tools reconciled correctly
			expect(updated.tools).toContain("read_file");
			expect(updated.tools).toContain("write_file");
			// Path-style agent ref preserved
			expect(updated.agents).toContain("utility/task-manager");
			// New root agent ref added
			expect(updated.agents).toContain("utility/planner");
			// Bare-name genome-only agent survives
			expect(updated.agents).toContain("custom-helper");
			expect(updated.tools).not.toContain("custom-helper");
		});

		test("preserves genome-added entries when root drops its own", async () => {
			const rootDir = join(tempDir, "sync-cap-remove-preserve-bs");
			await mkdir(rootDir, { recursive: true });

			await writeRootMd(rootDir, "root", {
				tools: ["reader", "debugger"],
			});
			await writeRootMd(rootDir, "reader");
			await writeRootMd(rootDir, "debugger");

			const root = join(tempDir, "sync-cap-remove-preserve");
			const genome = await createInitializedGenome(root, rootDir);
			await genome.loadRoot();

			// First sync
			await genome.syncRoot();

			// Genome evolves root to add "custom-agent" (promotes to overlay)
			const evolvedRoot = genome.getAgent("root")!;
			await genome.updateAgent({
				...evolvedRoot,
				tools: ["reader", "debugger", "custom-agent"],
				system_prompt: "Evolved root",
			});

			// Root drops "debugger" and adds "editor"
			await writeRootMd(rootDir, "root", {
				tools: ["reader", "editor"],
			});
			await writeRootMd(rootDir, "editor");

			// Sync again
			await genome.syncRoot();

			// Root overlay should have: reader (kept), editor (added by root), custom-agent (genome-only)
			// But NOT debugger (dropped by root)
			const rootAgent = genome.getAgent("root")!;
			expect(rootAgent.tools).toContain("reader");
			expect(rootAgent.tools).toContain("editor");
			expect(rootAgent.tools).toContain("custom-agent");
			expect(rootAgent.tools).not.toContain("debugger");
		});
	});

	describe("overlay resolution (rootDir)", () => {
		/** Write a root agent Markdown file into the proper tree layout. */
		async function writeRootMd(
			dir: string,
			name: string,
			overrides: Partial<AgentSpec> = {},
		): Promise<void> {
			const spec = makeSpec({ name, ...overrides });
			if (name === "root") {
				await writeFile(join(dir, "root.md"), serializeAgentMarkdown(spec));
			} else {
				const agentsDir = join(dir, "agents");
				await mkdir(agentsDir, { recursive: true });
				await writeFile(join(agentsDir, `${name}.md`), serializeAgentMarkdown(spec));
			}
		}

		test("getAgent returns root agent when overlay is empty", async () => {
			const genomePath = join(tempDir, "overlay-get-root");
			const rootDir = join(tempDir, "overlay-get-root-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader" });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			const agent = genome.getAgent("reader");
			expect(agent).toBeDefined();
			expect(agent!.description).toBe("Root reader");
		});

		test("getAgent returns overlay agent when it exists (overlay wins)", async () => {
			const genomePath = join(tempDir, "overlay-get-overlay");
			const rootDir = join(tempDir, "overlay-get-overlay-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader" });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			// Add an overlay agent with the same name
			await genome.addAgent(makeSpec({ name: "reader", description: "Overlay reader" }));

			const agent = genome.getAgent("reader");
			expect(agent).toBeDefined();
			expect(agent!.description).toBe("Overlay reader");
		});

		test("allAgents returns root + overlay merged (overlay wins)", async () => {
			const genomePath = join(tempDir, "overlay-all");
			const rootDir = join(tempDir, "overlay-all-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "root", { description: "Root root" });
			await writeRootMd(rootDir, "reader", { description: "Root reader" });
			await writeRootMd(rootDir, "editor", { description: "Root editor" });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			// Override reader in overlay
			await genome.addAgent(makeSpec({ name: "reader", description: "Overlay reader" }));
			// Add genome-only agent
			await genome.addAgent(makeSpec({ name: "specialist", description: "Genome only" }));

			const agents = genome.allAgents();
			const byName = new Map(agents.map((a) => [a.name, a]));

			// Root agents present
			expect(byName.get("root")!.description).toBe("Root root");
			expect(byName.get("editor")!.description).toBe("Root editor");
			// Overlay wins for reader
			expect(byName.get("reader")!.description).toBe("Overlay reader");
			// Genome-only agent present
			expect(byName.get("specialist")!.description).toBe("Genome only");
			// Total: root(1) + editor(1) + reader-overlay(1) + specialist(1) = 4
			expect(agents).toHaveLength(4);
		});

		test("isOverlay correctly identifies overlay vs root-only agents", async () => {
			const genomePath = join(tempDir, "overlay-isoverlay");
			const rootDir = join(tempDir, "overlay-isoverlay-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader" });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			// reader is root-only
			expect(genome.isOverlay("reader")).toBe(false);
			// nonexistent is not overlay
			expect(genome.isOverlay("nonexistent")).toBe(false);

			// Add overlay for reader
			await genome.addAgent(makeSpec({ name: "reader", description: "Overlay reader" }));
			expect(genome.isOverlay("reader")).toBe(true);

			// Add genome-only agent
			await genome.addAgent(makeSpec({ name: "specialist" }));
			expect(genome.isOverlay("specialist")).toBe(true);
		});

		test("overlayAgents returns only modified/created agents", async () => {
			const genomePath = join(tempDir, "overlay-agents");
			const rootDir = join(tempDir, "overlay-agents-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "root");
			await writeRootMd(rootDir, "reader");

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			// No overlay agents yet
			expect(genome.overlayAgents()).toHaveLength(0);

			// Add overlay
			await genome.addAgent(makeSpec({ name: "specialist" }));
			const overlay = genome.overlayAgents();
			expect(overlay).toHaveLength(1);
			expect(overlay[0]!.name).toBe("specialist");
		});

		test("updateAgent promotes root agent to overlay on first mutation", async () => {
			const genomePath = join(tempDir, "overlay-promote");
			const rootDir = join(tempDir, "overlay-promote-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", {
				description: "Root reader",
				system_prompt: "Original prompt",
			});

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			// reader is root-only
			expect(genome.isOverlay("reader")).toBe(false);

			// Update it — should promote to overlay
			await genome.updateAgent(
				makeSpec({ name: "reader", description: "Evolved reader", system_prompt: "New prompt" }),
			);

			expect(genome.isOverlay("reader")).toBe(true);
			expect(genome.getAgent("reader")!.description).toBe("Evolved reader");
			expect(genome.getAgent("reader")!.version).toBe(2); // bumped from 1
		});

		test("loadFromDisk + loadRoot combines overlay and root agents", async () => {
			const genomePath = join(tempDir, "overlay-reload");
			const rootDir = join(tempDir, "overlay-reload-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader" });

			// Set up genome with an overlay agent
			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();
			await genome.addAgent(makeSpec({ name: "specialist", description: "Genome only" }));

			// Reload from disk
			const genome2 = new Genome(genomePath, rootDir);
			await genome2.loadFromDisk();

			expect(genome2.getAgent("reader")!.description).toBe("Root reader");
			expect(genome2.getAgent("specialist")!.description).toBe("Genome only");
			expect(genome2.isOverlay("reader")).toBe(false);
			expect(genome2.isOverlay("specialist")).toBe(true);
		});

		test("loadRoot is a no-op when rootDir is not set", async () => {
			const genomePath = join(tempDir, "overlay-no-rootdir");
			const genome = await createInitializedGenome(genomePath);
			await genome.addAgent(makeSpec({ name: "local", description: "Local agent" }));

			// loadRoot should not throw and should not change agent count
			await genome.loadRoot();
			expect(genome.agentCount()).toBe(1);
			expect(genome.getAgent("local")!.description).toBe("Local agent");
		});

		test("removeAgent on overlay re-exposes root agent", async () => {
			const genomePath = join(tempDir, "overlay-remove-reexpose");
			const rootDir = join(tempDir, "overlay-remove-reexpose-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader", version: 1 });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			// Create overlay that shadows root
			await genome.addAgent(makeSpec({ name: "reader", description: "Overlay reader" }));
			expect(genome.getAgent("reader")!.description).toBe("Overlay reader");
			expect(genome.isOverlay("reader")).toBe(true);

			// Remove overlay — root re-appears
			await genome.removeAgent("reader");
			expect(genome.isOverlay("reader")).toBe(false);
			const agent = genome.getAgent("reader");
			expect(agent).toBeDefined();
			expect(agent!.description).toBe("Root reader");
		});

		test("removeAgent throws for root-only agents", async () => {
			const genomePath = join(tempDir, "overlay-remove-root-only");
			const rootDir = join(tempDir, "overlay-remove-root-only-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader" });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			await expect(genome.removeAgent("reader")).rejects.toThrow("root agent");
		});

		test("root agent deleted between sessions disappears from resolution", async () => {
			const genomePath = join(tempDir, "overlay-root-deleted");
			const rootDir = join(tempDir, "overlay-root-deleted-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader" });
			await writeRootMd(rootDir, "editor", { description: "Root editor" });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.initFromRoot();
			expect(genome.agentCount()).toBe(2);

			// Delete the reader agent from root between sessions
			await rm(join(rootDir, "agents", "reader.md"));

			// Reload — simulates a new session
			const genome2 = new Genome(genomePath, rootDir);
			await genome2.loadFromDisk();

			// reader should no longer be resolvable
			expect(genome2.getAgent("reader")).toBeUndefined();
			expect(genome2.getAgent("editor")).toBeDefined();
			expect(genome2.agentCount()).toBe(1);
		});

		test("addAgent with root-matching name bumps version above root", async () => {
			const genomePath = join(tempDir, "overlay-add-shadows-root");
			const rootDir = join(tempDir, "overlay-add-shadows-root-rd");
			await mkdir(rootDir, { recursive: true });
			await writeRootMd(rootDir, "reader", { description: "Root reader", version: 3 });

			const genome = await createInitializedGenome(genomePath, rootDir);
			await genome.loadRoot();

			await genome.addAgent(
				makeSpec({ name: "reader", description: "Replaced reader", version: 1 }),
			);

			const agent = genome.getAgent("reader")!;
			expect(agent.description).toBe("Replaced reader");
			expect(agent.version).toBe(4); // root.version (3) + 1
		});
	});
});
