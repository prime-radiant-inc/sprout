import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadAgentSpec, loadBootstrapAgents, readBootstrapDir } from "../agents/loader.ts";
import type { AgentSpec, Memory, RoutingRule } from "../kernel/types.ts";
import { buildManifestFromSpecs, loadManifest, saveManifest } from "./bootstrap-manifest.ts";
import { MemoryStore } from "./memory-store.ts";

export interface SyncBootstrapResult {
	added: string[];
	updated: string[];
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
	private readonly agents = new Map<string, AgentSpec>();
	readonly memories: MemoryStore;
	private routingRules: RoutingRule[] = [];

	constructor(rootPath: string) {
		this.rootPath = rootPath;
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

	// --- Agent CRUD ---

	/** Number of agents in the genome. */
	agentCount(): number {
		return this.agents.size;
	}

	/** Return a copy of all agent specs. */
	allAgents(): AgentSpec[] {
		return [...this.agents.values()];
	}

	/** Look up an agent by name. */
	getAgent(name: string): AgentSpec | undefined {
		return this.agents.get(name);
	}

	/** Add a new agent spec, writing YAML to disk and committing. */
	async addAgent(spec: AgentSpec): Promise<void> {
		const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
		await writeFile(yamlPath, serializeAgentSpec(spec));
		this.agents.set(spec.name, spec);
		await git(this.rootPath, "add", yamlPath);
		await git(this.rootPath, "commit", "-m", `genome: add agent '${spec.name}'`);
	}

	/** Update an existing agent, bumping its version. */
	async updateAgent(spec: AgentSpec): Promise<void> {
		const existing = this.agents.get(spec.name);
		if (!existing) {
			throw new Error(`Cannot update agent '${spec.name}': not found`);
		}
		const nextVersion = existing.version + 1;
		const updated = { ...spec, version: nextVersion };
		const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
		await writeFile(yamlPath, serializeAgentSpec(updated));
		this.agents.set(spec.name, updated);
		await git(this.rootPath, "add", yamlPath);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: update agent '${spec.name}' to v${nextVersion}`,
		);
	}

	/** Remove an agent, deleting its YAML file and committing. */
	async removeAgent(name: string): Promise<void> {
		if (!this.agents.has(name)) {
			throw new Error(`Cannot remove agent '${name}': not found`);
		}
		const yamlPath = join(this.rootPath, "agents", `${name}.yaml`);
		await rm(yamlPath);
		this.agents.delete(name);
		await git(this.rootPath, "add", yamlPath);
		await git(this.rootPath, "commit", "-m", `genome: remove agent '${name}'`);
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
		// Load agents
		const agentsDir = join(this.rootPath, "agents");
		let files: string[];
		try {
			files = await readdir(agentsDir);
		} catch {
			files = [];
		}
		const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
		for (const file of yamlFiles) {
			const spec = await loadAgentSpec(join(agentsDir, file));
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
	}

	/** Initialize the genome from bootstrap agent specs. Throws if agents already exist. */
	async initFromBootstrap(bootstrapDir: string): Promise<void> {
		if (this.agents.size > 0) {
			throw new Error("Cannot initialize from bootstrap: agents already exist");
		}

		const specs = await loadBootstrapAgents(bootstrapDir);
		for (const spec of specs) {
			const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
			await writeFile(yamlPath, serializeAgentSpec(spec));
			this.agents.set(spec.name, spec);
		}

		await git(this.rootPath, "add", ".");
		await git(this.rootPath, "commit", "-m", "genome: initialize from bootstrap agents");
	}

	/**
	 * Sync bootstrap agents into an existing genome using manifest-aware 4-way comparison.
	 * Adds new agents, updates unchanged genome agents when bootstrap evolves,
	 * and detects conflicts when both sides have changed.
	 */
	async syncBootstrap(bootstrapDir: string): Promise<SyncBootstrapResult> {
		const manifestPath = join(this.rootPath, "bootstrap-manifest.json");
		const oldManifest = await loadManifest(manifestPath);
		const { specs, rawContentByName } = await readBootstrapDir(bootstrapDir);
		const newManifest = buildManifestFromSpecs(specs, rawContentByName);

		const added: string[] = [];
		const updated: string[] = [];
		const conflicts: string[] = [];

		for (const spec of specs) {
			const existing = this.agents.get(spec.name);
			const oldEntry = oldManifest.agents[spec.name];
			const newEntry = newManifest.agents[spec.name];
			if (!newEntry) continue;

			if (!existing) {
				// Case 1: Agent not in genome — add it
				const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
				await writeFile(yamlPath, serializeAgentSpec(spec));
				this.agents.set(spec.name, spec);
				added.push(spec.name);
			} else if (!oldEntry) {
				// Case 2: Pre-manifest genome — skip, treat as genome-evolved
			} else if (newEntry.hash === oldEntry.hash) {
				// Case 3: Bootstrap file unchanged — skip
			} else if (existing.version === oldEntry.version) {
				// Case 4: Bootstrap changed AND genome unchanged — update genome
				const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
				await writeFile(yamlPath, serializeAgentSpec(spec));
				this.agents.set(spec.name, spec);
				updated.push(spec.name);
			} else {
				// Case 5: Bootstrap changed AND genome also evolved — conflict
				conflicts.push(spec.name);
			}
		}

		// Reconcile root capabilities: add new, remove dropped, preserve genome-only.
		// Safe after Case 4: if root was updated, genome had no custom caps (version matched
		// old manifest), so reconcileRootCapabilities finds nothing to merge and returns false.
		const capsMerged = await this.reconcileRootCapabilities(
			specs,
			oldManifest.rootCapabilities ?? [],
		);

		const hasChanges = added.length > 0 || updated.length > 0 || capsMerged;

		// Only save manifest when something changed — avoids dirty working tree
		if (hasChanges || conflicts.length > 0) {
			await saveManifest(manifestPath, newManifest);
		}

		// Collect specific files to stage (avoid `git add .` which may stage unrelated files)
		const filesToStage: string[] = [];
		for (const name of [...added, ...updated]) {
			filesToStage.push(join(this.rootPath, "agents", `${name}.yaml`));
		}
		if (capsMerged) {
			filesToStage.push(join(this.rootPath, "agents", "root.yaml"));
		}
		if (hasChanges || conflicts.length > 0) {
			filesToStage.push(manifestPath);
		}

		const parts: string[] = [];
		if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
		if (updated.length > 0) parts.push(`updated: ${updated.join(", ")}`);
		if (capsMerged) parts.push("capabilities merged");
		if (conflicts.length > 0) parts.push(`conflicts: ${conflicts.join(", ")}`);

		if (parts.length > 0) {
			await git(this.rootPath, "add", ...filesToStage);
			await git(this.rootPath, "commit", "-m", `genome: sync bootstrap (${parts.join("; ")})`);
		}

		return { added, updated, conflicts };
	}

	/**
	 * Reconcile bootstrap root capabilities with genome root.
	 * Adds capabilities bootstrap introduced, removes capabilities bootstrap dropped,
	 * and preserves genome-only capabilities that were never in bootstrap.
	 */
	private async reconcileRootCapabilities(
		bootstrapSpecs: AgentSpec[],
		oldBootstrapRootCaps: string[],
	): Promise<boolean> {
		const bootstrapRoot = bootstrapSpecs.find((s) => s.name === "root");
		const genomeRoot = this.agents.get("root");
		if (!bootstrapRoot || !genomeRoot) return false;

		const newBootstrapCaps = new Set(bootstrapRoot.capabilities);
		const oldBootstrapCaps = new Set(oldBootstrapRootCaps);
		const genomeCaps = new Set(genomeRoot.capabilities);

		// Compute the reconciled capabilities:
		// - Keep genome capabilities that are still in bootstrap OR were never in bootstrap
		// - Add new bootstrap capabilities that genome doesn't have yet
		const kept = genomeRoot.capabilities.filter(
			(c) => newBootstrapCaps.has(c) || !oldBootstrapCaps.has(c),
		);
		const toAdd = bootstrapRoot.capabilities.filter((c) => !genomeCaps.has(c));
		const merged = [...kept, ...toAdd];

		// Check if anything actually changed
		if (
			merged.length === genomeRoot.capabilities.length &&
			merged.every((c, i) => c === genomeRoot.capabilities[i])
		) {
			return false;
		}

		const updated = { ...genomeRoot, capabilities: merged };
		const yamlPath = join(this.rootPath, "agents", "root.yaml");
		await writeFile(yamlPath, serializeAgentSpec(updated));
		this.agents.set("root", updated);
		return true;
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
					provenance: "genome",
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
	provenance: "genome" | "bootstrap";
}

export interface AgentFileInfo {
	name: string;
	size: number;
	path: string;
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

/** Serialize an AgentSpec to YAML with explicit field ordering. */
export function serializeAgentSpec(spec: AgentSpec): string {
	const obj: Record<string, unknown> = {
		name: spec.name,
		description: spec.description,
		model: spec.model,
		capabilities: spec.capabilities,
		constraints: spec.constraints,
		tags: spec.tags,
		system_prompt: spec.system_prompt,
		version: spec.version,
	};
	if (spec.thinking !== undefined) {
		obj.thinking = spec.thinking;
	}
	return stringify(obj);
}
