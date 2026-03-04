import { tmpdir } from "node:os";
import { Agent } from "../../src/agents/agent.ts";
import type { AgentEventEmitter } from "../../src/agents/events.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Message, Response } from "../../src/llm/types.ts";
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

export function makeMockClient(response: Response = DEFAULT_RESPONSE): Client {
	return {
		providers: () => ["anthropic"],
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
	const agent = new Agent({
		spec: options.spec ?? leafSpec,
		env,
		client: options.client ?? makeMockClient(),
		primitiveRegistry,
		availableAgents: options.availableAgents ?? [rootSpec, leafSpec],
		depth: options.depth ?? 0,
		events: options.events,
		initialHistory: options.initialHistory,
		enableStreaming: options.enableStreaming,
	});

	return { agent, env, primitiveRegistry };
}
