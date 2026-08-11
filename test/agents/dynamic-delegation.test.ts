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
import { ContentKind, Msg, messageText, type Request, type Response } from "../../src/llm/types.ts";
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

	test("live delegate additions are one-turn runtime context, not user steering", async () => {
		const genome = new Genome(genomeDir);
		await genome.loadFromDisk();
		const events = new AgentEventEmitter();
		const capturedRequests: Request[] = [];
		const client = {
			providers: () => ["anthropic"],
			complete: async (request: Request): Promise<Response> => {
				capturedRequests.push(request);
				if (capturedRequests.length === 2) {
					return {
						id: "test-tool-call",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: {
							role: "assistant",
							content: [
								{
									kind: ContentKind.TOOL_CALL,
									tool_call: {
										id: "call-1",
										name: "exec",
										arguments: { command: "true" },
									},
								},
							],
						},
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					};
				}
				return {
					id: "test-id",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("DONE"),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const rootSpec = makeSpec("root", {
			constraints: {
				max_turns: 2,
				timeout_ms: 0,
				can_spawn: true,
				can_learn: false,
			},
			agents: ["child-agent"],
			tools: ["exec"],
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
			client,
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
			agentTree,
			agentTreeChildren: ["child-agent"],
			agentTreeSelfPath: "",
		});

		await agent.run("test goal");

		// Now add a new agent to the genome (simulating fabricator creating an agent)
		await genome.addAgent(
			makeSpec("new-dynamic-agent", { description: "A dynamically created agent" }),
		);

		await agent.continue("keep going", undefined);
		await agent.continue("keep going again", undefined);

		expect(events.collected().filter((event) => event.kind === "steering")).toHaveLength(0);
		const delegationUpdates = events
			.collected()
			.filter((event) => event.kind === "delegation_update");
		expect(delegationUpdates).toHaveLength(1);
		expect(delegationUpdates[0]!.data.agents).toEqual([
			{ name: "new-dynamic-agent", description: "A dynamically created agent" },
		]);

		expect(messageText(capturedRequests[1]!.messages[0]!)).toContain("<sprout:delegation-update>");
		expect(
			capturedRequests[1]!.messages.some(
				(message) => message.role === "user" && messageText(message).includes("New agents"),
			),
		).toBe(false);
		// The second request is in the same runLoop after a tool call.
		expect(messageText(capturedRequests[2]!.messages[0]!)).not.toContain(
			"<sprout:delegation-update>",
		);
		// A later continue() also must not receive the consumed update.
		expect(messageText(capturedRequests[3]!.messages[0]!)).not.toContain(
			"<sprout:delegation-update>",
		);
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

	test("reconstructs genome-only root delegates without flattening nested agents", async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), "dyn-deleg-reconstruct-"));
		const fixtureWorkDir = await mkdtemp(join(tmpdir(), "dyn-deleg-reconstruct-work-"));
		try {
			await mkdir(join(fixtureDir, "agents"), { recursive: true });
			await mkdir(join(fixtureDir, "memories"), { recursive: true });

			const rootSpec = makeSpec("root", {
				constraints: {
					max_turns: 1,
					timeout_ms: 0,
					can_spawn: true,
					can_learn: false,
				},
				tools: ["read_file"],
			});
			const nestedSpec = makeSpec("nested-specialist");
			await writeFile(join(fixtureDir, "agents", "root.md"), serializeAgentMarkdown(rootSpec));
			await writeFile(
				join(fixtureDir, "agents", "nested-specialist.md"),
				serializeAgentMarkdown(nestedSpec),
			);
			Bun.spawnSync(["git", "init"], { cwd: fixtureDir });
			Bun.spawnSync(["git", "add", "."], { cwd: fixtureDir });
			Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: fixtureDir });

			const genome = new Genome(fixtureDir);
			await genome.loadFromDisk();
			const makeStaticTree = (rootChildren: string[]) =>
				new Map([
					["root", { spec: rootSpec, path: "", children: rootChildren, diskPath: "" }],
					[
						"team/nested-specialist",
						{
							spec: nestedSpec,
							path: "team/nested-specialist",
							children: [],
							diskPath: "",
						},
					],
				]);
			const makeRoot = (rootChildren: string[], agentTree = makeStaticTree(rootChildren)) =>
				new Agent({
					spec: rootSpec,
					env: new LocalExecutionEnvironment(fixtureWorkDir),
					client: makeDoneClient(),
					primitiveRegistry: createPrimitiveRegistry(new LocalExecutionEnvironment(fixtureWorkDir)),
					availableAgents: genome.allAgents(),
					genome,
					depth: 0,
					agentTree,
					agentTreeChildren: rootChildren,
					agentTreeSelfPath: "",
				});
			const delegatedNames = (agent: Agent) => {
				const delegateTool = agent.resolvedTools().find((tool) => tool.name === "delegate");
				const properties = delegateTool?.parameters.properties as
					| Record<string, { description?: unknown }>
					| undefined;
				const description = properties?.agent_name?.description;
				if (typeof description !== "string") return [];
				const knownNames = description.split(" Known agents: ")[1];
				if (!knownNames?.endsWith(".")) return [];
				return knownNames.slice(0, -1).split(", ");
			};

			const liveAgent = makeRoot([]);
			await liveAgent.run("test goal");
			await genome.addAgent(makeSpec("persisted-agent"));
			await liveAgent.continue("refresh delegates");

			const reconstructedRootChildren: string[] = [];
			const sharedTree = makeStaticTree(reconstructedRootChildren);
			new Agent({
				spec: nestedSpec,
				env: new LocalExecutionEnvironment(fixtureWorkDir),
				client: makeDoneClient(),
				primitiveRegistry: createPrimitiveRegistry(new LocalExecutionEnvironment(fixtureWorkDir)),
				availableAgents: genome.allAgents(),
				genome,
				depth: 1,
				agentTree: sharedTree,
				agentTreeChildren: [],
				agentTreeSelfPath: "team/nested-specialist",
			});
			const reconstructedAgent = makeRoot(reconstructedRootChildren, sharedTree);
			const reconstructedNames = delegatedNames(reconstructedAgent);
			expect(reconstructedNames).toEqual(["persisted-agent"]);
			expect(delegatedNames(liveAgent)).toEqual(reconstructedNames);
		} finally {
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(fixtureWorkDir, { recursive: true, force: true });
		}
	});
});
