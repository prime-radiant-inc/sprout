import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadAgentSpec, loadBootstrapAgents } from "../agents/loader.ts";
import type { AgentSpec, Memory, RoutingRule } from "../kernel/types.ts";
import { MemoryStore } from "./memory-store.ts";

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

const DIRS = ["agents", "memories", "routing", "embeddings", "metrics", "logs"] as const;

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

	/** Mark memories as used by id, saving and committing. */
	async markMemoriesUsed(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		for (const id of ids) {
			this.memories.markUsed(id);
		}
		await this.memories.save();
		await git(this.rootPath, "add", join(this.rootPath, "memories", "memories.jsonl"));
		await git(this.rootPath, "commit", "-m", `genome: mark ${ids.length} memories used`);
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
}

/** Serialize an AgentSpec to YAML with explicit field ordering. */
function serializeAgentSpec(spec: AgentSpec): string {
	return stringify({
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
	});
}
