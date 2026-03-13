import { tmpdir } from "node:os";
import { Agent, type AgentOptions } from "../../src/agents/agent.ts";
import type { AgentEventEmitter } from "../../src/agents/events.ts";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Message, ProviderModel, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";

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
				tierDefaults: {
					best: TEST_MODELS[0]!.id,
					balanced: TEST_MODELS[1]!.id,
					fast: TEST_MODELS[2]!.id,
				},
			},
		],
		TEST_PROVIDER_ID,
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
		}),
	);

	return { agent, env, primitiveRegistry };
}
