import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentOptions, Agent as RawAgent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry, type PrimitiveRegistry } from "../../src/kernel/primitives.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import { Msg } from "../../src/llm/types.ts";
import { withDefaultResolverContext } from "./fixtures.ts";

class Agent extends RawAgent {
	constructor(options: AgentOptions) {
		super(withDefaultResolverContext(options));
	}
}

function makeSpec(name: string, overrides?: Partial<AgentSpec>): AgentSpec {
	return {
		name,
		description: `${name} agent`,
		system_prompt: "You are a test agent.",
		model: "fast",
		constraints: {
			max_turns: 10,
			timeout_ms: 0,
			can_spawn: false,
			can_learn: false,
		},
		tags: [],
		version: 1,
		tools: [],
		agents: [],
		...overrides,
	};
}

function makeDoneClient(): Client {
	return {
		providers: () => ["anthropic"],
		complete: async () => ({
			id: "test-id",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: Msg.assistant("DONE"),
			finish_reason: { reason: "stop" as const },
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		}),
		stream: async function* () {},
	} as unknown as Client;
}

describe("Dynamic delegation list refresh", () => {
	let genomeDir: string;
	let workDir: string;
	let registry: PrimitiveRegistry;
	let env: LocalExecutionEnvironment;

	beforeAll(async () => {
		genomeDir = await mkdtemp(join(tmpdir(), "dyn-deleg-genome-"));
		workDir = await mkdtemp(join(tmpdir(), "dyn-deleg-work-"));
		await mkdir(join(genomeDir, "agents"), { recursive: true });
		await mkdir(join(genomeDir, "memories"), { recursive: true });

		// Create initial child agent
		const childSpec = makeSpec("child-agent", {
			description: "A child worker agent",
		});
		await writeFile(join(genomeDir, "agents", "child-agent.md"), serializeAgentMarkdown(childSpec));

		// Init git repo
		Bun.spawnSync(["git", "init"], { cwd: genomeDir });
		Bun.spawnSync(["git", "add", "."], { cwd: genomeDir });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: genomeDir });

		env = new LocalExecutionEnvironment(workDir);
		registry = createPrimitiveRegistry(env);
	});

	afterAll(async () => {
		await rm(genomeDir, { recursive: true, force: true });
		await rm(workDir, { recursive: true, force: true });
	});

	test("no false trigger on first turn — no steering emitted when genome unchanged", async () => {
		const genome = new Genome(genomeDir);
		await genome.loadFromDisk();
		const events = new AgentEventEmitter();

		const rootSpec = makeSpec("root", {
			constraints: {
				max_turns: 1,
				timeout_ms: 0,
				can_spawn: true,
				can_learn: false,
			},
			agents: ["child-agent"],
		});

		const agent = new Agent({
			spec: rootSpec,
			env,
			client: makeDoneClient(),
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
		});

		await agent.run("test goal");

		const steeringEvents = events.collected().filter((e) => e.kind === "steering");
		// No steering events about new agents — genome hasn't changed
		const delegationSteering = steeringEvents.filter(
			(e) => typeof e.data.text === "string" && e.data.text.includes("New agents"),
		);
		expect(delegationSteering).toHaveLength(0);
	});

	test("steering message emitted when new agent added to genome mid-session", async () => {
		const genome = new Genome(genomeDir);
		await genome.loadFromDisk();
		const events = new AgentEventEmitter();

		const rootSpec = makeSpec("root", {
			constraints: {
				max_turns: 2,
				timeout_ms: 0,
				can_spawn: true,
				can_learn: false,
			},
			agents: ["child-agent"],
		});

		const agentTree = new Map();
		agentTree.set("root", {
			spec: rootSpec,
			path: "",
			children: ["child-agent"],
			diskPath: "",
		});
		agentTree.set("child-agent", {
			spec: genome.getAgent("child-agent")!,
			path: "child-agent",
			children: [],
			diskPath: "",
		});

		const agent = new Agent({
			spec: rootSpec,
			env,
			client: makeDoneClient(),
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
			agentTree,
			agentTreeChildren: ["child-agent"],
			agentTreeSelfPath: "",
		});

		// Run initial turn — should complete without new-agent steering
		await agent.run("test goal");

		// Now add a new agent to the genome (simulating fabricator creating an agent)
		await genome.addAgent(
			makeSpec("new-dynamic-agent", { description: "A dynamically created agent" }),
		);

		// Continue — the refresh should detect the new agent
		await agent.continue("keep going", undefined);

		const steeringEvents = events.collected().filter((e) => e.kind === "steering");
		const delegationSteering = steeringEvents.filter(
			(e) => typeof e.data.text === "string" && e.data.text.includes("New agents"),
		);
		expect(delegationSteering.length).toBeGreaterThanOrEqual(1);

		// Verify the steering message mentions the new agent
		const text = delegationSteering[0]!.data.text as string;
		expect(text).toContain("new-dynamic-agent");
		expect(text).toContain("A dynamically created agent");
	});

	test("resolvedTools updated after genome change", async () => {
		const genome = new Genome(genomeDir);
		await genome.loadFromDisk();
		const events = new AgentEventEmitter();

		const rootSpec = makeSpec("root", {
			constraints: {
				max_turns: 1,
				timeout_ms: 0,
				can_spawn: true,
				can_learn: false,
			},
			agents: ["child-agent"],
		});

		const agentTree = new Map();
		agentTree.set("root", {
			spec: rootSpec,
			path: "",
			children: ["child-agent"],
			diskPath: "",
		});
		agentTree.set("child-agent", {
			spec: genome.getAgent("child-agent")!,
			path: "child-agent",
			children: [],
			diskPath: "",
		});

		const agent = new Agent({
			spec: rootSpec,
			env,
			client: makeDoneClient(),
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
			agentTree,
			agentTreeChildren: ["child-agent"],
			agentTreeSelfPath: "",
		});

		// Run initial turn
		await agent.run("test goal");

		const toolsBefore = agent.resolvedTools();
		const delegateToolBefore = toolsBefore.find((t) => t.name === "delegate");
		expect(delegateToolBefore).toBeDefined();

		// Add new agent to genome
		await genome.addAgent(makeSpec("tools-test-agent", { description: "Tools test agent" }));

		// Continue — should trigger tool rebuild
		await agent.continue("keep going", undefined);

		const toolsAfter = agent.resolvedTools();
		const delegateToolAfter = toolsAfter.find((t) => t.name === "delegate");
		expect(delegateToolAfter).toBeDefined();

		// The delegate tool schema should now reference the new agent
		const schemaStr = JSON.stringify(delegateToolAfter!.parameters);
		expect(schemaStr).toContain("tools-test-agent");
	});

	test("no steering when genome.generation unchanged between turns", async () => {
		const genome = new Genome(genomeDir);
		await genome.loadFromDisk();
		const events = new AgentEventEmitter();

		const rootSpec = makeSpec("root", {
			constraints: {
				max_turns: 2,
				timeout_ms: 0,
				can_spawn: true,
				can_learn: false,
			},
			agents: ["child-agent"],
		});

		const agent = new Agent({
			spec: rootSpec,
			env,
			client: makeDoneClient(),
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
		});

		await agent.run("test goal");

		// Continue WITHOUT changing genome — no steering
		await agent.continue("more work", undefined);

		const steeringEvents = events.collected().filter((e) => e.kind === "steering");
		const delegationSteering = steeringEvents.filter(
			(e) => typeof e.data.text === "string" && e.data.text.includes("New agents"),
		);
		expect(delegationSteering).toHaveLength(0);
	});
});
