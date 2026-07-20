import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentOptions, Agent as RawAgent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import type { AgentSpawner } from "../../src/bus/spawner.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { CellRunner } from "../../src/kernel/cell-primitive.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Message } from "../../src/llm/types.ts";
import { ContentKind } from "../../src/llm/types.ts";
import { withDefaultResolverContext } from "./fixtures.ts";
import "../helpers/test-env.ts";

class Agent extends RawAgent {
	constructor(options: AgentOptions) {
		super(withDefaultResolverContext(options));
	}
}

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };

function toolCallMsg(name: string, args: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		content: [{ kind: ContentKind.TOOL_CALL, tool_call: { id: "call-1", name, arguments: args } }],
	};
}

/** Client that emits one scripted tool call, then stops. */
function oneCallClient(msg: Message): Client {
	let callCount = 0;
	return {
		providers: () => ["anthropic"],
		complete: async () => {
			callCount++;
			return {
				message:
					callCount === 1
						? msg
						: ({
								role: "assistant",
								content: [{ kind: ContentKind.TEXT, text: "done" }],
							} as Message),
				finish_reason: { reason: callCount === 1 ? "tool_calls" : "stop" },
				usage: USAGE,
			};
		},
	} as unknown as Client;
}

function stubSpawner(): AgentSpawner {
	return { storeAccess: { names: async () => [] } } as unknown as AgentSpawner;
}

function stubCellHost(): CellRunner {
	return { run: async () => ({ output: "", success: true }) } as unknown as CellRunner;
}

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: "surface-agent",
		description: "A test agent",
		system_prompt: "You are a test agent.",
		model: "fast",
		tools: ["read_file"],
		agents: [],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 3, can_spawn: false },
		tags: ["test"],
		version: 1,
		...overrides,
	};
}

describe("script-tool shell-exposure tightening (Phase 7)", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-script-surface-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("a code-mode agent cannot reach a workspace script tool by name", async () => {
		const root = join(tempDir, "code-mode");
		const genome = new Genome(root);
		await genome.init();
		const spec = makeSpec({
			name: "coder",
			act: "code",
			tools: [],
			constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 3, can_spawn: true },
		});
		await genome.addAgent(spec);
		// A script tool sits in the agent's workspace (e.g. quartermaster-fabricated).
		await genome.saveAgentTool("coder", {
			name: "shellout",
			description: "Runs shell",
			script: '#!/bin/bash\necho "pwned" > pwned.txt\necho ran',
			interpreter: "bash",
		});

		const env = new LocalExecutionEnvironment(tempDir);
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec,
			env,
			client: oneCallClient(toolCallMsg("shellout")),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [spec],
			genome,
			events,
			spawner: stubSpawner(),
			cellHost: stubCellHost(),
		});
		await agent.run("do something");

		const primEnd = events
			.collected()
			.find((e) => e.kind === "primitive_end" && e.data.name === "shellout");
		expect(primEnd).toBeDefined();
		expect(primEnd!.data.success).toBe(false);
		expect(String(primEnd!.data.error)).toContain("not in this agent's granted tool surface");
		// The script must not have run.
		await expect(stat(join(tempDir, "pwned.txt"))).rejects.toThrow();
	});

	test("an agent cannot dispatch the ungranted save_tool primitive by name", async () => {
		const root = join(tempDir, "save-tool");
		const genome = new Genome(root);
		await genome.init();
		const spec = makeSpec({ name: "reader" });
		await genome.addAgent(spec);

		const env = new LocalExecutionEnvironment(tempDir);
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec,
			env,
			client: oneCallClient(
				toolCallMsg("save_tool", {
					name: "backdoor",
					description: "x",
					script: "echo shell",
					interpreter: "bash",
				}),
			),
			primitiveRegistry: createPrimitiveRegistry(env, {
				genome,
				agentName: "reader",
				sessionId: "s1",
			}),
			availableAgents: [spec],
			genome,
			events,
		});
		await agent.run("mint a tool");

		const primEnd = events
			.collected()
			.find((e) => e.kind === "primitive_end" && e.data.name === "save_tool");
		expect(primEnd).toBeDefined();
		expect(primEnd!.data.success).toBe(false);
		expect(String(primEnd!.data.error)).toContain("not in this agent's granted tool surface");
		// No tool file was minted into the workspace.
		await expect(stat(join(genome.agentDir("reader"), "tools", "backdoor"))).rejects.toThrow();
	});

	test("an agent cannot dispatch the ungranted exec primitive by name", async () => {
		const env = new LocalExecutionEnvironment(tempDir);
		const events = new AgentEventEmitter();
		const spec = makeSpec({ name: "no-exec" });
		const agent = new Agent({
			spec,
			env,
			client: oneCallClient(toolCallMsg("exec", { command: "echo pwned" })),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [spec],
			events,
		});
		await agent.run("run a command");

		const primEnd = events
			.collected()
			.find((e) => e.kind === "primitive_end" && e.data.name === "exec");
		expect(primEnd).toBeDefined();
		expect(primEnd!.data.success).toBe(false);
		expect(String(primEnd!.data.error)).toContain("not in this agent's granted tool surface");
	});

	test("a granted workspace script tool still executes (unchanged surface)", async () => {
		const root = join(tempDir, "granted");
		const genome = new Genome(root);
		await genome.init();
		const spec = makeSpec({ name: "editor" });
		await genome.addAgent(spec);
		await genome.saveAgentTool("editor", {
			name: "format",
			description: "Format code",
			script: '#!/bin/bash\necho "formatted"',
			interpreter: "bash",
		});

		const env = new LocalExecutionEnvironment(tempDir);
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec,
			env,
			client: oneCallClient(toolCallMsg("format")),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [spec],
			genome,
			events,
		});
		await agent.run("format the code");

		const primEnd = events
			.collected()
			.find((e) => e.kind === "primitive_end" && e.data.name === "format");
		expect(primEnd).toBeDefined();
		expect(primEnd!.data.success).toBe(true);
		expect(String(primEnd!.data.output)).toContain("formatted");
	});
});
