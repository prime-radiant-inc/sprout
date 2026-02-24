import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createAgent } from "../../src/agents/factory.ts";
import { Client } from "../../src/llm/client.ts";
import { submitGoal } from "../../src/host/session.ts";
import { createVcr } from "../helpers/vcr.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

const VCR_FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/e2e");

describe("E2E Integration", () => {
	let genomeDir: string;
	let workDir: string;
	let realClient: Client | undefined;

	function vcrForTest(testName: string) {
		const subs = {
			"{{GENOME_DIR}}": genomeDir,
			"{{WORK_DIR}}": workDir,
		};
		return createVcr({
			fixtureDir: VCR_FIXTURE_DIR,
			testName,
			substitutions: subs,
			realClient: realClient ?? undefined,
		});
	}

	beforeAll(async () => {
		const base = await mkdtemp(join(tmpdir(), "sprout-e2e-"));
		genomeDir = join(base, "genome");
		workDir = join(base, "work");
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
		const { mkdir } = await import("node:fs/promises");
		await mkdir(workDir, { recursive: true });

		const mode = process.env.VCR_MODE;
		if (mode === "record" || mode === "off") {
			realClient = Client.fromEnv();
		}
	});

	afterAll(async () => {
		const parent = join(genomeDir, "..");
		await rm(parent, { recursive: true, force: true });
	});

	test("bootstrap: fresh genome creates a file", async () => {
		const vcr = vcrForTest("bootstrap-fresh-genome-creates-a-file");
		const result = await createAgent({
			genomePath: genomeDir,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: workDir,
			client: vcr.client,
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

		await vcr.afterTest();
	}, 120_000);

	test("multi-step: modify file and create test", async () => {
		const vcr = vcrForTest("multi-step-modify-file-and-create-test");
		const result = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
			client: vcr.client,
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

		await vcr.afterTest();
	}, 180_000);

	test("stumble and learn: session produces learn signals", async () => {
		const vcr = vcrForTest("stumble-and-learn-session-produces-learn-signals");
		const {
			agent: agent1,
			events: events1,
			learnProcess: lp1,
		} = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
			client: vcr.client,
		});

		let sessionEnded = false;
		for await (const event of submitGoal("Run the tests in this project", {
			agent: agent1,
			events: events1,
			learnProcess: lp1,
		})) {
			if (event.kind === "session_end") {
				sessionEnded = true;
			}
		}

		// The session should complete without crashing
		expect(sessionEnded).toBe(true);

		// The genome should still be loadable after a session with potential learn activity
		const { genome: genome2 } = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
			client: vcr.client,
		});
		expect(genome2.agentCount()).toBeGreaterThanOrEqual(4);

		await vcr.afterTest();
	}, 120_000);

	test("genome growth: genome loads successfully after sessions", async () => {
		const vcr = vcrForTest("genome-growth-genome-loads-successfully-after-sessions");
		const result = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
			client: vcr.client,
		});

		// Genome should load with at least the bootstrap agents
		const agentCount = result.genome.agentCount();
		expect(agentCount).toBeGreaterThanOrEqual(4);

		await vcr.afterTest();
	}, 10_000);

	test("cross-session: new session loads learned genome", async () => {
		const vcr = vcrForTest("cross-session-new-session-loads-learned-genome");
		const result = await createAgent({
			genomePath: genomeDir,
			workDir: workDir,
			client: vcr.client,
		});

		// Verify the genome loaded with at least bootstrap agents
		const agentCount = result.genome.agentCount();
		expect(agentCount).toBeGreaterThanOrEqual(4);

		// Run a simple task to verify the agent works with the loaded genome
		for await (const _event of submitGoal("Read the file hello.py and tell me what it does", {
			agent: result.agent,
			events: result.events,
			learnProcess: result.learnProcess,
		})) {
			// consume events
		}

		// If we get here without error, the session worked

		await vcr.afterTest();
	}, 120_000);
});
