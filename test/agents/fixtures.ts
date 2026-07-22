import { tmpdir } from "node:os";
import { Agent, type AgentOptions } from "../../src/agents/agent.ts";
import { formatDelegationGoal, normalizeTaskPayload } from "../../src/agents/delegation-payload.ts";
import type { AgentEventEmitter } from "../../src/agents/events.ts";
import type { AgentTreeEntry } from "../../src/agents/loader.ts";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { renderCallerIdentity } from "../../src/agents/plan.ts";
import type { AgentSpawner, SpawnAgentOptions } from "../../src/bus/spawner.ts";
import type { ResultMessage } from "../../src/bus/types.ts";
import type { Genome } from "../../src/genome/genome.ts";
import { deriveTrustedMemoryWriteAuthorization } from "../../src/genome/memory-write-authorization.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Message, ProviderModel, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
import { ulid } from "../../src/util/ulid.ts";

export const rootSpec: AgentSpec = {
	name: "root",
	description: "Test root",
	system_prompt: "You decompose tasks.",
	model: "fast",
	tools: [],
	agents: ["leaf"],
	constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 10 },
	tags: [],
	version: 1,
};

export const leafSpec: AgentSpec = {
	name: "leaf",
	description: "Test leaf",
	system_prompt: "You do things.",
	model: "fast",
	tools: ["read_file", "write_file", "exec"],
	agents: [],
	constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
	tags: [],
	version: 1,
};

const DEFAULT_RESPONSE: Response = {
	id: "fixture-default",
	model: "claude-haiku-4-5-20251001",
	provider: "anthropic",
	message: Msg.assistant("DONE"),
	finish_reason: { reason: "stop" },
	usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

export const TEST_PROVIDER_ID = "anthropic";
export const TEST_MODELS: ProviderModel[] = [
	{ id: "claude-opus-4-6", label: "claude-opus-4-6", source: "remote" },
	{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", source: "remote" },
	{
		id: "claude-haiku-4-5-20251001",
		label: "claude-haiku-4-5-20251001",
		source: "remote",
	},
];

export function createDefaultModelsByProvider(): Map<string, ProviderModel[]> {
	return new Map([[TEST_PROVIDER_ID, [...TEST_MODELS]]]);
}

export function createDefaultResolverSettings() {
	return createResolverSettings(
		[
			{
				id: TEST_PROVIDER_ID,
				enabled: true,
			},
		],
		{
			best: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODELS[0]!.id },
			balanced: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODELS[1]!.id },
			fast: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODELS[2]!.id },
		},
	);
}

export function withDefaultResolverContext<T extends AgentOptions>(options: T): T {
	return {
		providerIdOverride: TEST_PROVIDER_ID,
		resolverSettings: createDefaultResolverSettings(),
		modelsByProvider: createDefaultModelsByProvider(),
		...options,
	};
}

export function makeMockClient(response: Response = DEFAULT_RESPONSE): Client {
	const modelsByProvider = createDefaultModelsByProvider();
	return {
		providers: () => [TEST_PROVIDER_ID],
		listModelsByProvider: async () => modelsByProvider,
		complete: async () => response,
		stream: async function* () {},
	} as unknown as Client;
}

export interface AgentFixtureOptions {
	spec?: AgentSpec;
	client?: Client;
	availableAgents?: AgentSpec[];
	depth?: number;
	events?: AgentEventEmitter;
	env?: LocalExecutionEnvironment;
	initialHistory?: Message[];
	enableStreaming?: boolean;
	llmRetryOptions?: AgentOptions["llmRetryOptions"];
}

export interface InProcessSpawnerConfig {
	client: Client;
	events?: AgentEventEmitter;
	availableAgents?: AgentSpec[];
	genome?: Genome;
	agentTree?: Map<string, AgentTreeEntry>;
	rootDir?: string;
	sessionId?: string;
	modelsByProvider?: Map<string, ProviderModel[]>;
	/** Production children stream (agent-process sets true); default false so
	 * mock clients with stub stream() keep using complete(). */
	enableStreaming?: boolean;
}

/**
 * An in-process AgentSpawner fake for delegation tests: spawnAgent constructs
 * a REAL child Agent from the test's specs/genome/tree and runs it in the test
 * process, mirroring the production child entry (src/bus/agent-process.ts) —
 * same goal formatting, spec resolution, registry scoping, tree wiring, and
 * result shape — without a bus or subprocesses. Children share the fake, so
 * nested delegation chains run end-to-end.
 */
export function createInProcessSpawner(config: InProcessSpawnerConfig): {
	spawner: AgentSpawner;
	spawnCalls: SpawnAgentOptions[];
} {
	const sessionId = config.sessionId ?? "in-process-spawner-session";
	const spawnCalls: SpawnAgentOptions[] = [];
	const handles = new Map<
		string,
		{ handleId: string; agentId: string; agentName: string; result: Promise<ResultMessage> }
	>();

	// Mirror the production child's spec lookup (genome, overlay first), with
	// the tree and availableAgents fallbacks the spawnerless tests rely on.
	const resolveChildSpec = (agentName: string): AgentSpec | undefined => {
		const bareName = agentName.includes("/") ? agentName.split("/").pop()! : agentName;
		const genomeSpec = config.genome?.getAgent?.(agentName) ?? config.genome?.getAgent?.(bareName);
		if (genomeSpec) return genomeSpec;
		if (config.agentTree) {
			const entry =
				config.agentTree.get(agentName) ??
				[...config.agentTree.values()].find(
					(e) => e.spec.name === agentName || e.spec.name === bareName,
				);
			if (entry) return entry.spec;
		}
		const agents = config.availableAgents ?? [];
		return agents.find((a) => a.name === agentName) ?? agents.find((a) => a.name === bareName);
	};

	const runChild = async (
		opts: SpawnAgentOptions,
		handleId: string,
		agentId: string,
	): Promise<ResultMessage> => {
		const fail = (output: string): ResultMessage => ({
			kind: "result",
			handle_id: handleId,
			output,
			success: false,
			stumbles: 0,
			turns: 0,
			timed_out: false,
		});

		const loadedSpec = resolveChildSpec(opts.agentName);
		if (!loadedSpec) {
			return fail(`Agent '${opts.agentName}' not found in genome`);
		}
		const spec = {
			...loadedSpec,
			system_prompt: loadedSpec.system_prompt + renderCallerIdentity(opts.caller),
		};

		const env = new LocalExecutionEnvironment(opts.workDir);
		const evalMode = opts.evalMode === true;
		const allowExec = opts.allowExec !== false;
		const writeAuthorization = deriveTrustedMemoryWriteAuthorization({
			agentName: opts.agentName,
			userInstruction: opts.trustedUserInstruction,
		});
		const registry = config.genome
			? createPrimitiveRegistry(
					env,
					{
						genome: config.genome,
						agentName: opts.agentName,
						sessionId,
						...(writeAuthorization ? { writeAuthorization } : {}),
					},
					{ evalMode, allowExec },
				)
			: createPrimitiveRegistry(env, undefined, { evalMode, allowExec });

		// Mirror agent-process: find this agent's tree entry for child resolution.
		let agentTreeSelfPath: string | undefined;
		let agentTreeChildren: string[] | undefined;
		if (config.agentTree) {
			for (const [path, entry] of config.agentTree) {
				if (entry.spec.name === spec.name) {
					agentTreeSelfPath = path;
					agentTreeChildren = entry.children;
					break;
				}
			}
		}

		const childDepth = opts.caller.depth + 1;
		const child = new Agent(
			withDefaultResolverContext({
				spec,
				env,
				client: config.client,
				primitiveRegistry: registry,
				availableAgents: config.genome?.allAgents?.() ?? config.availableAgents ?? [],
				...(config.genome ? { genome: config.genome } : {}),
				depth: childDepth,
				...(config.events ? { events: config.events } : {}),
				sessionId,
				spawner,
				...(opts.projectDataDir ? { projectDataDir: opts.projectDataDir } : {}),
				evalMode,
				allowExec,
				...(opts.dataPlaneEnabled !== undefined ? { dataPlaneEnabled: opts.dataPlaneEnabled } : {}),
				agentId,
				...(opts.model !== undefined ? { modelOverride: opts.model } : {}),
				...(opts.providerIdOverride !== undefined
					? { providerIdOverride: opts.providerIdOverride }
					: {}),
				...(opts.resolverSettings !== undefined ? { resolverSettings: opts.resolverSettings } : {}),
				...(config.modelsByProvider ? { modelsByProvider: config.modelsByProvider } : {}),
				...(config.rootDir ? { rootDir: config.rootDir } : {}),
				...(config.agentTree
					? { agentTree: config.agentTree, agentTreeChildren, agentTreeSelfPath }
					: {}),
				...(config.enableStreaming !== undefined ? { enableStreaming: config.enableStreaming } : {}),
				surfacedMemoryBlock: opts.surfacedMemoryBlock,
				trustedUserInstruction: opts.trustedUserInstruction,
				self: { agentName: opts.agentName, depth: childDepth, handleId, agentId },
				caller: opts.caller,
			}),
		);

		const goal = formatDelegationGoal({
			goal: opts.goal,
			hints: opts.hints,
			payload: opts.payload ? normalizeTaskPayload(opts.payload, "agent start message") : undefined,
		});

		try {
			const result = await child.run(goal);
			return {
				kind: "result",
				handle_id: handleId,
				output: result.output,
				success: result.success,
				stumbles: result.stumbles,
				turns: result.turns,
				timed_out: result.timed_out,
			};
		} catch (err) {
			return fail(`Initial run failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const spawner = {
		spawnAgent: async (opts: SpawnAgentOptions): Promise<ResultMessage | string> => {
			spawnCalls.push(opts);
			const handleId = opts.handleId ?? ulid();
			const agentId = opts.agentId ?? handleId;
			const result = runChild(opts, handleId, agentId);
			handles.set(handleId, { handleId, agentId, agentName: opts.agentName, result });
			if (opts.blocking) {
				return result;
			}
			result.catch(() => {});
			return handleId;
		},
		waitAgent: async (handleId: string): Promise<ResultMessage> => {
			const handle = handles.get(handleId);
			if (!handle) throw new Error(`Unknown handle: ${handleId}`);
			return handle.result;
		},
		getHandles: () => [...handles.keys()],
		getHandle: (handleId: string) => handles.get(handleId),
		shutdown: async () => {},
	} as unknown as AgentSpawner;

	return { spawner, spawnCalls };
}

export function createAgentFixture(options: AgentFixtureOptions = {}) {
	const env = options.env ?? new LocalExecutionEnvironment(tmpdir());
	const primitiveRegistry = createPrimitiveRegistry(env);
	const agent = new Agent(
		withDefaultResolverContext({
			spec: options.spec ?? leafSpec,
			env,
			client: options.client ?? makeMockClient(),
			primitiveRegistry,
			availableAgents: options.availableAgents ?? [rootSpec, leafSpec],
			depth: options.depth ?? 0,
			events: options.events,
			initialHistory: options.initialHistory,
			enableStreaming: options.enableStreaming,
			llmRetryOptions: options.llmRetryOptions,
		}),
	);

	return { agent, env, primitiveRegistry };
}
