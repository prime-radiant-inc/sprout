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
		capabilities: overrides.capabilities ?? [
			"read_file",
			"write_file",
			"exec",
			"save_tool",
			"save_file",
		],
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

	test("agent gets save_tool and save_file primitives when genome is available", async () => {
		const root = join(tempDir, "ws-prims");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "editor" }));

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
			genome,
			events,
		});

		await agent.run("test goal");

		// After run, the registry should have save_tool and save_file
		expect(registry.names()).toContain("save_tool");
		expect(registry.names()).toContain("save_file");
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

		// System prompt should contain workspace sections
		expect(capturedSystemPrompt).toContain("<agent_tools>");
		expect(capturedSystemPrompt).toContain("lint");
		expect(capturedSystemPrompt).toContain("Run linter");
		expect(capturedSystemPrompt).toContain("</agent_tools>");

		expect(capturedSystemPrompt).toContain("<agent_files>");
		expect(capturedSystemPrompt).toContain("style-guide.md");
		expect(capturedSystemPrompt).toContain("</agent_files>");

		expect(capturedSystemPrompt).toContain("save_tool");
		expect(capturedSystemPrompt).toContain("persist");
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
