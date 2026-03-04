import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusClient } from "../../src/bus/client.ts";
import { GenomeMutationService } from "../../src/bus/genome-service.ts";
import { createMutationLearnRequest } from "../../src/bus/learn-contract.ts";
import { BusLearnForwarder } from "../../src/bus/learn-forwarder.ts";
import { BusServer } from "../../src/bus/server.ts";
import { genomeEvents, genomeMutations } from "../../src/bus/topics.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { LearnMutation } from "../../src/learn/learn-process.ts";

describe("GenomeMutationService", () => {
	let server: BusServer;
	let serviceBus: BusClient;
	let testBus: BusClient;
	let tempDir: string;
	let genome: Genome;
	let service: GenomeMutationService;

	const SESSION_ID = "genome-svc-test";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-genome-svc-"));
		genome = new Genome(tempDir);
		await genome.init();

		// Add a bootstrap agent so we can test update_agent
		await genome.addAgent({
			name: "code-editor",
			description: "Edits code",
			system_prompt: "You edit code.",
			model: "best",
			tools: ["write_file"],
			agents: [],
			constraints: {
				max_turns: 10,
				max_depth: 0,
				timeout_ms: 30000,
				can_spawn: false,
				can_learn: false,
			},
			tags: ["editor"],
			version: 1,
		});

		server = new BusServer({ port: 0 });
		await server.start();

		// Two separate clients: one for the service, one for the test harness.
		// The bus server does not echo messages back to the sender, so we need
		// separate clients to publish requests and receive confirmations.
		serviceBus = new BusClient(server.url);
		await serviceBus.connect();

		testBus = new BusClient(server.url);
		await testBus.connect();

		service = new GenomeMutationService({
			bus: serviceBus,
			genome,
			sessionId: SESSION_ID,
			stopDrainTimeoutMs: 100,
			stopDrainPollMs: 1,
		});
	});

	afterEach(async () => {
		await service.stop();
		await serviceBus.disconnect();
		await testBus.disconnect();
		await server.stop();
		await rm(tempDir, { recursive: true, force: true });
	});

	async function publishMutation(mutation: LearnMutation, requestId: string): Promise<void> {
		await testBus.publish(
			genomeMutations(SESSION_ID),
			JSON.stringify(createMutationLearnRequest(mutation, requestId)),
		);
	}

	test("processes a create_memory mutation", async () => {
		await service.start();

		// Subscribe to confirmations before publishing the request
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);

		await publishMutation(
			{
				type: "create_memory",
				content: "Always use strict mode in TypeScript",
				tags: ["typescript", "best-practice"],
			},
			"req-001",
		);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-001");
		expect(confirmation.mutation_type).toBe("create_memory");
		expect(confirmation.success).toBe(true);

		// Verify the memory was actually added to the genome
		const memories = genome.memories.all();
		expect(memories.length).toBe(1);
		expect(memories[0]!.content).toBe("Always use strict mode in TypeScript");
		expect(memories[0]!.tags).toEqual(["typescript", "best-practice"]);
	}, 10_000);

	test("processes mutations serially", async () => {
		await service.start();

		// Collect confirmations
		const confirmations: any[] = [];
		await testBus.subscribe(genomeEvents(SESSION_ID), (payload) => {
			confirmations.push(JSON.parse(payload));
		});

		// Publish two mutations concurrently
		const mutationsTopic = genomeMutations(SESSION_ID);
		await testBus.publish(
			mutationsTopic,
			JSON.stringify(
				createMutationLearnRequest(
					{
						type: "create_memory",
						content: "First memory",
						tags: ["first"],
					},
					"req-serial-1",
				),
			),
		);
		await testBus.publish(
			mutationsTopic,
			JSON.stringify(
				createMutationLearnRequest(
					{
						type: "create_memory",
						content: "Second memory",
						tags: ["second"],
					},
					"req-serial-2",
				),
			),
		);

		// Wait for both confirmations
		await waitUntil(() => confirmations.length >= 2, 5000);

		expect(confirmations.length).toBe(2);
		expect(confirmations[0]!.request_id).toBe("req-serial-1");
		expect(confirmations[0]!.success).toBe(true);
		expect(confirmations[1]!.request_id).toBe("req-serial-2");
		expect(confirmations[1]!.success).toBe(true);

		// Both memories exist in the genome
		const memories = genome.memories.all();
		expect(memories.length).toBe(2);
		const contents = memories.map((m) => m.content).sort();
		expect(contents).toEqual(["First memory", "Second memory"]);
	}, 10_000);

	test("publishes error for invalid mutation", async () => {
		await service.start();

		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);

		// update_agent with nonexistent agent should fail
		await publishMutation(
			{
				type: "update_agent",
				agent_name: "nonexistent-agent",
				system_prompt: "New prompt",
			},
			"req-err-001",
		);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-err-001");
		expect(confirmation.mutation_type).toBe("update_agent");
		expect(confirmation.success).toBe(false);
		expect(confirmation.error).toContain("not found");
	}, 10_000);

	test("stop resolves within timeout even if processing is stuck", async () => {
		await service.start();

		// Force the processing flag to true so the drain loop would spin forever
		// without a timeout safeguard
		(service as any).processing = true;

		const stopPromise = service.stop();
		const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timed_out"), 500));

		const winner = await Promise.race([stopPromise.then(() => "stopped"), timeout]);
		expect(winner).toBe("stopped");
	}, 10_000);

	test("publishes confirmation with request_id", async () => {
		await service.start();

		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);

		const requestId = "unique-correlation-id-42";
		await publishMutation(
			{
				type: "create_memory",
				content: "Correlation test",
				tags: ["test"],
			},
			requestId,
		);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.request_id).toBe(requestId);
	}, 10_000);

	test("processes a valid create_agent mutation", async () => {
		await service.start();

		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);

		await publishMutation(
			{
				type: "create_agent",
				name: "test-agent",
				description: "A test agent",
				system_prompt: "You are a test agent.",
				model: "fast",
				tools: ["read_file"],
				agents: [],
				tags: ["test"],
			},
			"req-create-001",
		);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-create-001");
		expect(confirmation.mutation_type).toBe("create_agent");
		expect(confirmation.success).toBe(true);

		// Verify the agent was actually added to the genome
		const agent = genome.getAgent("test-agent");
		expect(agent).toBeDefined();
		expect(agent!.description).toBe("A test agent");
		expect(agent!.system_prompt).toBe("You are a test agent.");
		expect(agent!.model).toBe("fast");
		expect(agent!.tools).toEqual(["read_file"]);
	}, 10_000);

	test("publishes error for create_agent with missing required fields", async () => {
		await service.start();

		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);

		// Send create_agent with missing description, system_prompt, and model
		await publishMutation(
			{
				type: "create_agent",
				name: "incomplete-agent",
			} as LearnMutation,
			"req-create-err-001",
		);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-create-err-001");
		expect(confirmation.mutation_type).toBe("create_agent");
		expect(confirmation.success).toBe(false);
		expect(confirmation.error).toContain("create_agent: missing or invalid");
	}, 10_000);

	test("consumes BusLearnForwarder signal requests end-to-end", async () => {
		await service.start();

		const forwarder = new BusLearnForwarder(testBus, SESSION_ID);
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);

		forwarder.push({
			kind: "failure",
			goal: "stabilize pipeline",
			agent_name: "worker-a",
			details: {
				agent_name: "worker-a",
				goal: "stabilize pipeline",
				output: "command failed",
				success: false,
				stumbles: 1,
				turns: 2,
				timed_out: false,
			},
			session_id: SESSION_ID,
			timestamp: Date.now(),
		});

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.success).toBe(true);
		expect(confirmation.mutation_type).toBe("create_memory");

		const memories = genome.memories.all();
		expect(memories.length).toBe(1);
		expect(memories[0]!.content).toContain("Learn signal (failure)");
		expect(memories[0]!.content).toContain("Goal: stabilize pipeline");
		expect(memories[0]!.tags).toEqual(["learn-signal", "failure", "worker-a"]);
	}, 10_000);
});

/** Poll until a condition is true or timeout. */
function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (condition()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("waitUntil timed out"));
				return;
			}
			setTimeout(check, 20);
		};
		check();
	});
}
