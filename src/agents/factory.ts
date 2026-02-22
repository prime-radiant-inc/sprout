import { existsSync } from "node:fs";
import { join } from "node:path";
import { Genome } from "../genome/genome.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import { LearnProcess } from "../learn/learn-process.ts";
import { MetricsStore } from "../learn/metrics-store.ts";
import { Client } from "../llm/client.ts";
import { Agent } from "./agent.ts";
import { AgentEventEmitter } from "./events.ts";

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
}

export interface CreateAgentResult {
	agent: Agent;
	genome: Genome;
	events: AgentEventEmitter;
	learnProcess: LearnProcess;
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
	const events = options.events ?? new AgentEventEmitter();

	const metrics = new MetricsStore(join(options.genomePath, "metrics", "metrics.jsonl"));
	await metrics.load();
	const learnProcess = new LearnProcess({ genome, metrics, events, client });

	const sessionId = crypto.randomUUID();
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
	});

	return { agent, genome, events, learnProcess };
}
