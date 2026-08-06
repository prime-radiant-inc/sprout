import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { type AgentOptions, Agent as RawAgent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import type { AgentSpawner } from "../../src/bus/spawner.ts";
import type { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { makeMockClient, rootSpec, withDefaultResolverContext } from "../agents/fixtures.ts";
import "../helpers/test-env.ts";

class Agent extends RawAgent {
	constructor(options: AgentOptions) {
		super(withDefaultResolverContext(options));
	}
}

const fakeStore = {
	async names() {
		return [];
	},
	async bind() {
		throw new Error("unused");
	},
} as unknown as NonNullable<AgentSpawner["storeAccess"]>;

const spawner = { storeAccess: fakeStore, getHandle: () => undefined } as unknown as AgentSpawner;

const fakeGenome = {
	allPrograms: () => [],
	allAgents: () => [],
	findAgents: () => [],
	agents: () => [],
	getAgent: () => undefined,
	resolveDelegatable: () => [],
} as unknown as Genome;

describe("capture arming vs registry rebuild", () => {
	test("constructor arms capture: read_file gains bind, store set", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: { ...rootSpec, tools: ["read_file", "exec"] },
			env,
			client: makeMockClient(),
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events: new AgentEventEmitter(),
			genome: fakeGenome,
			spawner,
		});
		const reg = (agent as any).primitiveRegistry;
		const props = reg.get("read_file").parameters.properties as Record<string, unknown>;
		expect(props.bind).toBeDefined();
	});

	test("the run()-path rebuild keeps capture armed", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: { ...rootSpec, tools: ["read_file", "exec"] },
			env,
			client: makeMockClient(),
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events: new AgentEventEmitter(),
			genome: fakeGenome,
			spawner,
		});
		// Exactly what run() does at depth 0 before the first turn:
		(agent as any).updateTrustedUserInstruction("the user goal");
		const reg = (agent as any).primitiveRegistry;
		const props = reg.get("read_file").parameters.properties as Record<string, unknown>;
		expect(props.bind).toBeDefined();
	});
});
