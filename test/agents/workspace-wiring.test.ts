import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Message } from "../../src/llm/types.ts";
import { ContentKind, Msg } from "../../src/llm/types.ts";

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: overrides.name ?? "test-agent",
		description: overrides.description ?? "A test agent",
		system_prompt: overrides.system_prompt ?? "You are a test agent.",
		model: overrides.model ?? "fast",
		tools: overrides.tools ?? ["read_file", "write_file", "exec", "save_tool", "save_file"],
		agents: overrides.agents ?? [],
		constraints: overrides.constraints ?? {
			...DEFAULT_CONSTRAINTS,
			max_turns: 3,
			can_spawn: true,
		},
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };

describe("workspace wiring", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-ws-wiring-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("agent gets workspace tools loaded at startup", async () => {
		const root = join(tempDir, "ws-loaded");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "editor" }));

		// Save a tool to the workspace before creating the agent
		await genome.saveAgentTool("editor", {
			name: "format",
			description: "Format code",
			script: '#!/bin/bash\necho "formatted"',
			interpreter: "bash",
		});

		const env = new LocalExecutionEnvironment(tempDir);
		const registry = createPrimitiveRegistry(env);

		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-1",
						name: "format",
						arguments: {},
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "done" }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => {
				callCount++;
				return {
					message: callCount === 1 ? toolCallMsg : doneMsg,
					finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
					usage: USAGE,
				};
			},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: makeSpec({ name: "editor" }),
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [makeSpec({ name: "editor" })],
			genome,
			events,
		});

		await agent.run("format the code");

		// Verify the workspace tool was executed
		const collected = events.collected();
		const primEnd = collected.find((e) => e.kind === "primitive_end" && e.data.name === "format");
		expect(primEnd).toBeDefined();
		expect(primEnd!.data.success).toBe(true);
		expect(primEnd!.data.output as string).toContain("formatted");
	});

	test("system prompt includes workspace tools and files", async () => {
		const root = join(tempDir, "ws-prompt");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "editor" }));

		await genome.saveAgentTool("editor", {
			name: "lint",
			description: "Run linter",
			script: "#!/bin/bash\neslint .",
			interpreter: "bash",
		});
		await genome.saveAgentFile("editor", {
			name: "style-guide.md",
			content: "# Style\nUse tabs.",
		});

		const env = new LocalExecutionEnvironment(tempDir);
		const registry = createPrimitiveRegistry(env);

		// Capture the system prompt from the LLM request
		let capturedSystemPrompt = "";
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (req: { messages: { role: string; content: { text?: string }[] }[] }) => {
				const sysMsg = req.messages.find((m: { role: string }) => m.role === "system");
				if (sysMsg) {
					capturedSystemPrompt = sysMsg.content
						.map((c: { text?: string }) => c.text ?? "")
						.join("");
				}
				return {
					message: Msg.assistant("done"),
					finish_reason: { reason: "stop" },
					usage: USAGE,
				};
			},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: makeSpec({ name: "editor" }),
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [makeSpec({ name: "editor" })],
			genome,
			events,
		});

		await agent.run("test goal");

		// System prompt should list workspace tools
		expect(capturedSystemPrompt).toContain("<agent_tools>");
		expect(capturedSystemPrompt).toContain("lint");
		expect(capturedSystemPrompt).toContain("Run linter");
		expect(capturedSystemPrompt).toContain("</agent_tools>");
	});

	test("agent with tools: [] gets only workspace tools (no built-in primitives)", async () => {
		const root = join(tempDir, "ws-only-tools");
		const genome = new Genome(root);
		await genome.init();
		// Agent with tools: [] — no built-in primitives
		await genome.addAgent(makeSpec({ name: "task-mgr", tools: [] }));

		// Save a workspace tool
		await genome.saveAgentTool("task-mgr", {
			name: "task-cli",
			description: "Manage tasks",
			script: "#!/bin/bash\necho '{\"ok\":true}'",
			interpreter: "bash",
		});

		const env = new LocalExecutionEnvironment(tempDir);
		const registry = createPrimitiveRegistry(env);

		const toolCallMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-1",
						name: "task-cli",
						arguments: {},
					},
				},
			],
		};
		const doneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "done" }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => {
				callCount++;
				return {
					message: callCount === 1 ? toolCallMsg : doneMsg,
					finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
					usage: USAGE,
				};
			},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: makeSpec({ name: "task-mgr", tools: [] }),
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			genome,
			events,
		});

		await agent.run("create a task");

		// Workspace tool should be the only tool, and it should work
		const collected = events.collected();
		const primEnd = collected.find((e) => e.kind === "primitive_end" && e.data.name === "task-cli");
		expect(primEnd).toBeDefined();
		expect(primEnd!.data.success).toBe(true);

		// Built-in primitives like exec and read_file should NOT be available
		const tools = agent.resolvedTools();
		const toolNames = tools.map((t) => t.name);
		expect(toolNames).toContain("task-cli");
		expect(toolNames).not.toContain("exec");
		expect(toolNames).not.toContain("read_file");
	});

	test("run() throws when agent has genome but zero tools after workspace loading", async () => {
		const root = join(tempDir, "ws-zero-tools");
		const genome = new Genome(root);
		await genome.init();
		// Agent with tools: [] and no workspace tools saved
		await genome.addAgent(makeSpec({ name: "empty-agent", tools: [] }));

		const env = new LocalExecutionEnvironment(tempDir);
		const registry = createPrimitiveRegistry(env);

		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => ({
				message: Msg.assistant("done"),
				finish_reason: { reason: "stop" },
				usage: USAGE,
			}),
		} as unknown as Client;

		const agent = new Agent({
			spec: makeSpec({ name: "empty-agent", tools: [] }),
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			genome,
		});

		// Constructor doesn't throw (genome exists, workspace tools might load)
		// But run() throws after discovering no workspace tools either
		await expect(agent.run("do something")).rejects.toThrow(/zero tools after full resolution/);
	});

	test("agent without genome does not get workspace primitives", async () => {
		const env = new LocalExecutionEnvironment(tempDir);
		const registry = createPrimitiveRegistry(env);

		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => ({
				message: Msg.assistant("done"),
				finish_reason: { reason: "stop" },
				usage: USAGE,
			}),
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: makeSpec({ name: "editor" }),
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [makeSpec({ name: "editor" })],
			events,
		});

		await agent.run("test goal");

		// No genome, so no workspace primitives
		expect(registry.names()).not.toContain("save_tool");
		expect(registry.names()).not.toContain("save_file");
	});
});
