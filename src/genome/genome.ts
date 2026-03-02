import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
	findRootToolsDir,
	loadRootAgents,
	readRootDir,
	resolveRootToolsDir,
} from "../agents/loader.ts";
import { parseAgentMarkdown, serializeAgentMarkdown } from "../agents/markdown-loader.ts";
import type { AgentSpec, Memory, RoutingRule } from "../kernel/types.ts";
import { MemoryStore } from "./memory-store.ts";
import { buildManifestFromSpecs, loadManifest, saveManifest } from "./root-manifest.ts";

export interface SyncRootResult {
	added: string[];
	conflicts: string[];
}

/** Run a git command in the given directory, returning trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	}
	return stdout.trim();
}

const DIRS = [
	"agents",
	"memories",
	"routing",
	"embeddings",
	"metrics",
	"logs",
	"postscripts",
] as const;

export class Genome {
	private readonly rootPath: string;
	private readonly rootDir?: string;
	private readonly agents = new Map<string, AgentSpec>();
	private readonly rootAgents = new Map<string, AgentSpec>();
	readonly memories: MemoryStore;
	private routingRules: RoutingRule[] = [];

	constructor(rootPath: string, rootDir?: string) {
		this.rootPath = rootPath;
		this.rootDir = rootDir;
		this.memories = new MemoryStore(join(rootPath, "memories", "memories.jsonl"));
	}

	/** Initialize the genome directory with subdirectories and a git repo. */
	async init(): Promise<void> {
		// Create all directories
		for (const dir of DIRS) {
			await mkdir(join(this.rootPath, dir), { recursive: true });
		}

		// Check if git repo exists
		let hasGit = false;
		try {
			await git(this.rootPath, "rev-parse", "--git-dir");
			hasGit = true;
		} catch {
			// No git repo yet
		}

		if (!hasGit) {
			await git(this.rootPath, "init");
			await git(this.rootPath, "config", "user.name", "sprout");
			await git(this.rootPath, "config", "user.email", "sprout@local");

			// Create empty routing rules file
			await writeFile(join(this.rootPath, "routing", "rules.yaml"), stringify([]));

			// Create .gitignore to exclude logs
			await writeFile(join(this.rootPath, ".gitignore"), "logs/\n");

			await git(this.rootPath, "add", ".");
			await git(this.rootPath, "commit", "-m", "genome: initialize");
		}
	}

	/** Load root agents from the rootDir. No-op if rootDir was not set. */
	async loadRoot(): Promise<void> {
		if (!this.rootDir) return;
		const specs = await loadRootAgents(this.rootDir);
		this.rootAgents.clear();
		for (const spec of specs) {
			this.rootAgents.set(spec.name, spec);
		}
	}

	// --- Agent CRUD ---

	/** Number of agents in the genome (overlay + root, deduplicated). */
	agentCount(): number {
		let rootOnly = 0;
		for (const name of this.rootAgents.keys()) {
			if (!this.agents.has(name)) rootOnly++;
		}
		return this.agents.size + rootOnly;
	}

	/** Return a copy of all agent specs (root + overlay merged, overlay wins). */
	allAgents(): AgentSpec[] {
		const merged = new Map<string, AgentSpec>(this.rootAgents);
		for (const [name, spec] of this.agents) {
			merged.set(name, spec);
		}
		return [...merged.values()];
	}

	/** Look up an agent by name. Checks overlay first, then root. */
	getAgent(name: string): AgentSpec | undefined {
		return this.agents.get(name) ?? this.rootAgents.get(name);
	}

	/** Look up an agent in root only (ignoring overlay). */
	getRootAgent(name: string): AgentSpec | undefined {
		return this.rootAgents.get(name);
	}

	/** Returns true if the agent exists in the genome's overlay (modified or genome-created). */
	isOverlay(name: string): boolean {
		return this.agents.has(name);
	}

	/** Returns only genome-modified or genome-created agents (the overlay). */
	overlayAgents(): AgentSpec[] {
		return [...this.agents.values()];
	}

	/** Add a new agent spec, writing markdown to disk and committing.
	 *  If an agent with the same name exists in root, bumps version above root's. */
	async addAgent(spec: AgentSpec): Promise<void> {
		const rootSpec = this.rootAgents.get(spec.name);
		const saved = rootSpec ? { ...spec, version: rootSpec.version + 1 } : spec;
		const mdPath = join(this.rootPath, "agents", `${saved.name}.md`);
		await writeFile(mdPath, serializeAgentMarkdown(saved));
		await git(this.rootPath, "add", mdPath);
		await git(this.rootPath, "commit", "-m", `genome: add agent '${saved.name}'`);
		this.agents.set(saved.name, saved);
	}

	/** Update an existing agent, bumping its version. Promotes root agents to overlay on first mutation. */
	async updateAgent(spec: AgentSpec): Promise<void> {
		const existing = this.agents.get(spec.name) ?? this.rootAgents.get(spec.name);
		if (!existing) {
			throw new Error(`Cannot update agent '${spec.name}': not found`);
		}
		const nextVersion = existing.version + 1;
		const updated = { ...spec, version: nextVersion };
		const mdPath = join(this.rootPath, "agents", `${spec.name}.md`);
		await writeFile(mdPath, serializeAgentMarkdown(updated));
		await git(this.rootPath, "add", mdPath);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: update agent '${spec.name}' to v${nextVersion}`,
		);
		this.agents.set(spec.name, updated);
	}

	/**
	 * Remove an overlay agent, deleting its markdown file and committing.
	 * Only overlay agents can be removed — root-only agents are immutable.
	 * If the overlay shadowed a root agent, the root version re-appears.
	 */
	async removeAgent(name: string): Promise<void> {
		if (!this.agents.has(name)) {
			if (this.rootAgents.has(name)) {
				throw new Error(`Cannot remove agent '${name}': it is a root agent (not in overlay)`);
			}
			throw new Error(`Cannot remove agent '${name}': not found`);
		}
		const mdPath = join(this.rootPath, "agents", `${name}.md`);
		await rm(mdPath);
		await git(this.rootPath, "add", mdPath);
		await git(this.rootPath, "commit", "-m", `genome: remove agent '${name}'`);
		this.agents.delete(name);
	}

	// --- Routing rules ---

	/** Return a copy of all routing rules. */
	allRoutingRules(): RoutingRule[] {
		return [...this.routingRules];
	}

	/** Find routing rules matching the query by keyword, sorted by strength descending. */
	matchRoutingRules(query: string): RoutingRule[] {
		const tokens = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 0);
		if (tokens.length === 0) return [];

		return this.routingRules
			.filter((rule) => {
				const condition = rule.condition.toLowerCase();
				return tokens.some((token) => condition.includes(token));
			})
			.sort((a, b) => b.strength - a.strength);
	}

	/** Add a routing rule, saving to YAML and committing. */
	async addRoutingRule(rule: RoutingRule): Promise<void> {
		this.routingRules.push(rule);
		await this.saveRoutingRules();
		await git(this.rootPath, "add", join(this.rootPath, "routing", "rules.yaml"));
		await git(this.rootPath, "commit", "-m", `genome: add routing rule '${rule.id}'`);
	}

	/** Remove a routing rule by id, saving to YAML and committing. */
	async removeRoutingRule(id: string): Promise<void> {
		this.routingRules = this.routingRules.filter((r) => r.id !== id);
		await this.saveRoutingRules();
		await git(this.rootPath, "add", join(this.rootPath, "routing", "rules.yaml"));
		await git(this.rootPath, "commit", "-m", `genome: remove routing rule '${id}'`);
	}

	private async saveRoutingRules(): Promise<void> {
		await writeFile(join(this.rootPath, "routing", "rules.yaml"), stringify(this.routingRules));
	}

	// --- Memory CRUD (delegates to MemoryStore) ---

	/** Add a memory, committing the JSONL file. */
	async addMemory(memory: Memory): Promise<void> {
		await this.memories.add(memory);
		await git(this.rootPath, "add", join(this.rootPath, "memories", "memories.jsonl"));
		await git(this.rootPath, "commit", "-m", `genome: add memory '${memory.id}'`);
	}

	/** Mark memories as used by id, saving to disk. No git commit — this is operational metadata. */
	async markMemoriesUsed(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		for (const id of ids) {
			this.memories.markUsed(id);
		}
		await this.memories.save();
	}

	// --- Pruning ---

	/** Remove memories whose effective confidence is below the threshold. */
	async pruneMemories(minConfidence = 0.2): Promise<string[]> {
		const pruned = this.memories.pruneByConfidence(minConfidence);
		if (pruned.length > 0) {
			await this.memories.save();
			await git(this.rootPath, "add", join(this.rootPath, "memories", "memories.jsonl"));
			await git(
				this.rootPath,
				"commit",
				"-m",
				`genome: prune ${pruned.length} low-confidence memories`,
			);
		}
		return pruned;
	}

	/** Remove routing rules that have never been triggered (not in the used set). */
	async pruneUnusedRoutingRules(usedRuleIds: Set<string>): Promise<string[]> {
		const removed: string[] = [];
		this.routingRules = this.routingRules.filter((r) => {
			if (!usedRuleIds.has(r.id)) {
				removed.push(r.id);
				return false;
			}
			return true;
		});
		if (removed.length > 0) {
			await this.saveRoutingRules();
			await git(this.rootPath, "add", join(this.rootPath, "routing", "rules.yaml"));
			await git(
				this.rootPath,
				"commit",
				"-m",
				`genome: prune ${removed.length} unused routing rules`,
			);
		}
		return removed;
	}

	// --- Rollback ---

	/** Return the SHA of the current HEAD commit. */
	async lastCommitHash(): Promise<string> {
		return git(this.rootPath, "rev-parse", "HEAD");
	}

	/** Rollback the last genome mutation (git revert HEAD). */
	async rollback(): Promise<void> {
		await git(this.rootPath, "revert", "--no-edit", "HEAD");
	}

	/** Rollback a specific commit by hash. */
	async rollbackCommit(commitHash: string): Promise<void> {
		await git(this.rootPath, "revert", "--no-edit", commitHash);
	}

	// --- Load and Bootstrap ---

	/** Load agents, memories, and routing rules from an existing genome directory. */
	async loadFromDisk(): Promise<void> {
		// Genome agents are stored flat in agents/ (one .md per agent, no nesting).
		const agentsDir = join(this.rootPath, "agents");
		let files: string[];
		try {
			files = await readdir(agentsDir);
		} catch {
			files = [];
		}
		const mdFiles = files.filter((f) => f.endsWith(".md"));
		for (const file of mdFiles) {
			const filePath = join(agentsDir, file);
			const content = await readFile(filePath, "utf-8");
			const spec = parseAgentMarkdown(content, filePath);
			this.agents.set(spec.name, spec);
		}

		// Load memories
		await this.memories.load();

		// Load routing rules
		const rulesPath = join(this.rootPath, "routing", "rules.yaml");
		try {
			const content = await readFile(rulesPath, "utf-8");
			const parsed = parse(content);
			this.routingRules = Array.isArray(parsed) ? parsed : [];
		} catch {
			this.routingRules = [];
		}

		// Load root agents for overlay resolution (no-op if rootDir not set)
		await this.loadRoot();
	}

	/** Initialize the genome from root agent specs. Builds manifest, loads root agents into memory. */
	async initFromRoot(): Promise<void> {
		if (!this.rootDir) {
			throw new Error("Cannot initFromRoot: rootDir not set");
		}
		if (this.rootAgents.size > 0) {
			throw new Error("Cannot initFromRoot: root agents already loaded");
		}
		const { specs, rawContentByName } = await readRootDir(this.rootDir);

		// Populate rootAgents so getAgent/allAgents resolve from root
		for (const spec of specs) {
			this.rootAgents.set(spec.name, spec);
		}

		// Build and save manifest (tracks root state for future syncRoot)
		const manifest = buildManifestFromSpecs(specs, rawContentByName);
		const manifestPath = join(this.rootPath, "bootstrap-manifest.json");
		await saveManifest(manifestPath, manifest);

		await git(this.rootPath, "add", manifestPath);
		await git(this.rootPath, "commit", "-m", "genome: initialize from root agents");
	}

	/**
	 * Sync root agents into an existing genome using manifest-aware comparison.
	 * With overlay design, unmodified agents auto-resolve from root.
	 * This method refreshes rootAgents, detects new root agents, detects
	 * conflicts (overlay + root both changed), and reconciles tools/agents
	 * when the root overlay exists.
	 */
	async syncRoot(): Promise<SyncRootResult> {
		if (!this.rootDir) {
			throw new Error("Cannot syncRoot: rootDir not set");
		}
		const manifestPath = join(this.rootPath, "bootstrap-manifest.json");
		const oldManifest = await loadManifest(manifestPath);
		const { specs, rawContentByName } = await readRootDir(this.rootDir);
		const newManifest = buildManifestFromSpecs(specs, rawContentByName);

		// Refresh rootAgents from the already-read specs (avoids re-reading root dir)
		this.rootAgents.clear();
		for (const spec of specs) {
			this.rootAgents.set(spec.name, spec);
		}

		const added: string[] = [];
		const conflicts: string[] = [];

		for (const spec of specs) {
			const overlayAgent = this.agents.get(spec.name);
			const oldEntry = oldManifest.agents[spec.name];
			const newEntry = newManifest.agents[spec.name];
			if (!newEntry) continue;

			if (!oldEntry) {
				// New agent in root (not in previous manifest)
				added.push(spec.name);
			} else if (newEntry.hash !== oldEntry.hash && overlayAgent) {
				// Root changed AND genome has overlay — conflict
				conflicts.push(spec.name);
			}
			// All other cases: root auto-reflects (no overlay), or root unchanged.
		}

		// Reconcile root tools and agents only if genome has a root overlay
		const toolsAgentsMerged = this.agents.has("root")
			? await this.reconcileRootToolsAndAgents(
					specs,
					oldManifest.rootTools ?? [],
					oldManifest.rootAgents ?? [],
				)
			: false;

		// Detect whether manifest content changed (any hash differs or agents added/removed)
		const manifestChanged =
			JSON.stringify(oldManifest.agents) !== JSON.stringify(newManifest.agents) ||
			JSON.stringify(oldManifest.rootTools) !== JSON.stringify(newManifest.rootTools) ||
			JSON.stringify(oldManifest.rootAgents) !== JSON.stringify(newManifest.rootAgents);

		if (manifestChanged) {
			await saveManifest(manifestPath, newManifest);
		}

		const filesToStage: string[] = [];
		if (toolsAgentsMerged) {
			filesToStage.push(join(this.rootPath, "agents", "root.md"));
		}
		if (manifestChanged) {
			filesToStage.push(manifestPath);
		}

		const parts: string[] = [];
		if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
		if (toolsAgentsMerged) parts.push("tools/agents merged");
		if (conflicts.length > 0) parts.push(`conflicts: ${conflicts.join(", ")}`);

		if (filesToStage.length > 0) {
			await git(this.rootPath, "add", ...filesToStage);
			const commitMsg =
				parts.length > 0 ? `genome: sync root (${parts.join("; ")})` : "genome: sync root manifest";
			await git(this.rootPath, "commit", "-m", commitMsg);
		}

		return { added, conflicts };
	}

	/**
	 * Reconcile root agent tools and agents with genome root.
	 * Adds entries root introduced, removes entries root dropped,
	 * and preserves genome-only entries that were never in root.
	 */
	private async reconcileRootToolsAndAgents(
		rootSpecs: AgentSpec[],
		oldRootTools: string[],
		oldRootAgents: string[],
	): Promise<boolean> {
		const rootSpecRoot = rootSpecs.find((s) => s.name === "root");
		const genomeRoot = this.agents.get("root");
		if (!rootSpecRoot || !genomeRoot) return false;

		const reconciledTools = this.reconcileList(genomeRoot.tools, rootSpecRoot.tools, oldRootTools);
		const reconciledAgents = this.reconcileList(
			genomeRoot.agents,
			rootSpecRoot.agents,
			oldRootAgents,
		);

		const toolsChanged = !arraysEqual(reconciledTools, genomeRoot.tools);
		const agentsChanged = !arraysEqual(reconciledAgents, genomeRoot.agents);
		if (!toolsChanged && !agentsChanged) return false;

		const updated = { ...genomeRoot, tools: reconciledTools, agents: reconciledAgents };
		const mdPath = join(this.rootPath, "agents", "root.md");
		await writeFile(mdPath, serializeAgentMarkdown(updated));
		this.agents.set("root", updated);
		return true;
	}

	/** 3-way merge a single list: keep genome entries still in root or never in root, add new root entries. */
	private reconcileList(genomeCurrent: string[], rootNew: string[], rootOld: string[]): string[] {
		const newSet = new Set(rootNew);
		const oldSet = new Set(rootOld);
		const genomeSet = new Set(genomeCurrent);
		const kept = genomeCurrent.filter((c) => newSet.has(c) || !oldSet.has(c));
		const toAdd = rootNew.filter((c) => !genomeSet.has(c));
		return [...kept, ...toAdd];
	}

	// --- Agent Workspace ---

	/** Return the path to an agent's workspace directory. */
	agentDir(agentName: string): string {
		return join(this.rootPath, "agents", agentName);
	}

	/** Save an executable tool script to an agent's workspace. */
	async saveAgentTool(agentName: string, opts: SaveAgentToolOptions): Promise<void> {
		const interpreter = opts.interpreter ?? "bash";
		const toolDir = join(this.agentDir(agentName), "tools");
		await mkdir(toolDir, { recursive: true });

		const toolPath = join(toolDir, opts.name);
		const frontmatter = stringify({
			name: opts.name,
			description: opts.description,
			interpreter,
		});
		const content = `---\n${frontmatter}---\n${opts.script}`;
		await writeFile(toolPath, content, "utf-8");
		await chmod(toolPath, 0o755);

		await git(this.rootPath, "add", toolPath);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: save tool '${opts.name}' for agent '${agentName}'`,
		);
	}

	/** Save a reference file to an agent's workspace. */
	async saveAgentFile(agentName: string, opts: SaveAgentFileOptions): Promise<void> {
		const fileDir = join(this.agentDir(agentName), "files");
		await mkdir(fileDir, { recursive: true });

		const filePath = join(fileDir, opts.name);
		await writeFile(filePath, opts.content, "utf-8");

		await git(this.rootPath, "add", filePath);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: save file '${opts.name}' for agent '${agentName}'`,
		);
	}

	/** Load tool definitions from an agent's tools directory. */
	async loadAgentTools(agentName: string): Promise<AgentToolDefinition[]> {
		const toolDir = join(this.agentDir(agentName), "tools");
		return this.loadToolsFromDir(toolDir, "genome");
	}

	/** Load tools from both genome and root directories, genome overrides on name collision. */
	async loadAgentToolsWithRoot(
		agentName: string,
		rootDir: string,
		tree?: Map<string, import("../agents/loader.ts").AgentTreeEntry>,
	): Promise<AgentToolDefinition[]> {
		const genomeTools = await this.loadAgentTools(agentName);
		const rootToolDir = tree
			? resolveRootToolsDir(tree, rootDir, agentName)
			: await findRootToolsDir(rootDir, agentName);
		const rootTools = await this.loadToolsFromDir(rootToolDir, "root");
		const genomeNames = new Set(genomeTools.map((t) => t.name));
		return [...genomeTools, ...rootTools.filter((t) => !genomeNames.has(t.name))];
	}

	/** Read a tools directory and return AgentToolDefinition[] with the given provenance. */
	private async loadToolsFromDir(
		toolDir: string,
		provenance: "genome" | "root",
	): Promise<AgentToolDefinition[]> {
		let entries: string[];
		try {
			entries = await readdir(toolDir);
		} catch {
			return [];
		}

		const tools: AgentToolDefinition[] = [];
		for (const entry of entries) {
			const toolPath = join(toolDir, entry);
			const content = await readFile(toolPath, "utf-8");
			const parsed = parseToolFrontmatter(content);
			if (parsed) {
				tools.push({
					name: parsed.name,
					description: parsed.description,
					interpreter: parsed.interpreter,
					scriptPath: toolPath,
					provenance,
				});
			}
		}
		return tools;
	}

	/** List files in an agent's files directory with name and size. */
	async listAgentFiles(agentName: string): Promise<AgentFileInfo[]> {
		const fileDir = join(this.agentDir(agentName), "files");
		let entries: string[];
		try {
			entries = await readdir(fileDir);
		} catch {
			return [];
		}

		const files: AgentFileInfo[] = [];
		for (const entry of entries) {
			const filePath = join(fileDir, entry);
			const s = await stat(filePath);
			if (s.isFile()) {
				files.push({ name: entry, size: s.size, path: filePath });
			}
		}
		return files;
	}

	// ── Postscripts ──────────────────────────────────────────────

	/**
	 * Load genome-level postscripts (global, orchestrator, worker).
	 * Returns empty strings for missing files.
	 */
	async loadPostscripts(): Promise<{ global: string; orchestrator: string; worker: string }> {
		const dir = join(this.rootPath, "postscripts");
		const read = async (name: string): Promise<string> => {
			try {
				const content = await readFile(join(dir, name), "utf-8");
				return content.trim();
			} catch {
				return "";
			}
		};
		const [global, orchestrator, worker] = await Promise.all([
			read("global.md"),
			read("orchestrator.md"),
			read("worker.md"),
		]);
		return { global, orchestrator, worker };
	}

	/**
	 * Load a per-agent postscript from postscripts/agents/{name}.md.
	 * Returns empty string if not found.
	 */
	async loadAgentPostscript(agentName: string): Promise<string> {
		try {
			const content = await readFile(
				join(this.rootPath, "postscripts", "agents", `${agentName}.md`),
				"utf-8",
			);
			return content.trim();
		} catch {
			return "";
		}
	}

	/**
	 * Save a postscript file and commit. Path is relative to postscripts/ dir.
	 * e.g. savePostscript("global.md", "...") or savePostscript("agents/reader.md", "...")
	 */
	async savePostscript(relativePath: string, content: string): Promise<void> {
		const fullPath = join(this.rootPath, "postscripts", relativePath);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content);
		await git(this.rootPath, "add", fullPath);
		await git(this.rootPath, "commit", "-m", `genome: save postscript ${relativePath}`);
	}
}

export interface SaveAgentToolOptions {
	name: string;
	description: string;
	script: string;
	interpreter?: string;
}

export interface SaveAgentFileOptions {
	name: string;
	content: string;
}

export interface AgentToolDefinition {
	name: string;
	description: string;
	interpreter: string;
	scriptPath: string;
	provenance: "genome" | "root";
}

export interface AgentFileInfo {
	name: string;
	size: number;
	path: string;
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Parse YAML frontmatter from a tool file (delimited by ---). */
function parseToolFrontmatter(
	content: string,
): { name: string; description: string; interpreter: string } | null {
	if (!content.startsWith("---\n")) return null;
	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx === -1) return null;

	const yamlStr = content.slice(4, endIdx);
	const parsed = parse(yamlStr);
	if (!parsed?.name || !parsed?.description) return null;

	return {
		name: parsed.name,
		description: parsed.description,
		interpreter: parsed.interpreter ?? "bash",
	};
}
