import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createAgent } from "../../src/agents/factory.ts";
import { submitGoal } from "../../src/host/session.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

describe("E2E Integration", () => {
	let genomeDir: string;
	let workDir: string;

	beforeAll(async () => {
		const base = await mkdtemp(join(tmpdir(), "sprout-e2e-"));
		genomeDir = join(base, "genome");
		workDir = join(base, "work");
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
		const { mkdir } = await import("node:fs/promises");
		await mkdir(workDir, { recursive: true });
	});

	afterAll(async () => {
		// Clean up: genomeDir and workDir share a parent
		const parent = join(genomeDir, "..");
		await rm(parent, { recursive: true, force: true });
	});

	test("bootstrap: fresh genome creates a file", async () => {
		const result = await createAgent({
			genomePath: genomeDir,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: workDir,
		});
		for await (const _event of submitGoal(
			"Create a file called hello.py in the current directory that prints 'Hello World'",
			{ agent: result.agent, events: result.events, learnProcess: result.learnProcess },
		)) {
			// consume events
		}

		expect(existsSync(join(workDir, "hello.py"))).toBe(true);
		const content = await readFile(join(workDir, "hello.py"), "utf-8");
		expect(content).toContain("Hello");
	}, 120_000);

	test("multi-step: modify file and create test", async () => {
		const result = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
		});

		for await (const _event of submitGoal(
			"Add a command-line argument to hello.py that takes a name and prints 'Hello <name>'. Then create a test file test_hello.py that tests this functionality.",
			{ agent: result.agent, events: result.events, learnProcess: result.learnProcess },
		)) {
			// consume events
		}

		// Verify hello.py was modified to accept arguments
		const content = await readFile(join(workDir, "hello.py"), "utf-8");
		expect(
			content.includes("argparse") || content.includes("sys.argv") || content.includes("argv"),
		).toBe(true);

		// Verify some test file was created (agent may name it differently)
		const files = await readdir(workDir);
		const testFiles = files.filter((f) => f.startsWith("test") && f.endsWith(".py"));
		expect(testFiles.length).toBeGreaterThan(0);
	}, 180_000);

	test("stumble and learn: failure signal triggers genome mutation", async () => {
		const signal = {
			kind: "failure" as const,
			goal: "Run the project's test suite",
			agent_name: "command-runner",
			details: {
				agent_name: "command-runner",
				goal: "Run the project's test suite",
				output: "Error: command not found: pytest. This project uses vitest.",
				success: false,
				stumbles: 1,
				turns: 1,
			},
			session_id: "e2e-test",
			timestamp: Date.now(),
		};

		const result = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
		});

		result.learnProcess.push(signal);
		const processResult = await result.learnProcess.processNext();

		// Failure signals always pass shouldLearn, so this should be "applied"
		expect(processResult).toBe("applied");
	}, 120_000);

	test("genome growth: genome has grown beyond bootstrap", async () => {
		const result = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
		});

		const agentCount = result.genome.agentCount();
		const memoryCount = result.genome.memories.all().length;
		const ruleCount = result.genome.allRoutingRules().length;

		// At least one of these should have grown from the baseline (4 agents, 0 memories, 0 rules)
		const grew = agentCount > 4 || memoryCount > 0 || ruleCount > 0;
		expect(grew).toBe(true);
	}, 10_000);

	test("cross-session: new session loads learned genome", async () => {
		const result = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
		});

		// Verify the genome loaded with learned content
		const agentCount = result.genome.agentCount();
		const memoryCount = result.genome.memories.all().length;
		const ruleCount = result.genome.allRoutingRules().length;
		const grew = agentCount > 4 || memoryCount > 0 || ruleCount > 0;
		expect(grew).toBe(true);

		// Run a simple task to verify the agent works with the enriched genome
		for await (const _event of submitGoal("Read the file hello.py and tell me what it does", {
			agent: result.agent,
			events: result.events,
			learnProcess: result.learnProcess,
		})) {
			// consume events
		}

		// If we get here without error, the session worked
	}, 120_000);
});
