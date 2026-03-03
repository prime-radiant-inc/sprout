import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpawner } from "../bus/spawner.ts";
import { DEV_MODE_POSTSCRIPT, DEV_MODE_SENTINEL, isDevMode } from "../genome/dev-mode.ts";
import { Genome } from "../genome/genome.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import { LearnProcess } from "../learn/learn-process.ts";
import { MetricsStore } from "../learn/metrics-store.ts";
import { Client } from "../llm/client.ts";
import type { Message } from "../llm/types.ts";
import { ensureProjectDirs } from "../util/project-id.ts";
import { ulid } from "../util/ulid.ts";
import { Agent } from "./agent.ts";
import { AgentEventEmitter } from "./events.ts";
import { loadPreambles, scanAgentTree } from "./loader.ts";
import { loadProjectDocs } from "./project-doc.ts";

export interface CreateAgentOptions {
	/** Path to the genome directory */
	genomePath: string;
	/** Path to root agent spec directory. Required for first-time setup. */
	rootDir?: string;
	/** Working directory for the agent */
	workDir?: string;
	/** Name of the root agent to use (default: "root") */
	rootAgent?: string;
	/** Pre-configured LLM client. If not provided, creates from env vars. */
	client?: Client;
	/** Event emitter for observing agent events */
	events?: AgentEventEmitter;
	/** Explicit session ID (for resume). If not provided, generates a new ULID. */
	sessionId?: string;
	/** Prior conversation history for resume/continuation. */
	initialHistory?: Message[];
	/** Model override — if provided, overrides the root agent's spec model. */
	model?: string;
	/** Bus-based spawner for running subagents as separate processes. */
	spawner?: AgentSpawner;
	/** Pre-loaded Genome instance. If provided, skips loading from disk. */
	genome?: Genome;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("../host/logger.ts").Logger;
	/** Per-project data directory (sessions, logs, memory). Defaults to genomePath. */
	projectDataDir?: string;
}

export interface CreateAgentResult {
	agent: Agent;
	genome: Genome;
	events: AgentEventEmitter;
	learnProcess: LearnProcess;
	client: Client;
	model: string;
	provider: string;
}

/**
 * Create an agent wired to a genome with recall.
 * Handles genome initialization, root agent loading, and full wiring.
 */
export async function createAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
	const genome = options.genome ?? new Genome(options.genomePath, options.rootDir);

	if (!options.genome) {
		// Check if genome already exists (has a .git directory)
		const isExisting = existsSync(join(options.genomePath, ".git"));

		if (isExisting) {
			await genome.loadFromDisk();
			if (options.rootDir) {
				const result = await genome.syncRoot();
				if (result.added.length > 0) {
					console.error(`Synced new root agents: ${result.added.join(", ")}`);
				}
				if (result.conflicts.length > 0) {
					console.error(`Root sync conflicts (genome preserved): ${result.conflicts.join(", ")}`);
				}
			}
		} else {
			await genome.init();
			if (options.rootDir) {
				await genome.initFromRoot();
			}
		}
	}

	// Ensure project data directory structure exists (sessions/, logs/, memory/)
	const dataDir = options.projectDataDir ?? options.genomePath;
	await ensureProjectDirs(dataDir);

	// Inject development mode postscript if running inside sprout's source tree
	if (options.workDir && (await isDevMode(options.workDir))) {
		const existingPostscript = await genome.loadAgentPostscript("quartermaster");
		if (!existingPostscript.includes(DEV_MODE_SENTINEL)) {
			await genome.savePostscript("agents/quartermaster.md", DEV_MODE_POSTSCRIPT);
		}
	}

	const rootName = options.rootAgent ?? "root";
	const rootSpec = genome.getAgent(rootName);
	if (!rootSpec) {
		throw new Error(
			`Root agent '${rootName}' not found in genome. Available: ${genome
				.allAgents()
				.map((a) => a.name)
				.join(", ")}`,
		);
	}

	const workDir = options.workDir ?? process.cwd();
	const env = new LocalExecutionEnvironment(workDir);
	const client = options.client ?? Client.fromEnv();
	const registry = createPrimitiveRegistry(env);
	const preambles = options.rootDir ? await loadPreambles(options.rootDir) : undefined;
	const projectDocs = await loadProjectDocs({ cwd: workDir });
	const genomePostscripts = await genome.loadPostscripts();

	const events = options.events ?? new AgentEventEmitter();

	// Fetch available models from provider APIs (once, shared with Agent + LearnProcess)
	const modelsByProvider = await client.listModelsByProvider();

	const metrics = new MetricsStore(join(options.genomePath, "metrics", "metrics.jsonl"));
	await metrics.load();
	const pendingEvaluationsPath = join(options.genomePath, "metrics", "pending-evaluations.json");
	const learnProcess = new LearnProcess({
		genome,
		metrics,
		events,
		client,
		pendingEvaluationsPath,
		modelsByProvider,
		logger: options.logger,
	});

	const sessionId = options.sessionId ?? ulid();
	const logBasePath = join(dataDir, "logs", sessionId);

	// Scan the agent tree for path-based delegation resolution
	const agentTree = options.rootDir ? await scanAgentTree(options.rootDir) : undefined;

	// Root's children are the top-level entries in the tree (paths without slashes)
	const agentTreeChildren = agentTree
		? [...agentTree.keys()].filter((p) => !p.includes("/"))
		: undefined;

	const agent = new Agent({
		spec: rootSpec,
		env,
		client,
		primitiveRegistry: registry,
		availableAgents: genome.allAgents(),
		genome,
		events,
		learnProcess,
		sessionId,
		logBasePath,
		initialHistory: options.initialHistory,
		modelOverride: options.model,
		modelsByProvider,
		preambles,
		projectDocs,
		genomePostscripts,
		spawner: options.spawner,
		genomePath: options.genomePath,
		projectDataDir: options.projectDataDir,
		logger: options.logger,
		rootDir: options.rootDir,
		agentTree,
		agentTreeChildren,
		agentTreeSelfPath: agentTree ? "" : undefined,
		enableStreaming: true,
	});

	const resolved = agent.resolvedModel;
	return {
		agent,
		genome,
		events,
		learnProcess,
		client,
		model: resolved.model,
		provider: resolved.provider,
	};
}
