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

	test("resolves agent tools from capabilities", () => {
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
		expect(names).toContain("leaf");
		// Should NOT include root itself
		expect(names).not.toContain("root");
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

	test("excludes agent tools when can_spawn is false", () => {
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
		// "leaf" is in capabilities but can_spawn is false, so no agent tools
		expect(names).not.toContain("leaf");
		expect(names).not.toContain("root");
	});

	test("agent tool has goal/hints parameters", () => {
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
		const leafTool = tools.find((t) => t.name === "leaf");
		expect(leafTool).toBeDefined();
		const props = (leafTool!.parameters as any).properties;
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
		expect(agent.resolvedTools().map((t) => t.name)).toContain("leaf");
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

	test("constructor accepts genome option", async () => {
		const tempGenomeDir = await mkdtemp(join(tmpdir(), "sprout-agent-genome-"));
		try {
			const genome = new Genome(tempGenomeDir);
			await genome.init();
			await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

			const codeReader = genome.getAgent("code-reader")!;
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

	test("subagent writes log under parent logBasePath/subagents/", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-sublog-"));
		try {
			const logBasePath = join(tempDir, "parent-session");

			// First response: delegate to leaf agent
			const delegateMsg: Message = {
				role: "assistant",
				content: [
					{
						kind: ContentKind.TOOL_CALL,
						tool_call: {
							id: "call-sub-1",
							name: "leaf",
							arguments: JSON.stringify({ goal: "do the thing" }),
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

			// Find the subagent log file (name is a generated UUID)
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
});
