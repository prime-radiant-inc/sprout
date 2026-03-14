import { join } from "node:path";
import type { AgentSpawner } from "../bus/spawner.ts";
import { DEV_MODE_POSTSCRIPT, DEV_MODE_SENTINEL, isDevMode } from "../genome/dev-mode.ts";
import { Genome, git } from "../genome/genome.ts";
import { createReadOnlyGenome } from "../genome/read-only-genome.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import type { ModelRef } from "../kernel/types.ts";
import { LearnProcess } from "../learn/learn-process.ts";
import { MetricsStore } from "../learn/metrics-store.ts";
import { Client } from "../llm/client.ts";
import type { Message } from "../llm/types.ts";
import { ensureProjectDirs } from "../util/project-id.ts";
import { ulid } from "../util/ulid.ts";
import { Agent } from "./agent.ts";
import { AgentEventEmitter } from "./events.ts";
import { loadPreambles, scanAgentTree } from "./loader.ts";
import type { ResolverSettings } from "./model-resolver.ts";
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
	model?: string | ModelRef;
	/** Default provider context for exact-model resolution. */
	providerIdOverride?: string;
	/** Provider settings used for global tier and exact-model resolution. */
	resolverSettings?: ResolverSettings;
	/** Bus-based spawner for running subagents as separate processes. */
	spawner?: AgentSpawner;
	/** Pre-loaded Genome instance. If provided, skips loading from disk. */
	genome?: Genome;
	/** Disable learning and genome mutation for evaluation runs. */
	evalMode?: boolean;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("../core/logger.ts").Logger;
	/** Per-project data directory (sessions, logs, memory). Defaults to genomePath. */
	projectDataDir?: string;
}

export interface CreateAgentResult {
	agent: Agent;
	genome: Genome;
	events: AgentEventEmitter;
	learnProcess: LearnProcess | null;
	client: Client;
	model: string;
	provider: string;
}

async function hasGenomeRepo(genomePath: string): Promise<boolean> {
	try {
		await git(genomePath, "rev-parse", "--git-dir");
		return true;
	} catch {
		return false;
	}
}

/**
 * Create an agent wired to a genome with recall.
 * Handles genome initialization, root agent loading, and full wiring.
 */
export async function createAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
	const genome = options.genome ?? new Genome(options.genomePath, options.rootDir);

	const hasRepo = await hasGenomeRepo(options.genomePath);
	if (hasRepo) {
		if (!options.genome) {
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
		} else if (genome.agentCount() === 0) {
			// Callers may pass a Genome instance before loading it from disk.
			await genome.loadFromDisk();
		}
	} else {
		await genome.init();
		if (options.rootDir) {
			if (options.genome) {
				// Preloaded genomes may already have root agents in memory, which blocks initFromRoot.
				const bootstrapGenome = new Genome(options.genomePath, options.rootDir);
				await bootstrapGenome.initFromRoot();
			} else {
				await genome.initFromRoot();
			}
		}
		if (options.genome) {
			await genome.loadFromDisk();
		}
	}

	// Ensure project data directory structure exists (sessions/, logs/, memory/)
	const dataDir = options.projectDataDir ?? options.genomePath;
	await ensureProjectDirs(dataDir);

	// Dev-mode mutations are disabled for evaluation runs.
	if (!options.evalMode && options.workDir && (await isDevMode(options.workDir))) {
		const existingPostscript = await genome.loadAgentPostscript("quartermaster");
		if (!existingPostscript.includes(DEV_MODE_SENTINEL)) {
			await genome.savePostscript("agents/quartermaster.md", DEV_MODE_POSTSCRIPT);
		}
	}

	const runtimeGenome = options.evalMode ? createReadOnlyGenome(genome) : genome;

	const rootName = options.rootAgent ?? "root";
	const rootSpec = runtimeGenome.getAgent(rootName);
	if (!rootSpec) {
		throw new Error(
			`Root agent '${rootName}' not found in genome. Available: ${runtimeGenome
				.allAgents()
				.map((a) => a.name)
				.join(", ")}`,
		);
	}

	const workDir = options.workDir ?? process.cwd();
	const env = new LocalExecutionEnvironment(workDir);
	const client = options.client ?? Client.fromEnv();
	const registry = createPrimitiveRegistry(env, undefined, { evalMode: options.evalMode });
	const preambles = options.rootDir ? await loadPreambles(options.rootDir) : undefined;
	const projectDocs = await loadProjectDocs({ cwd: workDir });
	const genomePostscripts = await runtimeGenome.loadPostscripts();

	const events = options.events ?? new AgentEventEmitter();

	// Fetch available models from provider APIs (once, shared with Agent + LearnProcess)
	const modelsByProvider = await client.listModelsByProvider();

	const metrics = new MetricsStore(join(options.genomePath, "metrics", "metrics.jsonl"));
	await metrics.load();
	const pendingEvaluationsPath = join(options.genomePath, "metrics", "pending-evaluations.json");
	const learnProcess = options.evalMode
		? null
		: new LearnProcess({
				genome,
				metrics,
				events,
				client,
				pendingEvaluationsPath,
				modelsByProvider,
				providerIdOverride: options.providerIdOverride,
				resolverSettings: options.resolverSettings,
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
		availableAgents: runtimeGenome.allAgents(),
		genome: runtimeGenome,
		events,
		learnProcess: learnProcess ?? undefined,
		sessionId,
		logBasePath,
		initialHistory: options.initialHistory,
		modelOverride: options.model,
		providerIdOverride: options.providerIdOverride,
		resolverSettings: options.resolverSettings,
		modelsByProvider,
		preambles,
		projectDocs,
		genomePostscripts,
		spawner: options.spawner,
		genomePath: options.genomePath,
		projectDataDir: options.projectDataDir,
		agentId: "root",
		logger: options.logger,
		evalMode: options.evalMode,
		rootDir: options.rootDir,
		agentTree,
		agentTreeChildren,
		agentTreeSelfPath: agentTree ? "" : undefined,
		enableStreaming: true,
	});

	const resolved = agent.resolvedModel;
	return {
		agent,
		genome: runtimeGenome,
		events,
		learnProcess,
		client,
		model: resolved.model,
		provider: resolved.provider,
	};
}
