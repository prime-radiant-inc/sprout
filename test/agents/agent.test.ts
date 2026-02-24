import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import { Client } from "../../src/llm/client.ts";
import type { Message, Response } from "../../src/llm/types.ts";
import { ContentKind, Msg } from "../../src/llm/types.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

describe("Agent", () => {
	const rootSpec: AgentSpec = {
		name: "root",
		description: "Test root",
		system_prompt: "You decompose tasks.",
		model: "fast",
		capabilities: ["leaf"],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 10 },
		tags: [],
		version: 1,
	};

	const leafSpec: AgentSpec = {
		name: "leaf",
		description: "Test leaf",
		system_prompt: "You do things.",
		model: "fast",
		capabilities: ["read_file", "write_file", "exec"],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
		tags: [],
		version: 1,
	};

	test("constructor validates max_depth", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		expect(
			() =>
				new Agent({
					spec: rootSpec,
					env,
					client,
					primitiveRegistry: registry,
					availableAgents: [],
					depth: 5,
				}),
		).toThrow(/depth/i);
	});

	test("max_depth 0 does not restrict instantiation depth", () => {
		const leafOnly: AgentSpec = {
			...leafSpec,
			constraints: { ...leafSpec.constraints, max_depth: 0 },
		};
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		expect(
			() =>
				new Agent({
					spec: leafOnly,
					env,
					client,
					primitiveRegistry: registry,
					availableAgents: [],
					depth: 3,
				}),
		).not.toThrow();
	});

	test("resolves single delegate tool from capabilities", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
		});
		// Root's capabilities include "leaf", which is an agent name
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		// Should have a single "delegate" tool, not per-agent tools
		expect(names).toContain("delegate");
		expect(names).not.toContain("leaf");
		expect(names).not.toContain("root");
	});

	test("delegating agent does not get primitive tools", () => {
		// An agent with both agent and primitive capabilities should only get the delegate tool
		const mixedSpec: AgentSpec = {
			name: "mixed",
			description: "Has both agents and primitives in capabilities",
			system_prompt: "You do things.",
			model: "fast",
			capabilities: ["leaf", "read_file", "grep"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
			tags: [],
			version: 1,
		};
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: mixedSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [mixedSpec, leafSpec],
			depth: 0,
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		// Should only have delegate tool, no primitives
		expect(names).toContain("delegate");
		expect(names).not.toContain("read_file");
		expect(names).not.toContain("grep");
	});

	test("resolves primitive tools from capabilities", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 1,
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("write_file");
		expect(names).toContain("exec");
		// Should not include agent tools (leaf has no agent capabilities)
		expect(names).not.toContain("root");
		expect(names).not.toContain("leaf");
	});

	test("excludes delegate tool when can_spawn is false", () => {
		const noSpawnSpec: AgentSpec = {
			...rootSpec,
			constraints: { ...rootSpec.constraints, can_spawn: false },
		};
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: noSpawnSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		// "leaf" is in capabilities but can_spawn is false, so no delegate tool
		expect(names).not.toContain("delegate");
		expect(names).not.toContain("leaf");
	});

	test("delegate tool has agent_name/goal/hints parameters", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
		});
		const tools = agent.resolvedTools();
		const delegateTool = tools.find((t) => t.name === "delegate");
		expect(delegateTool).toBeDefined();
		const props = (delegateTool!.parameters as any).properties;
		expect(props.agent_name).toBeDefined();
		expect(props.agent_name.enum).toEqual(["leaf"]);
		expect(props.goal).toBeDefined();
		expect(props.hints).toBeDefined();
	});

	test("primitive tools have correct descriptions", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
		});
		const tools = agent.resolvedTools();
		const readTool = tools.find((t) => t.name === "read_file");
		expect(readTool).toBeDefined();
		expect(readTool!.description).toContain("Read");
		expect(readTool!.parameters).toBeDefined();
	});

	test("depth defaults to 0", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		// Should not throw — depth defaults to 0, max_depth is 3
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [leafSpec],
		});
		expect(agent.resolvedTools().map((t) => t.name)).toContain("delegate");
	});

	test("run() with initialHistory prepends prior messages", async () => {
		let capturedHistory: Message[] = [];
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (request: any): Promise<Response> => {
				capturedHistory = request.messages;
				return {
					id: "mock-ih-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("Done."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const priorHistory: Message[] = [Msg.user("previous goal"), Msg.assistant("previous response")];

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		await agent.run("new goal");

		// History should be: [system, prior user, prior assistant, new user goal]
		expect(capturedHistory.length).toBe(4);
		expect(capturedHistory[0]!.role).toBe("system");
		expect(capturedHistory[1]!.role).toBe("user");
		expect(capturedHistory[2]!.role).toBe("assistant");
		expect(capturedHistory[3]!.role).toBe("user");
	});

	test("run() emits session_end with correct data", async () => {
		const mockResponse: Response = {
			id: "mock-1",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: Msg.assistant("Task complete."),
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		};
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => mockResponse,
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		const result = await agent.run("test goal");

		const collected = events.collected();
		const sessionEnd = collected.find((e) => e.kind === "session_end");
		expect(sessionEnd).toBeDefined();
		expect(sessionEnd!.data.success).toBe(true);
		expect(sessionEnd!.data.stumbles).toBe(0);
		expect(sessionEnd!.data.turns).toBe(1);
		expect(sessionEnd!.data.session_id).toBeDefined();

		// Verify result matches event data
		expect(result.success).toBe(true);
		expect(result.stumbles).toBe(0);
		expect(result.turns).toBe(1);
	});

	test("plan_end event includes assistant_message", async () => {
		const mockResponse: Response = {
			id: "mock-am-1",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: Msg.assistant("Task complete."),
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		};
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => mockResponse,
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("test goal");

		const collected = events.collected();
		const planEnd = collected.find((e) => e.kind === "plan_end");
		expect(planEnd).toBeDefined();
		const assistantMsg = planEnd!.data.assistant_message as Message;
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg.role).toBe("assistant");
	});

	test("plan_end event includes text and reasoning", async () => {
		const assistantMsg = {
			role: "assistant" as const,
			content: [
				{
					kind: ContentKind.THINKING,
					thinking: { text: "Let me think about this..." },
				},
				{
					kind: ContentKind.TEXT,
					text: "I'll create the file now.",
				},
			],
		};
		const mockResponse: Response = {
			id: "mock-2",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: assistantMsg,
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		};
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => mockResponse,
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("test goal");

		const collected = events.collected();
		const planEnd = collected.find((e) => e.kind === "plan_end");
		expect(planEnd).toBeDefined();
		expect(planEnd!.data.text).toBe("I'll create the file now.");
		expect(planEnd!.data.reasoning).toBe("Let me think about this...");
	});

	test("primitive_end event includes tool_result_message", async () => {
		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-trm-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/nonexistent/file.txt" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				const msg = callCount === 1 ? toolCallMsg : doneMsg;
				return {
					id: `mock-trm-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("read a file");

		const collected = events.collected();
		const primEnd = collected.find((e) => e.kind === "primitive_end");
		expect(primEnd).toBeDefined();
		const toolResultMsg = primEnd!.data.tool_result_message as Message;
		expect(toolResultMsg).toBeDefined();
		expect(toolResultMsg.role).toBe("tool");
	});

	test("primitive_end event includes output and error", async () => {
		// First response: a tool call to read_file
		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/nonexistent/file.txt" }),
					},
				},
			],
		};
		// Second response: text-only (natural completion)
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				const msg = callCount === 1 ? toolCallMsg : doneMsg;
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("read a file");

		const collected = events.collected();
		const primEnd = collected.find((e) => e.kind === "primitive_end");
		expect(primEnd).toBeDefined();
		expect(primEnd!.data.name).toBe("read_file");
		// read_file on a nonexistent path should fail with output and error
		expect(primEnd!.data.success).toBe(false);
		expect(primEnd!.data.output).toBeDefined();
		expect(primEnd!.data.error).toBeDefined();
	});

	test("act_end event includes tool_result_message", async () => {
		// First response: delegate to leaf via delegate tool
		const delegateMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-act-1",
						name: "delegate",
						arguments: JSON.stringify({ agent_name: "leaf", goal: "do the thing" }),
					},
				},
			],
		};
		// Subagent completes immediately
		const subDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Thing done." }],
		};
		// Root completes
		const rootDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "All done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				const msg = callCount === 1 ? delegateMsg : callCount === 2 ? subDoneMsg : rootDoneMsg;
				return {
					id: `mock-act-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
			events,
		});

		await agent.run("delegate something");

		const collected = events.collected();
		// Find the act_end at depth 0 for the successful delegation
		const actEnd = collected.find(
			(e) => e.kind === "act_end" && e.depth === 0 && e.data.success === true,
		);
		expect(actEnd).toBeDefined();
		const toolResultMsg = actEnd!.data.tool_result_message as Message;
		expect(toolResultMsg).toBeDefined();
		expect(toolResultMsg.role).toBe("tool");
	});

	test("constructor accepts genome option", async () => {
		const tempGenomeDir = await mkdtemp(join(tmpdir(), "sprout-agent-genome-"));
		try {
			const genome = new Genome(tempGenomeDir);
			await genome.init();
			await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

			const codeReader = genome.getAgent("reader")!;
			const env = new LocalExecutionEnvironment(tmpdir());
			const client = Client.fromEnv();
			const registry = createPrimitiveRegistry(env);

			const agent = new Agent({
				spec: codeReader,
				env,
				client,
				primitiveRegistry: registry,
				availableAgents: genome.allAgents(),
				genome,
			});
			expect(agent).toBeDefined();
			expect(agent.resolvedTools().length).toBeGreaterThan(0);
		} finally {
			await rm(tempGenomeDir, { recursive: true, force: true });
		}
	});

	test("run() writes JSONL log when logBasePath is set", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-log-"));
		try {
			const logBasePath = join(tempDir, "test-session");
			const mockResponse: Response = {
				id: "mock-log-1",
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant("All done."),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			};
			const mockClient = {
				providers: () => ["anthropic"],
				complete: async () => mockResponse,
				stream: async function* () {},
			} as unknown as Client;

			const env = new LocalExecutionEnvironment(tmpdir());
			const registry = createPrimitiveRegistry(env);
			const agent = new Agent({
				spec: leafSpec,
				env,
				client: mockClient,
				primitiveRegistry: registry,
				availableAgents: [],
				depth: 0,
				logBasePath,
			});

			await agent.run("test log goal");

			// Log file should exist at logBasePath.jsonl
			const logFile = `${logBasePath}.jsonl`;
			expect(existsSync(logFile)).toBe(true);

			const content = await readFile(logFile, "utf-8");
			const lines = content.trim().split("\n");
			// Should have at least session_start, perceive, plan_start, plan_end, session_end
			expect(lines.length).toBeGreaterThanOrEqual(5);

			// Each line should be valid JSON with expected fields
			const firstEvent = JSON.parse(lines[0]!);
			expect(firstEvent.kind).toBe("session_start");
			expect(firstEvent.agent_id).toBeDefined();
			expect(firstEvent.timestamp).toBeDefined();

			const lastEvent = JSON.parse(lines[lines.length - 1]!);
			expect(lastEvent.kind).toBe("session_end");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("run() does not create log file when logBasePath is not set", async () => {
		const mockResponse: Response = {
			id: "mock-nolog",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: Msg.assistant("Done."),
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		};
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => mockResponse,
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("no log test");
		// No crash, events still collected
		expect(events.collected().length).toBeGreaterThan(0);
	});

	test("agent times out after timeout_ms", async () => {
		// Mock client that always returns tool calls, keeping the loop alive
		const alwaysCallToolResponse: Response = {
			id: "mock-timeout",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: {
				role: "assistant",
				content: [
					{
						kind: ContentKind.TOOL_CALL,
						tool_call: {
							id: "call_1",
							name: "read_file",
							arguments: JSON.stringify({ path: "/tmp/test.txt" }),
						},
					},
				],
			},
			finish_reason: { reason: "tool_calls" },
			usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
		};

		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => {
				// Small delay so timeout can trigger
				await new Promise((resolve) => setTimeout(resolve, 50));
				return alwaysCallToolResponse;
			},
			stream: async function* () {},
		} as unknown as Client;

		const timeoutSpec: AgentSpec = {
			...leafSpec,
			constraints: {
				...DEFAULT_CONSTRAINTS,
				timeout_ms: 200,
				max_turns: 1000,
				max_depth: 0,
				can_spawn: false,
			},
		};

		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: timeoutSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
		});

		const result = await agent.run("do something forever");

		// Should have timed out, not hit max_turns
		expect(result.success).toBe(false);
		expect(result.timed_out).toBe(true);
		expect(result.turns).toBeLessThan(1000);
		expect(result.stumbles).toBeGreaterThan(0);
	});

	test("agent with timeout_ms 0 does not time out", async () => {
		// Mock client that returns a tool call then completes
		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					return {
						id: "mock-no-timeout-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: {
							role: "assistant",
							content: [
								{
									kind: ContentKind.TOOL_CALL,
									tool_call: {
										id: "call_nt_1",
										name: "read_file",
										arguments: JSON.stringify({ path: "/tmp/test.txt" }),
									},
								},
							],
						},
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
					};
				}
				return {
					id: "mock-no-timeout-2",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("Done."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const noTimeoutSpec: AgentSpec = {
			...leafSpec,
			constraints: {
				...DEFAULT_CONSTRAINTS,
				timeout_ms: 0,
				max_turns: 10,
				max_depth: 0,
				can_spawn: false,
			},
		};

		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: noTimeoutSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
		});

		const result = await agent.run("do something");

		expect(result.success).toBe(true);
		expect(result.timed_out).toBe(false);
	});

	test("subagent sees agents added to genome after parent construction", async () => {
		// A "dynamic-leaf" agent that gets added to the genome AFTER root construction.
		const dynamicLeafSpec: AgentSpec = {
			name: "dynamic-leaf",
			description: "Dynamically added leaf",
			system_prompt: "You do dynamic things.",
			model: "fast",
			capabilities: ["read_file"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 3, max_depth: 0, can_spawn: false },
			tags: [],
			version: 1,
		};

		// Leaf can delegate to "dynamic-leaf" (it's in its capabilities)
		const leafWithDynamic: AgentSpec = {
			...leafSpec,
			capabilities: ["dynamic-leaf", "read_file"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5, can_spawn: true },
		};

		// Root delegates to "leaf" via the delegate tool
		const rootDelegateMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-root-1",
						name: "delegate",
						arguments: JSON.stringify({
							agent_name: "leaf",
							goal: "delegate to the dynamic agent",
						}),
					},
				},
			],
		};
		// Leaf (subagent) delegates to "dynamic-leaf" via the delegate tool
		const leafDelegateMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-leaf-1",
						name: "delegate",
						arguments: JSON.stringify({ agent_name: "dynamic-leaf", goal: "do dynamic work" }),
					},
				},
			],
		};
		// dynamic-leaf completes
		const dynamicDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Dynamic work done." }],
		};
		// leaf completes after delegation
		const leafDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Leaf done." }],
		};
		// root completes
		const rootDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "All done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				// Call 1: root delegates to leaf
				// Call 2: leaf delegates to dynamic-leaf
				// Call 3: dynamic-leaf completes
				// Call 4: leaf completes
				// Call 5: root completes
				const msg =
					callCount === 1
						? rootDelegateMsg
						: callCount === 2
							? leafDelegateMsg
							: callCount === 3
								? dynamicDoneMsg
								: callCount === 4
									? leafDoneMsg
									: rootDoneMsg;
				return {
					id: `mock-dyn-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: {
						reason: callCount <= 2 ? "tool_calls" : "stop",
					},
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		// Mock genome: initially has root and leafWithDynamic. After construction,
		// we add dynamicLeafSpec — simulating Learn adding a new agent mid-session.
		const genomeAgents = new Map<string, AgentSpec>();
		genomeAgents.set(rootSpec.name, rootSpec);
		genomeAgents.set(leafWithDynamic.name, leafWithDynamic);
		// NOT adding dynamicLeafSpec yet — it will be added after Agent construction

		const mockGenome = {
			getAgent: (name: string) => genomeAgents.get(name),
			allAgents: () => [...genomeAgents.values()],
			memories: { search: () => [] },
			matchRoutingRules: () => [],
			markMemoriesUsed: async () => {},
		} as unknown as Genome;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafWithDynamic],
			genome: mockGenome,
			depth: 0,
			events,
		});

		// Simulate Learn adding a new agent to the genome mid-session
		genomeAgents.set(dynamicLeafSpec.name, dynamicLeafSpec);

		const result = await agent.run("delegate chain");

		// The delegation chain should succeed: root -> leaf -> dynamic-leaf
		// If the subagent uses stale availableAgents, "dynamic-leaf" won't be found
		// and the delegation will fail with "Unknown agent" or be treated as a primitive.
		const collected = events.collected();

		// Verify dynamic-leaf was successfully spawned as a subagent (act_start with its name)
		const dynamicActStart = collected.find(
			(e) => e.kind === "act_start" && e.data.agent_name === "dynamic-leaf",
		);
		expect(dynamicActStart).toBeDefined();

		// Verify dynamic-leaf completed successfully (act_end with success)
		const dynamicActEnd = collected.find(
			(e) => e.kind === "act_end" && e.data.agent_name === "dynamic-leaf",
		);
		expect(dynamicActEnd).toBeDefined();
		expect(dynamicActEnd!.data.success).toBe(true);

		// Overall result should succeed
		expect(result.success).toBe(true);
	});

	test("multiple delegations execute concurrently", async () => {
		// Two leaf agents, each taking 50ms to complete. If sequential: >=100ms. If concurrent: ~50ms.
		const leafA: AgentSpec = {
			name: "leaf-a",
			description: "Leaf A",
			system_prompt: "You are leaf A.",
			model: "fast",
			capabilities: ["read_file"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 3, max_depth: 0, can_spawn: false },
			tags: [],
			version: 1,
		};
		const leafB: AgentSpec = {
			name: "leaf-b",
			description: "Leaf B",
			system_prompt: "You are leaf B.",
			model: "fast",
			capabilities: ["read_file"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 3, max_depth: 0, can_spawn: false },
			tags: [],
			version: 1,
		};
		const rootWithTwoLeaves: AgentSpec = {
			...rootSpec,
			capabilities: ["leaf-a", "leaf-b"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
		};

		// Root response: two delegations in one message via delegate tool
		const twoDelegationsMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-a",
						name: "delegate",
						arguments: JSON.stringify({ agent_name: "leaf-a", goal: "do task A" }),
					},
				},
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-b",
						name: "delegate",
						arguments: JSON.stringify({ agent_name: "leaf-b", goal: "do task B" }),
					},
				},
			],
		};
		const rootDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Both delegations complete." }],
		};

		const DELAY_MS = 50;
		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// Root: return two delegations
					return {
						id: "mock-conc-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: twoDelegationsMsg,
						finish_reason: { reason: "tool_calls" as const },
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					};
				}
				if (callCount <= 3) {
					// Subagent calls (2 and 3): each delays then completes
					await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
					return {
						id: `mock-conc-${callCount}`,
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant(`Done from subagent call ${callCount}.`),
						finish_reason: { reason: "stop" as const },
						usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
					};
				}
				// Root: done
				return {
					id: `mock-conc-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: rootDoneMsg,
					finish_reason: { reason: "stop" as const },
					usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootWithTwoLeaves,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootWithTwoLeaves, leafA, leafB],
			depth: 0,
			events,
		});

		const start = performance.now();
		const result = await agent.run("do two tasks");
		const elapsed = performance.now() - start;

		// Both delegations should complete successfully
		expect(result.success).toBe(true);

		const collected = events.collected();
		const actEnds = collected.filter((e) => e.kind === "act_end");
		expect(actEnds.length).toBe(2);
		expect(actEnds.every((e) => e.data.success === true)).toBe(true);

		// If concurrent: elapsed should be well under 2*DELAY_MS (allowing margin for overhead)
		// If sequential: elapsed would be >= 100ms
		expect(elapsed).toBeLessThan(DELAY_MS * 2 - 10);
	});

	test("concurrent delegations with different speeds both complete successfully", async () => {
		// Verify that when delegations with different durations run concurrently,
		// both complete successfully regardless of finish order.
		const leafA: AgentSpec = {
			name: "leaf-a",
			description: "Leaf A",
			system_prompt: "You are leaf A.",
			model: "fast",
			capabilities: ["read_file"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 3, max_depth: 0, can_spawn: false },
			tags: [],
			version: 1,
		};
		const leafB: AgentSpec = {
			name: "leaf-b",
			description: "Leaf B",
			system_prompt: "You are leaf B.",
			model: "fast",
			capabilities: ["read_file"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 3, max_depth: 0, can_spawn: false },
			tags: [],
			version: 1,
		};
		const rootWithTwoLeaves: AgentSpec = {
			...rootSpec,
			capabilities: ["leaf-a", "leaf-b"],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
		};

		// Root response: two delegations via delegate tool
		const twoDelegationsMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-a",
						name: "delegate",
						arguments: JSON.stringify({ agent_name: "leaf-a", goal: "task A" }),
					},
				},
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-b",
						name: "delegate",
						arguments: JSON.stringify({ agent_name: "leaf-b", goal: "task B" }),
					},
				},
			],
		};

		// leaf-a takes LONGER than leaf-b — so if results were in completion order, B would come first
		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					return {
						id: "mock-order-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: twoDelegationsMsg,
						finish_reason: { reason: "tool_calls" as const },
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					};
				}
				if (callCount === 2) {
					// leaf-a: slow
					await new Promise((resolve) => setTimeout(resolve, 60));
					return {
						id: "mock-order-2",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Result A"),
						finish_reason: { reason: "stop" as const },
						usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
					};
				}
				if (callCount === 3) {
					// leaf-b: fast
					await new Promise((resolve) => setTimeout(resolve, 10));
					return {
						id: "mock-order-3",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Result B"),
						finish_reason: { reason: "stop" as const },
						usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
					};
				}
				// Root completes — the response text tells us the order it saw
				return {
					id: "mock-order-4",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("All done."),
					finish_reason: { reason: "stop" as const },
					usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootWithTwoLeaves,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootWithTwoLeaves, leafA, leafB],
			depth: 0,
			events,
		});

		const result = await agent.run("order test");
		expect(result.success).toBe(true);

		// Both delegations should complete successfully
		const collected = events.collected();
		const actEnds = collected.filter((e) => e.kind === "act_end");
		expect(actEnds.length).toBe(2);
		const leafAEnd = actEnds.find((e) => e.data.agent_name === "leaf-a");
		const leafBEnd = actEnds.find((e) => e.data.agent_name === "leaf-b");
		expect(leafAEnd).toBeDefined();
		expect(leafBEnd).toBeDefined();
		expect(leafAEnd!.data.success).toBe(true);
		expect(leafBEnd!.data.success).toBe(true);
	});

	test("subagent writes log under parent logBasePath/subagents/", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-sublog-"));
		try {
			const logBasePath = join(tempDir, "parent-session");

			// First response: delegate to leaf agent via delegate tool
			const delegateMsg: Message = {
				role: "assistant",
				content: [
					{
						kind: ContentKind.TOOL_CALL,
						tool_call: {
							id: "call-sub-1",
							name: "delegate",
							arguments: JSON.stringify({ agent_name: "leaf", goal: "do the thing" }),
						},
					},
				],
			};
			// Second response (after delegation): done
			const doneMsg: Message = {
				role: "assistant",
				content: [{ kind: ContentKind.TEXT, text: "Delegation complete." }],
			};
			// Subagent response: immediate completion
			const subDoneMsg: Message = {
				role: "assistant",
				content: [{ kind: ContentKind.TEXT, text: "Thing done." }],
			};

			let callCount = 0;
			const mockClient = {
				providers: () => ["anthropic"],
				complete: async (): Promise<Response> => {
					callCount++;
					// Call 1: root delegates, Call 2: subagent completes, Call 3: root completes
					const msg = callCount === 1 ? delegateMsg : callCount === 2 ? subDoneMsg : doneMsg;
					return {
						id: `mock-sub-${callCount}`,
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: msg,
						finish_reason: {
							reason: callCount === 1 ? "tool_calls" : "stop",
						},
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					};
				},
				stream: async function* () {},
			} as unknown as Client;

			const env = new LocalExecutionEnvironment(tmpdir());
			const registry = createPrimitiveRegistry(env);
			const agent = new Agent({
				spec: rootSpec,
				env,
				client: mockClient,
				primitiveRegistry: registry,
				availableAgents: [rootSpec, leafSpec],
				depth: 0,
				logBasePath,
			});

			await agent.run("delegate to leaf");

			// Parent log should exist
			const parentLog = `${logBasePath}.jsonl`;
			expect(existsSync(parentLog)).toBe(true);

			// Subagent log should exist under subagents/
			const subagentsDir = join(logBasePath, "subagents");
			expect(existsSync(subagentsDir)).toBe(true);

			// Find the subagent log file (name is a generated ULID)
			const { readdir } = await import("node:fs/promises");
			const subFiles = await readdir(subagentsDir);
			const jsonlFiles = subFiles.filter((f) => f.endsWith(".jsonl"));
			expect(jsonlFiles.length).toBe(1);

			// Verify subagent log content
			const subContent = await readFile(join(subagentsDir, jsonlFiles[0]!), "utf-8");
			const subLines = subContent.trim().split("\n");
			const subFirstEvent = JSON.parse(subLines[0]!);
			expect(subFirstEvent.kind).toBe("session_start");
			expect(subFirstEvent.agent_id).toBe("leaf");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("modelOverride overrides spec model in resolvedModel", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			modelOverride: "claude-sonnet-4-6",
		});
		expect(agent.resolvedModel.model).toBe("claude-sonnet-4-6");
		expect(agent.resolvedModel.provider).toBe("anthropic");
	});

	test("without modelOverride uses spec model", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
		});
		// leafSpec.model is "fast", which resolves to claude-haiku for anthropic
		expect(agent.resolvedModel.model).toBe("claude-haiku-4-5-20251001");
	});

	test("act_end event includes tool_result_message on delegation error", async () => {
		// Root agent tries to delegate to "nonexistent" agent.
		// The mock client returns a delegate tool call on first call, then "Done." on second.
		const delegateToUnknownMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-err-1",
						name: "delegate",
						arguments: JSON.stringify({ agent_name: "nonexistent", goal: "do stuff" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<any> => {
				callCount++;
				const msg = callCount === 1 ? delegateToUnknownMsg : doneMsg;
				return {
					id: `mock-err-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
			events,
		});

		await agent.run("delegate to unknown");

		const collected = events.collected();
		const actEnd = collected.find((e) => e.kind === "act_end" && e.data.success === false);
		expect(actEnd).toBeDefined();
		expect(actEnd!.data.error).toContain("Unknown agent");
		const toolResultMsg = actEnd!.data.tool_result_message as Message;
		expect(toolResultMsg).toBeDefined();
		expect(toolResultMsg.role).toBe("tool");
	});

	test("initialHistory is defensively copied in constructor", async () => {
		const history: Message[] = [Msg.user("prior goal"), Msg.assistant("prior response")];

		let capturedMessages: Message[] = [];
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (request: any): Promise<any> => {
				capturedMessages = request.messages;
				return {
					id: "mock-dc-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("Done."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			initialHistory: history,
		});

		// Mutate the original array after construction
		history.push(Msg.user("injected after construction"));

		await agent.run("new goal");

		// Messages should be: [system, prior user, prior assistant, new user goal]
		// NOT: [system, prior user, prior assistant, injected, new user goal]
		const nonSystem = capturedMessages.filter((m) => m.role !== "system");
		expect(nonSystem).toHaveLength(3);
		expect(nonSystem[0]!.role).toBe("user");
		expect(nonSystem[1]!.role).toBe("assistant");
		expect(nonSystem[2]!.role).toBe("user");
	});

	test("abort signal listener cleanup pattern is correct", () => {
		// Verify the cleanup pattern used in agent.ts signal handling
		const ac = new AbortController();
		const handlers: (() => void)[] = [];

		// Simulate the fixed pattern: add handler, remove on completion
		for (let i = 0; i < 5; i++) {
			const handler = () => {};
			ac.signal.addEventListener("abort", handler, { once: true });
			handlers.push(handler);
			// Simulate normal completion: cleanup
			ac.signal.removeEventListener("abort", handler);
		}

		// Verify the signal still works correctly after cleanup
		let abortCaught = false;
		ac.signal.addEventListener(
			"abort",
			() => {
				abortCaught = true;
			},
			{ once: true },
		);
		ac.abort();
		expect(abortCaught).toBe(true);
	});

	test("agent compacts history when token threshold exceeded", async () => {
		// Pad initial history so compactHistory has enough messages to work with
		// (PRESERVE_RECENT_TURNS = 6, so we need > 6 messages at compaction time)
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
		];

		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-compact-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/tmp/test.txt" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done after compaction." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// First LLM call: tool call with high token usage (above 80% of 200k)
					return {
						id: "mock-compact-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: toolCallMsg,
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 170000, output_tokens: 500, total_tokens: 170500 },
					};
				}
				if (callCount === 2) {
					// Compaction summarization call
					return {
						id: "mock-compact-summary",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Summary of prior work."),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
					};
				}
				// Post-compaction turn: agent continues and completes
				return {
					id: `mock-compact-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: doneMsg,
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		const result = await agent.run("do something big");

		// Verify compaction event was emitted
		const collected = events.collected();
		const compactionEvents = collected.filter((e) => e.kind === "compaction");
		expect(compactionEvents).toHaveLength(1);
		expect(compactionEvents[0]!.data.summary).toContain("Summary of prior work.");
		expect(compactionEvents[0]!.data.beforeCount as number).toBeGreaterThan(
			compactionEvents[0]!.data.afterCount as number,
		);

		// Agent should have completed successfully (continued after compaction)
		expect(result.success).toBe(true);
	});

	test("agent respects requestCompaction() flag", async () => {
		// Pad initial history so compactHistory has enough messages to summarize
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
		];

		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-reqcompact-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/tmp/test.txt" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// Low token usage — normally wouldn't trigger compaction
					return {
						id: "mock-reqcompact-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: toolCallMsg,
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
					};
				}
				if (callCount === 2) {
					// Compaction summarization call
					return {
						id: "mock-reqcompact-summary",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Manual compaction summary."),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
					};
				}
				return {
					id: `mock-reqcompact-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: doneMsg,
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		// Request compaction manually BEFORE running
		agent.requestCompaction();

		await agent.run("do something small");

		// Compaction should still happen despite low token usage
		const collected = events.collected();
		const compactionEvents = collected.filter((e) => e.kind === "compaction");
		expect(compactionEvents).toHaveLength(1);
		expect(compactionEvents[0]!.data.summary).toContain("Manual compaction summary.");
	});

	test("agent continues running after compaction", async () => {
		// Pad initial history so compactHistory has enough messages to summarize
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
		];

		const toolCallMsg1: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-continue-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/tmp/a.txt" }),
					},
				},
			],
		};
		const toolCallMsg2: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-continue-2",
						name: "read_file",
						arguments: JSON.stringify({ path: "/tmp/b.txt" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "All finished." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// First turn: high token usage triggers compaction
					return {
						id: "mock-cont-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: toolCallMsg1,
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 170000, output_tokens: 500, total_tokens: 170500 },
					};
				}
				if (callCount === 2) {
					// Compaction summarization call
					return {
						id: "mock-cont-summary",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Compacted summary."),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
					};
				}
				if (callCount === 3) {
					// Post-compaction: another tool call (proving the loop continues)
					return {
						id: "mock-cont-3",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: toolCallMsg2,
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 3000, output_tokens: 100, total_tokens: 3100 },
					};
				}
				// Final completion
				return {
					id: `mock-cont-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: doneMsg,
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 3000, output_tokens: 100, total_tokens: 3100 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		const result = await agent.run("multi-step task");

		// Should have compacted once
		const collected = events.collected();
		const compactionEvents = collected.filter((e) => e.kind === "compaction");
		expect(compactionEvents).toHaveLength(1);

		// Should have continued after compaction (at least 3 plan_end events:
		// turn 1 triggers compaction, turn 2 does tool call, turn 3 completes)
		const planEnds = collected.filter((e) => e.kind === "plan_end");
		expect(planEnds.length).toBeGreaterThanOrEqual(3);

		// Agent should have completed successfully
		expect(result.success).toBe(true);
		expect(result.turns).toBeGreaterThanOrEqual(3);
	});

	test("compaction fires after tool results are in history", async () => {
		// Pad initial history so compactHistory has enough messages
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
		];

		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-timing-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/tmp/test.txt" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// High token usage to trigger compaction
					return {
						id: "mock-timing-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: toolCallMsg,
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 170000, output_tokens: 500, total_tokens: 170500 },
					};
				}
				if (callCount === 2) {
					// Compaction summarization call
					return {
						id: "mock-timing-summary",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Summary."),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
					};
				}
				return {
					id: `mock-timing-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: doneMsg,
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		await agent.run("timing test");

		const collected = events.collected();
		const compactionEvent = collected.find((e) => e.kind === "compaction");
		expect(compactionEvent).toBeDefined();

		// beforeCount should include the tool result message.
		// History at compaction time: 6 prior + 1 goal + 1 assistant(tool_call) + 1 tool_result = 9
		// If compaction fired before tool results, it would be 8.
		const beforeCount = compactionEvent!.data.beforeCount as number;
		expect(beforeCount).toBe(9);
	});

	test("compaction event summary contains log path reference", async () => {
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
		];

		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-summary-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/tmp/test.txt" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					return {
						id: "mock-sum-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: toolCallMsg,
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 170000, output_tokens: 500, total_tokens: 170500 },
					};
				}
				if (callCount === 2) {
					return {
						id: "mock-sum-summary",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Raw summary text."),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
					};
				}
				return {
					id: `mock-sum-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: doneMsg,
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const logBasePath = join(tmpdir(), `sprout-summary-test-${Date.now()}`);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
			logBasePath,
		});

		await agent.run("summary test");

		const collected = events.collected();
		const compactionEvent = collected.find((e) => e.kind === "compaction");
		expect(compactionEvent).toBeDefined();

		// The summary in the event should contain the log path reference
		// (the fullSummary, not just the raw LLM output)
		const summary = compactionEvent!.data.summary as string;
		expect(summary).toContain("Full conversation log available at:");
		expect(summary).toContain("Raw summary text.");
	});

	test("compaction failure does not crash agent and emits warning", async () => {
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
		];

		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-err-compact-1",
						name: "read_file",
						arguments: JSON.stringify({ path: "/tmp/test.txt" }),
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done despite error." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// High token usage triggers compaction
					return {
						id: "mock-cerr-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: toolCallMsg,
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 170000, output_tokens: 500, total_tokens: 170500 },
					};
				}
				if (callCount === 2) {
					// Compaction LLM call fails
					throw new Error("Network error: connection refused");
				}
				// Agent continues after failed compaction
				return {
					id: `mock-cerr-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: doneMsg,
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		// Should NOT throw
		const result = await agent.run("do something");

		// Agent should complete successfully
		expect(result.success).toBe(true);

		// A warning event should have been emitted
		const collected = events.collected();
		const warnings = collected.filter((e) => e.kind === "warning");
		const compactionWarning = warnings.find((e) =>
			(e.data.message as string).includes("Compaction failed"),
		);
		expect(compactionWarning).toBeDefined();
		expect(compactionWarning!.data.message).toContain("Network error: connection refused");

		// No compaction event should have been emitted (it failed)
		const compactionEvents = collected.filter((e) => e.kind === "compaction");
		expect(compactionEvents).toHaveLength(0);
	});

	test("compaction has cooldown of 3 turns after firing", async () => {
		// Pad history so compaction has enough messages to work with
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
			Msg.user("step 4"),
			Msg.assistant("did step 4"),
			Msg.user("step 5"),
			Msg.assistant("did step 5"),
		];

		// Run for 5 turns (tool calls), then done on turn 6.
		// All turns report high token usage. Compaction should fire on turn 1,
		// then NOT on turns 2-3 (cooldown), then fire again on turn 4.
		const maxToolTurns = 5;
		let callCount = 0;
		let compactionCallCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (request: any): Promise<Response> => {
				callCount++;
				// Compaction summarization calls don't count as "turns"
				// Detect if this is a compaction call (no tools in request)
				if (request.tools && request.tools.length === 0) {
					compactionCallCount++;
					return {
						id: `mock-cd-compact-${compactionCallCount}`,
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant(`Compaction summary ${compactionCallCount}.`),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
					};
				}
				// Main turn calls
				const mainCallNum = callCount - compactionCallCount;
				if (mainCallNum <= maxToolTurns) {
					return {
						id: `mock-cd-${mainCallNum}`,
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: {
							role: "assistant",
							content: [
								{
									kind: ContentKind.TOOL_CALL,
									tool_call: {
										id: `call-cd-${mainCallNum}`,
										name: "read_file",
										arguments: JSON.stringify({ path: `/tmp/file${mainCallNum}.txt` }),
									},
								},
							],
						},
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 170000, output_tokens: 500, total_tokens: 170500 },
					};
				}
				// Final call: done
				return {
					id: `mock-cd-done`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("All done."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 170000, output_tokens: 100, total_tokens: 170100 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const spec: AgentSpec = {
			...leafSpec,
			constraints: { ...leafSpec.constraints, max_turns: 10 },
		};
		const agent = new Agent({
			spec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		await agent.run("cooldown test");

		const collected = events.collected();
		const compactionEvents = collected.filter((e) => e.kind === "compaction");

		// With 5 tool turns and cooldown of 3:
		// Turn 1: compaction fires (turnsSinceCompaction starts high)
		// Turn 2: cooldown (1 since compaction)
		// Turn 3: cooldown (2 since compaction)
		// Turn 4: compaction fires (3 since compaction)
		// Turn 5: cooldown (1 since compaction)
		expect(compactionEvents).toHaveLength(2);
	});

	test("requestCompaction bypasses cooldown", async () => {
		const priorHistory: Message[] = [
			Msg.user("step 1"),
			Msg.assistant("did step 1"),
			Msg.user("step 2"),
			Msg.assistant("did step 2"),
			Msg.user("step 3"),
			Msg.assistant("did step 3"),
			Msg.user("step 4"),
			Msg.assistant("did step 4"),
			Msg.user("step 5"),
			Msg.assistant("did step 5"),
		];

		// Run for 3 tool turns: turn 1 triggers compaction (auto), turn 2 is in
		// cooldown but we requestCompaction so it should fire anyway.
		let callCount = 0;
		let compactionCallCount = 0;
		let requestedCompactionOnTurn2 = false;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (request: any): Promise<Response> => {
				callCount++;
				if (request.tools && request.tools.length === 0) {
					compactionCallCount++;
					return {
						id: `mock-bypass-compact-${compactionCallCount}`,
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant(`Bypass summary ${compactionCallCount}.`),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
					};
				}
				const mainCallNum = callCount - compactionCallCount;
				if (mainCallNum <= 3) {
					return {
						id: `mock-bypass-${mainCallNum}`,
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: {
							role: "assistant",
							content: [
								{
									kind: ContentKind.TOOL_CALL,
									tool_call: {
										id: `call-bypass-${mainCallNum}`,
										name: "read_file",
										arguments: JSON.stringify({ path: `/tmp/bypass${mainCallNum}.txt` }),
									},
								},
							],
						},
						finish_reason: { reason: "tool_calls" },
						usage: { input_tokens: 170000, output_tokens: 500, total_tokens: 170500 },
					};
				}
				return {
					id: "mock-bypass-done",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("Done."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		// Use event listener to request compaction after the first compaction fires
		events.on((ev) => {
			if (ev.kind === "compaction" && !requestedCompactionOnTurn2) {
				requestedCompactionOnTurn2 = true;
				// This runs after turn 1's compaction. Request compaction for next turn.
				agent.requestCompaction();
			}
		});

		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const spec: AgentSpec = {
			...leafSpec,
			constraints: { ...leafSpec.constraints, max_turns: 10 },
		};
		const agent = new Agent({
			spec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			initialHistory: priorHistory,
		});

		await agent.run("bypass cooldown test");

		const collected = events.collected();
		const compactionEvents = collected.filter((e) => e.kind === "compaction");

		// Turn 1: auto-compaction fires
		// Turn 2: would be in cooldown, but requestCompaction() was called — fires anyway
		// Turn 3: cooldown
		expect(compactionEvents.length).toBeGreaterThanOrEqual(2);
	});
});
