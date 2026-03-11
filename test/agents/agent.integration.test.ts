import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { loadRootAgents, scanAgentTree } from "../../src/agents/loader.ts";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { Client } from "../../src/llm/client.ts";
import { ContentKind, type Message, Msg, type Response } from "../../src/llm/types.ts";
import "../helpers/test-env.ts";
import { createVcr } from "../helpers/vcr.ts";

const VCR_FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/agent-integration");

describe("Agent Integration", () => {
	let tempDir: string;
	let env: LocalExecutionEnvironment;
	let realClient: Client | undefined;
	let registry: ReturnType<typeof createPrimitiveRegistry>;
	let rootAgents: AgentSpec[];
	let rootTree: Awaited<ReturnType<typeof scanAgentTree>>;
	let rootTreeChildren: string[];

	function vcrForTest(testName: string) {
		return createVcr({
			fixtureDir: VCR_FIXTURE_DIR,
			testName,
			substitutions: { "{{TEMP_DIR}}": tempDir },
			realClient: realClient ?? undefined,
		});
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-test-"));
		env = new LocalExecutionEnvironment(tempDir);
		registry = createPrimitiveRegistry(env);
		rootAgents = await loadRootAgents(join(import.meta.dir, "../../root"));
		rootTree = await scanAgentTree(join(import.meta.dir, "../../root"));
		rootTreeChildren = [...rootTree.keys()].filter((path) => !path.includes("/"));

		const mode = process.env.VCR_MODE;
		if (mode === "record" || mode === "off") {
			realClient = Client.fromEnv();
		}
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("leaf agent creates a file using primitives", async () => {
		const vcr = vcrForTest("leaf-agent-creates-a-file-using-primitives");
		const codeEditor = rootAgents.find((a) => a.name === "editor")!;
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: codeEditor,
			env,
			client: vcr.client,
			primitiveRegistry: registry,
			availableAgents: rootAgents,
			depth: 1,
			events,
		});

		const result = await agent.run(
			`Create a file called hello.py in ${tempDir} that prints "Hello World". Use the write_file tool with the absolute path.`,
		);

		expect(result.success).toBe(true);

		// The file should exist
		const content = await readFile(join(tempDir, "hello.py"), "utf-8");
		expect(content).toContain("Hello");
		expect(result.turns).toBeGreaterThan(0);

		// Should have emitted events
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "session_start")).toBe(true);
		expect(collected.some((e) => e.kind === "session_end")).toBe(true);

		await vcr.afterTest();
	}, 60_000);

	test("root delegates file work to a top-level specialist", async () => {
		const rootSpec = rootAgents.find((a) => a.name === "root")!;
		const events = new AgentEventEmitter();
		const delegateMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-root-1",
						name: "delegate",
						arguments: JSON.stringify({
							agent_name: "tech-lead",
							goal: "Handle the requested file change.",
						}),
					},
				},
			],
		};
		const subDoneMsg = Msg.assistant("File work completed.");
		const doneMsg = Msg.assistant("Done.");

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				const message = callCount === 1 ? delegateMsg : callCount === 2 ? subDoneMsg : doneMsg;
				return {
					id: `mock-root-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message,
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: rootAgents,
			depth: 0,
			events,
			agentTree: rootTree,
			agentTreeChildren: rootTreeChildren,
			agentTreeSelfPath: "",
		});

		const result = await agent.run(
			`Create a file called greet.py in ${tempDir} that prints "Hello from Sprout". The file must exist when you're done.`,
		);

		expect(result.success).toBe(true);
		expect(result.turns).toBeGreaterThan(0);

		const collected = events.collected();
		expect(collected.some((e) => e.kind === "act_start" && e.data.agent_name === "tech-lead")).toBe(
			true,
		);
		expect(
			collected.some(
				(e) => e.kind === "act_end" && e.data.agent_name === "tech-lead" && e.data.success === true,
			),
		).toBe(true);
		expect(
			collected.some((e) => e.kind === "act_start" && e.data.agent_name === "utility/editor"),
		).toBe(false);
		expect(
			collected.some(
				(e) => e.kind === "act_start" && e.data.agent_name === "utility/command-runner",
			),
		).toBe(false);
	}, 120_000);
});

describe("Agent with Genome Integration", () => {
	let tempDir: string;
	let genomeDir: string;
	let env: LocalExecutionEnvironment;
	let realClient: Client | undefined;
	let registry: ReturnType<typeof createPrimitiveRegistry>;
	let genome: Genome;

	function vcrForTest(testName: string) {
		return createVcr({
			fixtureDir: VCR_FIXTURE_DIR,
			testName,
			substitutions: {
				"{{GENOME_DIR}}": genomeDir,
				"{{TEMP_DIR}}": tempDir,
			},
			realClient: realClient ?? undefined,
		});
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-genome-int-"));
		genomeDir = join(tempDir, "genome");
		env = new LocalExecutionEnvironment(tempDir);
		registry = createPrimitiveRegistry(env);

		const mode = process.env.VCR_MODE;
		if (mode === "record" || mode === "off") {
			realClient = Client.fromEnv();
		}

		// Create fresh genome with bootstrap agents
		genome = new Genome(genomeDir, join(import.meta.dir, "../../root"));
		await genome.init();
		await genome.initFromRoot();
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("fresh genome with bootstrap agents completes a file creation task", async () => {
		const vcr = vcrForTest("fresh-genome-with-bootstrap-agents-completes-a-file-creation-task");
		const events = new AgentEventEmitter();
		const rootSpec = genome.getAgent("root")!;

		const agent = new Agent({
			spec: rootSpec,
			env,
			client: vcr.client,
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
		});

		const result = await agent.run(
			`Create a file called test_bootstrap.py in ${tempDir} that contains a function called greet(name) which returns f"Hello, {name}!". Use the absolute path ${tempDir}/test_bootstrap.py.`,
		);

		expect(result.success).toBe(true);

		// Verify the file exists and has the right content
		const content = await readFile(join(tempDir, "test_bootstrap.py"), "utf-8");
		expect(content).toContain("greet");
		expect(content).toContain("Hello");

		// Verify recall event was emitted (genome was consulted)
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "recall")).toBe(true);

		// Verify delegation happened (root → code-editor)
		expect(collected.some((e) => e.kind === "act_start")).toBe(true);

		await vcr.afterTest();
	}, 120_000);

	test("agent with memory in genome gets recall with memory count > 0", async () => {
		const vcr = vcrForTest("agent-with-memory-in-genome-gets-recall-with-memory-count");

		// Add a memory to the genome
		await genome.addMemory({
			id: "int-test-mem",
			content: "This project uses Python 3.12 with type hints",
			tags: ["python", "style"],
			source: "test",
			created: Date.now(),
			last_used: Date.now(),
			use_count: 0,
			confidence: 1.0,
		});

		const events = new AgentEventEmitter();
		const rootSpec = genome.getAgent("root")!;

		const agent = new Agent({
			spec: rootSpec,
			env,
			client: vcr.client,
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
		});

		// Use a goal that has keywords matching the memory
		const result = await agent.run(
			`Create a file called style_check.py in ${tempDir} that has a simple Python function with type hints. Use the absolute path.`,
		);

		expect(result.success).toBe(true);

		// Verify recall found the memory (keyword "Python" matches)
		const recallEvent = events.collected().find((e) => e.kind === "recall");
		expect(recallEvent).toBeDefined();
		expect((recallEvent!.data as any).memory_count).toBeGreaterThan(0);

		await vcr.afterTest();
	}, 120_000);
});
