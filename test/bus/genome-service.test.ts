import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings, type ResolverSettings } from "../../src/agents/model-resolver.ts";
import { BusClient } from "../../src/bus/client.ts";
import { GenomeMutationService } from "../../src/bus/genome-service.ts";
import {
	createMutationLearnRequest,
	createSignalLearnRequest,
} from "../../src/bus/learn-contract.ts";
import { BusLearnForwarder } from "../../src/bus/learn-forwarder.ts";
import { BusServer } from "../../src/bus/server.ts";
import { genomeEvents, genomeMutations, sessionEvents } from "../../src/bus/topics.ts";
import type { Genome } from "../../src/genome/genome.ts";
import { memoryShortId } from "../../src/genome/memory-schema.ts";
import type { LearnSignal, SessionEvent } from "../../src/kernel/types.ts";
import type { LearnMutation } from "../../src/learn/learn-process.ts";
import type { Client } from "../../src/llm/client.ts";
import type { ProviderModel, Request, Response } from "../../src/llm/types.ts";
import { Msg, messageText } from "../../src/llm/types.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function makeMockResponse(text: string): Response {
	return {
		id: "mock",
		model: "test",
		provider: "anthropic",
		message: Msg.assistant(text),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	};
}

function makeMockClient(
	responseTexts: string[],
	onRequest?: (request: Request) => void,
	options: { providers?: string[]; modelsByProvider?: Map<string, ProviderModel[]> } = {},
): Client {
	let index = 0;
	const providerIds = options.providers ?? ["anthropic"];
	const modelsByProvider =
		options.modelsByProvider ??
		new Map<string, ProviderModel[]>([
			["anthropic", [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "remote" }]],
		]);
	return {
		providers: () => providerIds,
		listModelsByProvider: async () => modelsByProvider,
		complete: async (request: Request) => {
			onRequest?.(request);
			const responseText = responseTexts[index] ?? responseTexts.at(-1) ?? "[]";
			index++;
			return makeMockResponse(responseText);
		},
	} as unknown as Client;
}

function makeSignal(overrides: Partial<LearnSignal> = {}): LearnSignal {
	return {
		kind: overrides.kind ?? "failure",
		goal: overrides.goal ?? "stabilize pipeline",
		agent_name: overrides.agent_name ?? "worker-a",
		details: overrides.details ?? {
			agent_name: "worker-a",
			goal: "stabilize pipeline",
			output: "command failed",
			success: false,
			stumbles: 1,
			turns: 2,
			timed_out: false,
		},
		session_id: overrides.session_id ?? "genome-svc-test",
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

function event(
	kind: SessionEvent["kind"],
	timestamp: number,
	data: Record<string, unknown>,
	depth = 0,
	agent_id = depth === 0 ? "root" : "worker-a",
): SessionEvent {
	return { kind, timestamp, agent_id, depth, data };
}

function requestText(request: Request): string {
	return request.messages.map((message) => messageText(message)).join("\n");
}

function extractionResolverSettings(
	providerId = "anthropic",
	modelId = "claude-sonnet-4-6",
): ResolverSettings {
	return createResolverSettings(
		[{ id: providerId, enabled: true }],
		{},
		{
			extraction: { providerId, modelId },
			relationship: { providerId, modelId },
		},
	);
}

function extractionOnlyResolverSettings(
	providerId = "anthropic",
	modelId = "claude-sonnet-4-6",
): ResolverSettings {
	return createResolverSettings(
		[{ id: providerId, enabled: true }],
		{},
		{
			extraction: { providerId, modelId },
		},
	);
}

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
		genome = createTestGenome(tempDir);
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

	async function publishSessionEvent(sessionEvent: SessionEvent): Promise<void> {
		await testBus.publish(
			sessionEvents(SESSION_ID),
			JSON.stringify({ kind: "event", handle_id: "handle-1", event: sessionEvent }),
		);
	}

	async function publishSignal(signal: LearnSignal, requestId: string): Promise<void> {
		await testBus.publish(
			genomeMutations(SESSION_ID),
			JSON.stringify(createSignalLearnRequest(signal, requestId)),
		);
	}

	async function publishEvidenceWindow(signal: LearnSignal): Promise<void> {
		const base = signal.timestamp - 50;
		await publishSessionEvent(
			event("session_start", base, {
				session_id: signal.session_id,
				goal: signal.goal,
				model: "claude-sonnet-4-6",
			}),
		);
		await publishSessionEvent(event("perceive", base + 5, { goal: signal.goal }));
		await publishSessionEvent(
			event("primitive_end", base + 20, {
				name: "exec",
				display_name: "exec",
				success: false,
				stumbled: true,
				output: "command failed while stabilizing pipeline",
				error: "exit 1",
				tool_result_message: Msg.toolResult(
					"tool-1",
					"Error: exit 1\ncommand failed while stabilizing pipeline",
					true,
				),
			}),
		);
		await publishSessionEvent(
			event("session_end", base + 80, {
				session_id: signal.session_id,
				success: false,
				stumbles: signal.details.stumbles,
				turns: signal.details.turns,
				timed_out: signal.details.timed_out,
				output: "terminal failed state",
			}),
		);
	}

	async function waitForServiceEvents(count: number): Promise<void> {
		await waitUntil(
			() => ((service as unknown as { events: SessionEvent[] }).events?.length ?? 0) >= count,
			5000,
		);
	}

	function replaceService(options: {
		client?: Client;
		clientFactory?: () => Client;
		resolverSettings?: ResolverSettings;
		signalEvidenceWaitMs?: number;
	}): void {
		service = new GenomeMutationService({
			bus: serviceBus,
			genome,
			sessionId: SESSION_ID,
			stopDrainTimeoutMs: 100,
			stopDrainPollMs: 1,
			...options,
		});
	}

	test("rejects direct create_memory mutations", async () => {
		await service.start();

		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);

		await publishMutation(
			{
				type: "create_memory",
				content: "Always use strict mode in TypeScript",
				tags: ["typescript", "best-practice"],
			} as unknown as LearnMutation,
			"req-001",
		);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-001");
		expect(confirmation.mutation_type).toBe("create_memory");
		expect(confirmation.success).toBe(false);
		expect(confirmation.error).toContain("create_memory mutations are unsupported");
		expect(genome.memories.all()).toHaveLength(0);
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
						type: "create_routing_rule",
						condition: "first condition",
						preference: "code-editor",
						strength: 0.7,
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
						type: "create_routing_rule",
						condition: "second condition",
						preference: "code-editor",
						strength: 0.8,
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

		const conditions = genome
			.allRoutingRules()
			.map((rule) => rule.condition)
			.sort();
		expect(conditions).toEqual(["first condition", "second condition"]);
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
			} as unknown as LearnMutation,
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
		replaceService({
			client: makeMockClient([
				JSON.stringify([
					{
						text: "Worker-a should stabilize the pipeline by investigating failed commands.",
						tags: ["pipeline", "debugging"],
					},
				]),
			]),
			resolverSettings: extractionResolverSettings(),
		});
		await service.start();

		const forwarder = new BusLearnForwarder(testBus, SESSION_ID);
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({ session_id: SESSION_ID, timestamp: Date.now() });
		await publishEvidenceWindow(signal);
		await waitForServiceEvents(4);

		forwarder.push(signal);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);

		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.success).toBe(true);
		expect(confirmation.mutation_type).toBe("learn_signal");
		expect(confirmation.extracted_count).toBe(1);

		const memories = genome.memories.all();
		expect(memories.length).toBe(1);
		expect(memories[0]!.content).toContain("stabilize the pipeline");
		expect(memories[0]!.source).toBe("learn:extraction");
		expect(memories[0]!.embedding?.status).toBe("ready");
	}, 10_000);

	test("signal extraction incorporates relationships from evidence ids", async () => {
		await genome.addMemory({
			id: "stale-bus-auth",
			content: "streamlinear uses Authorization: token header format.",
			tags: ["streamlinear"],
			source: "test",
			created: 50,
			last_used: 50,
			use_count: 0,
			confidence: 1,
		});
		const requests: Request[] = [];
		replaceService({
			client: makeMockClient(
				[
					JSON.stringify([
						{
							text: "streamlinear sends a bare Authorization header value, no token prefix.",
							tags: ["streamlinear", "auth"],
						},
					]),
					JSON.stringify({
						relationship_type: "supersedes",
						reasoning: "The newer memory replaces the older token-prefix claim.",
					}),
				],
				(request) => requests.push(request),
			),
			resolverSettings: extractionResolverSettings(),
			signalEvidenceWaitMs: 0,
		});
		await service.start();
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({
			session_id: SESSION_ID,
			timestamp: Date.now(),
			goal: `Correct stale memory ${memoryShortId("stale-bus-auth")}.`,
		});
		await publishEvidenceWindow(signal);
		await waitForServiceEvents(4);

		await publishSignal(signal, "req-signal-relationship");

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);
		expect(confirmation.success).toBe(true);
		expect(confirmation.mutation_type).toBe("learn_signal");
		const correction = genome.memories
			.all()
			.find((memory) => memory.content.includes("bare Authorization header value"));
		expect(correction).toBeDefined();
		expect(genome.memories.getById("stale-bus-auth")?.superseded_by).toBe(correction?.id);
		expect(requests.map((request) => request.metadata?.purpose)).toEqual([
			"memory.extraction",
			"memory.relationship",
		]);
	}, 10_000);

	test("signal extraction uses the configured memory extraction provider", async () => {
		const requests: Request[] = [];
		replaceService({
			client: makeMockClient(
				[
					JSON.stringify([
						{
							text: "Worker-a should use the populated provider model for bus extraction.",
							tags: ["provider"],
						},
					]),
				],
				(request) => requests.push(request),
				{
					providers: ["empty-provider", "anthropic"],
					modelsByProvider: new Map<string, ProviderModel[]>([
						["empty-provider", []],
						[
							"anthropic",
							[{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "remote" }],
						],
					]),
				},
			),
			resolverSettings: extractionResolverSettings(),
			signalEvidenceWaitMs: 0,
		});
		await service.start();
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({ session_id: SESSION_ID, timestamp: Date.now() });
		await publishEvidenceWindow(signal);
		await waitForServiceEvents(4);

		await publishSignal(signal, "req-signal-provider-fallback");

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);
		expect(confirmation.success).toBe(true);
		expect(confirmation.extracted_count).toBe(1);
		expect(requests[0]?.provider).toBe("anthropic");
		expect(requests[0]?.model).toBe("claude-sonnet-4-6");
		expect(requests[0]?.metadata?.purpose).toBe("memory.extraction");
		expect(genome.memories.all()[0]?.content).toContain("populated provider model");
	}, 10_000);

	test("signal extraction waits for post-signal act_end without session_end", async () => {
		const prompts: string[] = [];
		replaceService({
			client: makeMockClient(
				[
					JSON.stringify([
						{
							text: "Worker-a terminal delegation output should ground bus extraction.",
							tags: ["bus", "evidence"],
						},
					]),
				],
				(request) => prompts.push(requestText(request)),
			),
			resolverSettings: extractionResolverSettings(),
			signalEvidenceWaitMs: 500,
		});
		await service.start();
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({ session_id: SESSION_ID, timestamp: Date.now() });
		await publishSessionEvent(
			event("session_start", signal.timestamp - 10, {
				session_id: signal.session_id,
				goal: signal.goal,
				model: "claude-sonnet-4-6",
			}),
		);
		await publishSessionEvent(
			event("primitive_end", signal.timestamp - 5, {
				name: "exec",
				display_name: "exec",
				success: false,
				stumbled: true,
				output: "unrelated primitive evidence before delegation signal",
				error: "unrelated failure",
			}),
		);
		await waitForServiceEvents(2);

		await publishSignal(signal, "req-signal-before-terminal");
		setTimeout(() => {
			void publishSessionEvent(
				event("act_end", signal.timestamp + 1, {
					agent_name: "worker-a",
					goal: signal.goal,
					success: false,
					turns: 2,
					timed_out: false,
					output: "late delegation output after signal",
					tool_result_message: Msg.toolResult(
						"delegate-1",
						"late delegation output after signal",
						true,
					),
				}),
			);
		}, 150);

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);
		expect(confirmation.success).toBe(true);
		expect(prompts[0]).toContain("late delegation output after signal");
		expect(prompts[0]).not.toContain("late terminal failed state after signal");
	}, 10_000);

	test("publishes an error for signal requests without extraction dependencies", async () => {
		replaceService({
			clientFactory: () => {
				throw new Error("missing extraction client");
			},
			signalEvidenceWaitMs: 0,
		});
		await service.start();
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({ session_id: SESSION_ID, timestamp: Date.now() });
		await publishEvidenceWindow(signal);
		await waitForServiceEvents(4);

		await publishSignal(signal, "req-signal-missing-client");

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);
		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-signal-missing-client");
		expect(confirmation.mutation_type).toBe("learn_signal");
		expect(confirmation.success).toBe(false);
		expect(confirmation.error).toContain("missing extraction client");
		expect(genome.memories.all()).toHaveLength(0);
	}, 10_000);

	test("publishes an error for signal requests without an extraction model fallback", async () => {
		replaceService({
			client: makeMockClient(["[]"]),
			signalEvidenceWaitMs: 0,
		});
		await service.start();
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({ session_id: SESSION_ID, timestamp: Date.now() });
		await publishEvidenceWindow(signal);
		await waitForServiceEvents(4);

		await publishSignal(signal, "req-signal-missing-extraction-model");

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);
		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-signal-missing-extraction-model");
		expect(confirmation.mutation_type).toBe("learn_signal");
		expect(confirmation.success).toBe(false);
		expect(confirmation.error).toContain("No global 'balanced' model is configured");
		expect(genome.memories.all()).toHaveLength(0);
	}, 10_000);

	test("publishes an error for signal requests without a relationship model fallback", async () => {
		replaceService({
			client: makeMockClient(["[]"]),
			resolverSettings: extractionOnlyResolverSettings(),
			signalEvidenceWaitMs: 0,
		});
		await service.start();
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({ session_id: SESSION_ID, timestamp: Date.now() });
		await publishEvidenceWindow(signal);
		await waitForServiceEvents(4);

		await publishSignal(signal, "req-signal-missing-relationship-model");

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);
		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-signal-missing-relationship-model");
		expect(confirmation.mutation_type).toBe("learn_signal");
		expect(confirmation.success).toBe(false);
		expect(confirmation.error).toContain("No global 'fast' model is configured");
		expect(genome.memories.all()).toHaveLength(0);
	}, 10_000);

	test("publishes an error for signal requests without event-window evidence", async () => {
		replaceService({
			client: makeMockClient(["[]"]),
			signalEvidenceWaitMs: 0,
		});
		await service.start();
		const confirmationPromise = testBus.waitForMessage(genomeEvents(SESSION_ID), 5000);
		const signal = makeSignal({ session_id: SESSION_ID, timestamp: Date.now() });

		await publishSignal(signal, "req-signal-no-events");

		const raw = await confirmationPromise;
		const confirmation = JSON.parse(raw);
		expect(confirmation.kind).toBe("mutation_confirmed");
		expect(confirmation.request_id).toBe("req-signal-no-events");
		expect(confirmation.mutation_type).toBe("learn_signal");
		expect(confirmation.success).toBe(false);
		expect(confirmation.error).toContain("No event-window evidence");
		expect(genome.memories.all()).toHaveLength(0);
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
