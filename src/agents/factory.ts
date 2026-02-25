import { existsSync } from "node:fs";
import { join } from "node:path";
import { Genome } from "../genome/genome.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import { LearnProcess } from "../learn/learn-process.ts";
import { MetricsStore } from "../learn/metrics-store.ts";
import { Client } from "../llm/client.ts";
import type { Message } from "../llm/types.ts";
import { ulid } from "../util/ulid.ts";
import { Agent } from "./agent.ts";
import { AgentEventEmitter } from "./events.ts";
import { loadPreambles } from "./loader.ts";
import { loadProjectDocs } from "./project-doc.ts";

export interface CreateAgentOptions {
	/** Path to the genome directory */
	genomePath: string;
	/** Path to bootstrap agent YAML files. Required for first-time setup. */
	bootstrapDir?: string;
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
 * Handles genome initialization, bootstrap loading, and full wiring.
 */
export async function createAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
	const genome = new Genome(options.genomePath);

	// Check if genome already exists (has a .git directory)
	const isExisting = existsSync(join(options.genomePath, ".git"));

	if (isExisting) {
		await genome.loadFromDisk();
		// Sync any new bootstrap agents that were added since the genome was initialized
		if (options.bootstrapDir) {
			const added = await genome.syncBootstrap(options.bootstrapDir);
			if (added.length > 0) {
				console.error(`Synced new bootstrap agents: ${added.join(", ")}`);
			}
		}
	} else {
		await genome.init();
		if (options.bootstrapDir) {
			await genome.initFromBootstrap(options.bootstrapDir);
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
	const preambles = options.bootstrapDir ? await loadPreambles(options.bootstrapDir) : undefined;
	const projectDocs = await loadProjectDocs({ cwd: workDir });

	const events = options.events ?? new AgentEventEmitter();

	const metrics = new MetricsStore(join(options.genomePath, "metrics", "metrics.jsonl"));
	await metrics.load();
	const pendingEvaluationsPath = join(options.genomePath, "metrics", "pending-evaluations.json");
	const learnProcess = new LearnProcess({
		genome,
		metrics,
		events,
		client,
		pendingEvaluationsPath,
	});

	const sessionId = options.sessionId ?? ulid();
	const logBasePath = join(options.genomePath, "logs", sessionId);

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
		preambles,
		projectDocs,
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
