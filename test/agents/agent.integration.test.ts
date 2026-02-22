import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { loadBootstrapAgents } from "../../src/agents/loader.ts";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { Client } from "../../src/llm/client.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

describe("Agent Integration", () => {
	let tempDir: string;
	let env: LocalExecutionEnvironment;
	let client: Client;
	let registry: ReturnType<typeof createPrimitiveRegistry>;
	let bootstrapAgents: AgentSpec[];

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-test-"));
		env = new LocalExecutionEnvironment(tempDir);
		client = Client.fromEnv();
		registry = createPrimitiveRegistry(env);
		bootstrapAgents = await loadBootstrapAgents(join(import.meta.dir, "../../bootstrap"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("leaf agent creates a file using primitives", async () => {
		const codeEditor = bootstrapAgents.find((a) => a.name === "code-editor")!;
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: codeEditor,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: bootstrapAgents,
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
	}, 60_000);

	test("root agent delegates to code-editor to create a file", async () => {
		const rootSpec = bootstrapAgents.find((a) => a.name === "root")!;
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: bootstrapAgents,
			depth: 0,
			events,
		});

		const result = await agent.run(
			`Create a file called greet.py in ${tempDir} that prints "Hello from Sprout". The file must exist when you're done.`,
		);

		expect(result.success).toBe(true);
		expect(result.turns).toBeGreaterThan(0);

		const content = await readFile(join(tempDir, "greet.py"), "utf-8");
		expect(content).toContain("Sprout");

		// Should have act_start/act_end events (delegation happened)
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "act_start")).toBe(true);
		expect(collected.some((e) => e.kind === "act_end")).toBe(true);
	}, 120_000);
});

describe("Agent with Genome Integration", () => {
	let tempDir: string;
	let genomeDir: string;
	let env: LocalExecutionEnvironment;
	let client: Client;
	let registry: ReturnType<typeof createPrimitiveRegistry>;
	let genome: Genome;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-genome-int-"));
		genomeDir = join(tempDir, "genome");
		env = new LocalExecutionEnvironment(tempDir);
		client = Client.fromEnv();
		registry = createPrimitiveRegistry(env);

		// Create fresh genome with bootstrap agents
		genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("fresh genome with bootstrap agents completes a file creation task", async () => {
		const events = new AgentEventEmitter();
		const rootSpec = genome.getAgent("root")!;

		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
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
	}, 120_000);

	test("agent with memory in genome gets recall with memory count > 0", async () => {
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
			client,
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
	}, 120_000);
});
