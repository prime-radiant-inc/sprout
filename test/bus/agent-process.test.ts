import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cp, exists, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { createAgentProcessClient, runAgentProcess } from "../../src/bus/agent-process.ts";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";
import {
	agentEvents,
	agentInbox,
	agentReady,
	agentResult,
	genomeMutations,
	sessionEvents,
} from "../../src/bus/topics.ts";
import type { ResultMessage, StartMessage } from "../../src/bus/types.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { LogEntry } from "../../src/host/logger.ts";
import { SessionLogger } from "../../src/host/logger.ts";
import {
	createProviderSecretRef,
	createSecretStore,
	type SecretStoreRuntime,
} from "../../src/host/settings/secret-store.ts";
import type { SproutSettings } from "../../src/host/settings/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { ContentKind, Msg } from "../../src/llm/types.ts";

// Minimal agent spec for testing -- leaf agent with no delegation
const MINIMAL_AGENT_SPEC = {
	name: "test-leaf",
	description: "A minimal test agent",
	model: "best",
	tools: ["read_file"],
	agents: [],
	constraints: {
		max_turns: 5,
		timeout_ms: 30000,
		can_spawn: false,
		can_learn: false,
	},
	tags: ["test"],
	version: 1,
	system_prompt: "You are a test agent. Respond with a brief answer.",
};

// Orchestrator agent spec -- can_spawn, delegates to test-leaf
const ORCHESTRATOR_AGENT_SPEC = {
	name: "test-orchestrator",
	description: "An orchestrator that delegates to test-leaf",
	model: "best",
	tools: [],
	agents: ["test-leaf"],
	constraints: {
		max_turns: 5,
		timeout_ms: 30000,
		can_spawn: true,
		can_learn: false,
	},
	tags: ["test"],
	version: 1,
	system_prompt: "You are an orchestrator. Delegate work to test-leaf.",
};

const LEARNING_AGENT_SPEC = {
	name: "test-learner",
	description: "A learning-capable test agent",
	model: "best",
	tools: ["read_file"],
	agents: [],
	constraints: {
		max_turns: 5,
		timeout_ms: 30000,
		can_spawn: false,
		can_learn: true,
	},
	tags: ["test"],
	version: 1,
	system_prompt: "You are a test learner.",
};

const TEST_PROVIDER_ID = "anthropic";
const TEST_MODEL_ID = "claude-haiku-4-5-20251001";
const TEST_RESOLVER_SETTINGS = createResolverSettings(
	[
		{
			id: TEST_PROVIDER_ID,
			enabled: true,
		},
	],
	{
		best: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODEL_ID },
		balanced: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODEL_ID },
		fast: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODEL_ID },
	},
);

function withResolverContext(startMsg: StartMessage): StartMessage {
	return {
		...startMsg,
		provider_id: TEST_PROVIDER_ID,
		resolver_settings: TEST_RESOLVER_SETTINGS,
	};
}

/** Create a mock LLM client that returns a canned text response */
function createMockClient(responseText: string): Client {
	const response: Response = {
		id: "mock-1",
		model: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		message: Msg.assistant(responseText),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
	};
	return {
		complete: async (_request: Request): Promise<Response> => response,
		stream: async function* () {
			yield { type: "stream_start" as const };
			yield {
				type: "finish" as const,
				finish_reason: response.finish_reason,
				usage: response.usage,
				response,
			};
		},
		providers: () => ["anthropic"],
	} as unknown as Client;
}

/**
 * Build a mock client where both `complete` and `stream` use the same handler.
 * The stream wraps the complete response as a minimal streaming sequence.
 */
function buildMockClient(handler: (request: Request) => Promise<Response>): Client {
	return {
		complete: handler,
		stream: async function* (request: Request) {
			const response = await handler(request);
			yield { type: "stream_start" as const };
			yield {
				type: "finish" as const,
				finish_reason: response.finish_reason,
				usage: response.usage,
				response,
			};
		},
		providers: () => ["anthropic"],
	} as unknown as Client;
}

function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `results` accumulates at least `count` entries, or time out. */
async function waitForResults(
	results: ResultMessage[],
	count: number,
	timeoutMs = 5000,
): Promise<void> {
	if (results.length >= count) return;
	const deadline = Date.now() + timeoutMs;
	while (results.length < count && Date.now() < deadline) {
		await delay(10);
	}
	if (results.length < count) {
		throw new Error(`Timed out waiting for ${count} results (got ${results.length})`);
	}
}

/** Poll until a predicate becomes true, or time out. */
async function waitForCondition(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	if (condition()) return;
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) {
		await delay(10);
	}
	if (!condition()) {
		throw new Error("Timed out waiting for condition");
	}
}

describe("runAgentProcess", () => {
	let server: BusServer;
	let parentClient: BusClient;
	let suiteTempDir: string;
	let tempDir: string;
	let genomeDir: string;
	let genomeTemplateDir: string;

	const SESSION_ID = "test-session-001";
	const HANDLE_ID = "test-handle-001";

	beforeAll(async () => {
		suiteTempDir = await mkdtemp(join(tmpdir(), "sprout-agent-proc-"));
		genomeTemplateDir = join(suiteTempDir, "__genome-template");

		const templateGenome = new Genome(genomeTemplateDir);
		await templateGenome.init();
		await templateGenome.addAgent(MINIMAL_AGENT_SPEC as any);
	});

	beforeEach(async () => {
		tempDir = await mkdtemp(join(suiteTempDir, "case-"));
		genomeDir = join(tempDir, "genome");
		await cp(genomeTemplateDir, genomeDir, { recursive: true });

		server = new BusServer({ port: 0 });
		await server.start();

		parentClient = new BusClient(server.url);
		await parentClient.connect();
	});

	afterEach(async () => {
		await parentClient.disconnect();
		await server.stop();
		await rm(tempDir, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(suiteTempDir, { recursive: true, force: true });
	});

	async function waitForAgentReady(): Promise<void> {
		const readyTopic = agentReady(SESSION_ID, HANDLE_ID);
		await parentClient.waitForMessage(readyTopic, 10_000);
	}

	test("non-shared agent runs to completion and exits", async () => {
		const mockClient = createMockClient("Task completed successfully.");

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		// Start the agent process -- it returns when the non-shared agent finishes
		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		// Send a start message (shared: false)
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Say hello",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		// Wait for the result
		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);

		expect(result.kind).toBe("result");
		expect(result.handle_id).toBe(HANDLE_ID);
		expect(result.output).toBe("Task completed successfully.");
		expect(result.success).toBe(true);
		expect(result.turns).toBe(1);
		expect(result.timed_out).toBe(false);

		// Non-shared agent process should exit on its own
		await processPromise;
	}, 15_000);

	test("eval mode suppresses learn forwarding for child agents", async () => {
		const learnerGenome = new Genome(genomeDir);
		await learnerGenome.addAgent(LEARNING_AGENT_SPEC as any);

		let callCount = 0;
		const mockClient = buildMockClient(async (): Promise<Response> => {
			callCount++;
			if (callCount === 1) {
				return {
					id: "mock-tool-call",
					model: TEST_MODEL_ID,
					provider: TEST_PROVIDER_ID,
					message: {
						role: "assistant",
						content: [
							{
								kind: ContentKind.TOOL_CALL,
								tool_call: {
									id: "call-1",
									name: "read_file",
									arguments: { path: "missing.txt" },
								},
							},
						],
					},
					finish_reason: { reason: "tool_calls" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			}
			return {
				id: "mock-final",
				model: TEST_MODEL_ID,
				provider: TEST_PROVIDER_ID,
				message: Msg.assistant("done"),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);
		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-learner",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Try to read a missing file",
			shared: false,
			agent_id: HANDLE_ID,
			eval_mode: true,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);
		expect(result.success).toBe(true);

		await expect(parentClient.waitForMessage(genomeMutations(SESSION_ID), 500)).rejects.toThrow(
			"waitForMessage timed out",
		);

		await processPromise;
	}, 15_000);

	test("forwards learn signals for child agents when eval mode is off", async () => {
		const learnerGenome = new Genome(genomeDir);
		await learnerGenome.addAgent(LEARNING_AGENT_SPEC as any);

		let callCount = 0;
		const mockClient = buildMockClient(async (): Promise<Response> => {
			callCount++;
			if (callCount === 1) {
				return {
					id: "mock-tool-call",
					model: TEST_MODEL_ID,
					provider: TEST_PROVIDER_ID,
					message: {
						role: "assistant",
						content: [
							{
								kind: ContentKind.TOOL_CALL,
								tool_call: {
									id: "call-1",
									name: "read_file",
									arguments: { path: "missing.txt" },
								},
							},
						],
					},
					finish_reason: { reason: "tool_calls" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			}
			return {
				id: "mock-final",
				model: TEST_MODEL_ID,
				provider: TEST_PROVIDER_ID,
				message: Msg.assistant("done"),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const mutationPromise = parentClient.waitForMessage(genomeMutations(SESSION_ID), 10_000);
		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);
		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-learner",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Try to read a missing file",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);
		expect(result.success).toBe(true);

		const mutation = JSON.parse(await mutationPromise);
		expect(mutation.kind).toBe("learn_request");

		await processPromise;
	}, 15_000);

	test("builds child-process clients from settings-backed providers instead of env", async () => {
		const originalOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "env-openai-secret";

		try {
			const secretStore = createSecretStore({ backend: "memory", platform: "darwin" });
			await secretStore.setSecret(
				createProviderSecretRef("openrouter", "memory"),
				"openrouter-secret",
			);
			const settings: SproutSettings = {
				version: 2,
				providers: [
					{
						id: "openrouter",
						kind: "openrouter",
						label: "OpenRouter",
						enabled: true,
						createdAt: "2026-03-13T18:00:00.000Z",
						updatedAt: "2026-03-13T18:00:00.000Z",
					},
				],
				defaults: {},
			};
			const logger = new SessionLogger({
				logPath: join(tempDir, "session.log.jsonl"),
				component: "agent-process-test",
				sessionId: SESSION_ID,
			});

			const client = await createAgentProcessClient(logger, {
				createSettingsStore: () => ({
					load: async () =>
						({
							settings,
							skipEnvImport: false,
							source: "loaded",
						}) satisfies {
							settings: SproutSettings;
							skipEnvImport: boolean;
							source: "missing" | "loaded" | "recovered";
						},
				}),
				createSecretStoreRuntime: () =>
					({
						secretRefBackend: "memory",
						secretBackendState: {
							backend: "memory",
							available: true,
						},
						secretStore,
					}) satisfies SecretStoreRuntime,
			});

			expect(client.providers()).toEqual(["openrouter"]);
			expect(client.adapter("openrouter")?.providerId).toBe("openrouter");
			expect(client.adapter("openai")).toBeUndefined();
		} finally {
			if (originalOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = originalOpenAiKey;
			}
		}
	});

	test("publishes events during agent execution", async () => {
		const mockClient = createMockClient("Done.");

		const eventsTopic = agentEvents(SESSION_ID, HANDLE_ID);
		const collectedEvents: string[] = [];
		await parentClient.subscribe(eventsTopic, (payload) => {
			collectedEvents.push(payload);
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Do something",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		await resultPromise;
		await waitForCondition(() => {
			const kinds = collectedEvents.map((payload) => JSON.parse(payload).event.kind);
			return kinds.includes("session_start") && kinds.includes("session_end");
		});

		expect(collectedEvents.length).toBeGreaterThan(0);

		const parsed = collectedEvents.map((e) => JSON.parse(e));
		const kinds = parsed.map((e) => e.event.kind);
		expect(kinds).toContain("session_start");
		expect(kinds).toContain("session_end");

		await processPromise;
	}, 15_000);

	test("events carry caller.depth + 1 as their depth", async () => {
		const mockClient = createMockClient("Done.");

		const eventsTopic = agentEvents(SESSION_ID, HANDLE_ID);
		const collectedEvents: string[] = [];
		await parentClient.subscribe(eventsTopic, (payload) => {
			collectedEvents.push(payload);
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		// Send start message with caller at depth 0 → agent should be depth 1
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Do something",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		await resultPromise;
		await waitForCondition(() => {
			const kinds = collectedEvents.map((payload) => JSON.parse(payload).event.kind);
			return kinds.includes("session_start") && kinds.includes("session_end");
		});

		expect(collectedEvents.length).toBeGreaterThan(0);

		const parsed = collectedEvents.map((e) => JSON.parse(e));
		// Every event emitted by a sub-agent spawned by a depth-0 caller should have depth 1
		for (const evt of parsed) {
			expect(evt.event.depth).toBe(1);
		}

		await processPromise;
	}, 15_000);

	test("publishes events to session-wide topic for depth-independent delivery", async () => {
		const mockClient = createMockClient("Done.");

		// Subscribe to session-wide events topic (not the per-handle topic)
		const sessionTopic = sessionEvents(SESSION_ID);
		const collectedEvents: string[] = [];
		await parentClient.subscribe(sessionTopic, (payload) => {
			collectedEvents.push(payload);
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Session-wide test",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		await resultPromise;
		await waitForCondition(() => {
			const kinds = collectedEvents.map((payload) => JSON.parse(payload).event.kind);
			return kinds.includes("session_start") && kinds.includes("session_end");
		});

		// Events should appear on the session-wide topic
		expect(collectedEvents.length).toBeGreaterThan(0);

		const parsed = collectedEvents.map((e) => JSON.parse(e));
		const kinds = parsed.map((e: any) => e.event.kind);
		expect(kinds).toContain("session_start");
		expect(kinds).toContain("session_end");

		// Each event should include the handle_id for tracing
		for (const evt of parsed) {
			expect(evt.handle_id).toBe(HANDLE_ID);
		}

		await processPromise;
	}, 15_000);

	test("shared agent handles continue message after initial run", async () => {
		let callCount = 0;
		const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
			callCount++;
			const text = callCount === 1 ? "First response." : "Continued response.";
			return {
				id: `mock-${callCount}`,
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant(text),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const controller = new AbortController();

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const results: ResultMessage[] = [];
		await parentClient.subscribe(resultTopic, (payload) => {
			results.push(JSON.parse(payload));
		});

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
			signal: controller.signal,
		});

		await waitForAgentReady();

		// Send start message (shared: true -- agent stays alive for continue)
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "First task",
			shared: true,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		// Wait for first result
		await waitForResults(results, 1);
		expect(results[0]!.output).toBe("First response.");

		// Send continue message
		const continueMsg = {
			kind: "continue",
			message: "Now do the second thing",
			caller: { agent_name: "root", depth: 0 },
		};
		await parentClient.publish(inboxTopic, JSON.stringify(continueMsg));

		// Wait for second result
		await waitForResults(results, 2);
		expect(results[1]!.output).toBe("Continued response.");

		// Shut down the shared agent
		controller.abort();
		await processPromise;
	}, 15_000);

	test("queues continue messages that arrive while processing", async () => {
		let callCount = 0;
		const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
			callCount++;
			// First call is the initial run. Second is the first continue
			// (slow so the third arrives while it's still processing).
			// Third is the queued continue.
			const responses: Record<number, string> = {
				1: "Initial response.",
				2: "Continue-1 response.",
				3: "Continue-2 response.",
			};
			if (callCount === 2) {
				await delay(120); // Slow enough for second continue to arrive
			}
			return {
				id: `mock-${callCount}`,
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant(responses[callCount] ?? `Response ${callCount}`),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const controller = new AbortController();

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const results: ResultMessage[] = [];
		await parentClient.subscribe(resultTopic, (payload) => {
			results.push(JSON.parse(payload));
		});

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
			signal: controller.signal,
		});

		await waitForAgentReady();

		// Send start message (shared: true)
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Initial task",
			shared: true,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		// Wait for initial result
		await waitForResults(results, 1);
		expect(results[0]!.output).toBe("Initial response.");

		// Send two continue messages in rapid succession.
		// The first triggers a 300ms-slow LLM call; the second arrives
		// while the first is still processing and should be queued.
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({
				kind: "continue",
				message: "First continue",
				caller: { agent_name: "root", depth: 0 },
			}),
		);
		await delay(20); // Small gap to ensure ordering
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({
				kind: "continue",
				message: "Second continue",
				caller: { agent_name: "root", depth: 0 },
			}),
		);

		// Wait for all three results (initial + 2 continues)
		await waitForResults(results, 3);
		expect(results[1]!.output).toBe("Continue-1 response.");
		expect(results[2]!.output).toBe("Continue-2 response.");

		controller.abort();
		await processPromise;
	}, 15_000);

	test("steer messages are queued and applied in next continue cycle", async () => {
		const requests: Request[] = [];
		let callCount = 0;
		const mockClient = buildMockClient(async (request: Request): Promise<Response> => {
			requests.push(request);
			callCount++;
			return {
				id: `mock-${callCount}`,
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant(`Response ${callCount}.`),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const controller = new AbortController();

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const results: ResultMessage[] = [];
		await parentClient.subscribe(resultTopic, (payload) => {
			results.push(JSON.parse(payload));
		});

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
			signal: controller.signal,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Initial task",
			shared: true,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		// Wait for first result
		await waitForResults(results, 1);

		// Send steer while idle — should be queued for next continue
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({ kind: "steer", message: "Priority change: focus on tests" }),
		);
		await delay(25);

		// Send continue — the steer should be injected into the conversation
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({
				kind: "continue",
				message: "Continue working",
				caller: { agent_name: "root", depth: 0 },
			}),
		);

		await waitForResults(results, 2);

		// Verify the steer content was included in the LLM request
		// The second request should contain the steer text as a user message
		const secondRequest = requests[1]!;
		const allContent = JSON.stringify(secondRequest.messages);
		expect(allContent).toContain("Priority change: focus on tests");

		controller.abort();
		await processPromise;
	}, 15_000);

	test("steer messages are forwarded to agent during initial run", async () => {
		const requests: Request[] = [];
		let callCount = 0;
		const mockClient = buildMockClient(async (request: Request): Promise<Response> => {
			requests.push(request);
			callCount++;
			if (callCount === 1) {
				// First turn: return a tool call so the agent loops for a second turn.
				// Add a delay so the test can inject a steer before the second turn.
				await delay(120);
				return {
					id: "mock-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: {
						role: "assistant" as const,
						content: [
							{
								kind: ContentKind.TOOL_CALL,
								tool_call: {
									id: "tc-1",
									name: "read_file",
									arguments: { path: "/dev/null" },
								},
							},
						],
					},
					finish_reason: { reason: "tool_calls" as const },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			}
			// Second turn: return a plain text response to finish
			return {
				id: "mock-2",
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant("Done with steered task."),
				finish_reason: { reason: "stop" as const },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		// Send start message (non-shared — this tests the initial run path only)
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Do something multi-turn",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		// Wait for the first LLM call to be in progress, then send a steer.
		// The mock client delay gives us time.
		await delay(60);
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({ kind: "steer", message: "Urgent: pivot to security review" }),
		);

		// Wait for the result
		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);
		expect(result.success).toBe(true);
		expect(result.turns).toBe(2);

		// The steer should have been drained at the start of the second turn,
		// so the second LLM request should contain the steer text.
		expect(requests.length).toBe(2);
		const secondRequest = requests[1]!;
		const allContent = JSON.stringify(secondRequest.messages);
		expect(allContent).toContain("Urgent: pivot to security review");

		await processPromise;
	}, 15_000);

	test("publishes error result when agent spec not found in genome", async () => {
		const mockClient = createMockClient("Should not reach here.");

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		// Send start message with a non-existent agent name
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "nonexistent-agent",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Do something",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);

		expect(result.kind).toBe("result");
		expect(result.success).toBe(false);
		expect(result.output).toContain("nonexistent-agent");

		// Process should exit after error
		await processPromise;
	}, 15_000);

	test("publishes error result when initial run fails", async () => {
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => {
				throw new Error("complete() should not be used in streaming mode");
			},
			stream: () => {
				const err = new Error("LLM provider unavailable");
				(err as any).retryable = false;
				throw err;
			},
		} as unknown as Client;

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Do something",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);

		expect(result.kind).toBe("result");
		expect(result.success).toBe(false);
		expect(result.output).toContain("LLM provider unavailable");

		await processPromise;
	}, 15_000);

	test("exits cleanly on shutdown signal before start", async () => {
		const mockClient = createMockClient("Done.");
		const controller = new AbortController();

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
			signal: controller.signal,
		});

		await waitForAgentReady();

		// Abort before sending any start message
		controller.abort();

		// Process should exit cleanly without throwing
		await processPromise;
	}, 5_000);

	test("publishes error result when continue fails in idle loop", async () => {
		let callCount = 0;
		const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
			callCount++;
			if (callCount === 1) {
				return {
					id: "mock-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("First response."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			}
			throw new Error("LLM provider unavailable");
		});

		const controller = new AbortController();

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const results: ResultMessage[] = [];
		await parentClient.subscribe(resultTopic, (payload) => {
			results.push(JSON.parse(payload));
		});

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
			signal: controller.signal,
		});

		await waitForAgentReady();

		// Send start message (shared: true -- agent stays alive for continue)
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "First task",
			shared: true,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		// Wait for first result (should succeed)
		await waitForResults(results, 1);
		expect(results[0]!.success).toBe(true);

		// Send continue message -- this will trigger the error
		const continueMsg = {
			kind: "continue",
			message: "Now do the second thing",
			caller: { agent_name: "root", depth: 0 },
		};
		await parentClient.publish(inboxTopic, JSON.stringify(continueMsg));

		// Wait for error result
		await waitForResults(results, 2);
		expect(results[1]!.success).toBe(false);
		expect(results[1]!.output).toContain("LLM provider unavailable");
		expect(results[1]!.kind).toBe("result");
		expect(results[1]!.handle_id).toBe(HANDLE_ID);

		// Shut down the shared agent
		controller.abort();
		await processPromise;
	}, 15_000);

	test("writes event log to per-handle path", async () => {
		const mockClient = createMockClient("Logged response.");

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Log this",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		await resultPromise;
		await processPromise;

		// Verify the log file is written at the per-handle path
		const expectedLogPath = join(genomeDir, "logs", SESSION_ID, `${HANDLE_ID}.jsonl`);
		const logExists = await exists(expectedLogPath);
		expect(logExists).toBe(true);

		// Verify it contains expected events
		const logContent = await readFile(expectedLogPath, "utf-8");
		const events = logContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const kinds = events.map((e: any) => e.kind);
		expect(kinds).toContain("session_start");
		expect(kinds).toContain("session_end");
	}, 15_000);

	test("orchestrator agent gets wait_agent and message_agent tools via spawner", async () => {
		// Add orchestrator spec to the genome alongside the existing leaf spec
		const genome = new Genome(genomeDir);
		await genome.loadFromDisk();
		await genome.addAgent(ORCHESTRATOR_AGENT_SPEC as any);

		const capturedRequests: Request[] = [];
		const mockClient = buildMockClient(async (request: Request): Promise<Response> => {
			capturedRequests.push(request);
			return {
				id: "mock-1",
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant("Delegated successfully."),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();

		// Start the orchestrator (not the leaf)
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-orchestrator",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Delegate to test-leaf",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		await resultPromise;
		await processPromise;

		// Verify the LLM request included wait_agent and message_agent tools
		expect(capturedRequests.length).toBeGreaterThan(0);
		const toolNames = capturedRequests[0]!.tools!.map((t) => t.name);
		expect(toolNames).toContain("delegate");
		expect(toolNames).toContain("wait_agent");
		expect(toolNames).toContain("message_agent");
	}, 15_000);

	test("re-spawned agent with existing log replays history as initialHistory", async () => {
		const capturedRequests: Request[] = [];
		let callCount = 0;
		const mockClient = buildMockClient(async (request: Request): Promise<Response> => {
			capturedRequests.push(request);
			callCount++;
			return {
				id: `mock-${callCount}`,
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant(`Response ${callCount}.`),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);

		// --- First run: agent runs to completion, writes log ---
		const resultPromise1 = parentClient.waitForMessage(resultTopic, 10_000);
		const processPromise1 = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();
		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		await parentClient.publish(
			inboxTopic,
			JSON.stringify(
				withResolverContext({
					kind: "start",
					handle_id: HANDLE_ID,
					agent_name: "test-leaf",
					genome_path: genomeDir,
					session_id: SESSION_ID,
					caller: { agent_name: "root", depth: 0 },
					goal: "First task",
					shared: false,
					agent_id: HANDLE_ID,
				} satisfies StartMessage),
			),
		);
		await resultPromise1;
		await processPromise1;

		// --- Second run: same handleId, existing log should be replayed ---
		const resultPromise2 = parentClient.waitForMessage(resultTopic, 10_000);
		const processPromise2 = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
		});

		await waitForAgentReady();
		await parentClient.publish(
			inboxTopic,
			JSON.stringify(
				withResolverContext({
					kind: "start",
					handle_id: HANDLE_ID,
					agent_name: "test-leaf",
					genome_path: genomeDir,
					session_id: SESSION_ID,
					caller: { agent_name: "root", depth: 0 },
					goal: "Follow-up task",
					shared: false,
					agent_id: HANDLE_ID,
				} satisfies StartMessage),
			),
		);
		await resultPromise2;
		await processPromise2;

		// The second LLM request should contain history from the first run
		expect(capturedRequests.length).toBe(2);
		const secondRequest = capturedRequests[1]!;
		const allContent = JSON.stringify(secondRequest.messages);
		expect(allContent).toContain("First task");
		expect(allContent).toContain("Response 1.");
		expect(allContent).toContain("Follow-up task");
	}, 30_000);

	test("logger receives agent-level log entries when passed to config", async () => {
		const mockClient = createMockClient("Logged agent run.");

		const logPath = join(tempDir, "agent-logs", "session.log.jsonl");
		const logger = new SessionLogger({
			logPath,
			component: "agent-process",
			sessionId: SESSION_ID,
		});

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
			logger,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-leaf",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Log this run",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		await resultPromise;
		await processPromise;
		await logger.flush();

		// Verify the structured log file was written
		const logExists = await exists(logPath);
		expect(logExists).toBe(true);

		const logContent = await readFile(logPath, "utf-8");
		const entries: LogEntry[] = logContent
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));

		// Agent creates a child logger with component "agent" — verify entries exist
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.some((e) => e.component === "agent")).toBe(true);
	}, 15_000);

	test("orchestrator with agents:[] discovers children via agent tree from rootDir", async () => {
		// Create a root directory with an orchestrator that has child agents in its subdirectory.
		// The orchestrator's agents field is empty — children are auto-discovered from the tree.
		const rootDir = join(tempDir, "root");
		const agentsDir = join(rootDir, "agents");
		const orchestratorChildDir = join(agentsDir, "test-orchestrator-tree", "agents");
		await mkdir(orchestratorChildDir, { recursive: true });

		// Write orchestrator spec — tools: [], agents: [], can_spawn: true
		const orchestratorMd = [
			"---",
			"name: test-orchestrator-tree",
			'description: "Orchestrator with tree children"',
			"model: best",
			"tools: []",
			"agents: []",
			"constraints:",
			"  max_turns: 5",
			"  can_spawn: true",
			"tags: [test]",
			"version: 1",
			"---",
			"You are an orchestrator. Delegate to your child agents.",
		].join("\n");
		await writeFile(join(agentsDir, "test-orchestrator-tree.md"), orchestratorMd);

		// Write a child agent spec under the orchestrator
		const childMd = [
			"---",
			"name: tree-child",
			'description: "A child discovered via tree"',
			"model: fast",
			"tools: [read_file]",
			"agents: []",
			"constraints:",
			"  max_turns: 5",
			"  can_spawn: false",
			"tags: [test]",
			"version: 1",
			"---",
			"You are a child agent.",
		].join("\n");
		await writeFile(join(orchestratorChildDir, "tree-child.md"), childMd);

		// Add the orchestrator to the genome so agent-process can find it
		const genome = new Genome(genomeDir);
		await genome.loadFromDisk();
		await genome.addAgent({
			name: "test-orchestrator-tree",
			description: "Orchestrator with tree children",
			model: "best",
			tools: [],
			agents: [],
			constraints: {
				max_turns: 5,
				can_spawn: true,
				can_learn: false,
				timeout_ms: 30000,
			},
			tags: ["test"],
			version: 1,
			system_prompt: "You are an orchestrator. Delegate to your child agents.",
		} as any);
		// Also add the child so it's available in the genome
		await genome.addAgent({
			name: "tree-child",
			description: "A child discovered via tree",
			model: "fast",
			tools: ["read_file"],
			agents: [],
			constraints: {
				max_turns: 5,
				can_spawn: false,
				can_learn: false,
				timeout_ms: 30000,
			},
			tags: ["test"],
			version: 1,
			system_prompt: "You are a child agent.",
		} as any);

		// The mock client response includes a delegate tool call to prove the agent GOT the delegate tool
		const mockClient = createMockClient("I can delegate to tree-child.");

		const resultTopic = agentResult(SESSION_ID, HANDLE_ID);
		const resultPromise = parentClient.waitForMessage(resultTopic, 10_000);

		const processPromise = runAgentProcess({
			busUrl: server.url,
			handleId: HANDLE_ID,
			sessionId: SESSION_ID,
			genomePath: genomeDir,
			client: mockClient,
			workDir: tempDir,
			rootDir,
		});

		await waitForAgentReady();

		const inboxTopic = agentInbox(SESSION_ID, HANDLE_ID);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: HANDLE_ID,
			agent_name: "test-orchestrator-tree",
			genome_path: genomeDir,
			session_id: SESSION_ID,
			caller: { agent_name: "root", depth: 0 },
			goal: "Delegate to tree-child",
			shared: false,
			agent_id: HANDLE_ID,
		};
		await parentClient.publish(inboxTopic, JSON.stringify(withResolverContext(startMsg)));

		// If the tree was NOT passed, this would throw "zero tools after full resolution"
		// because agents:[] + tools:[] + no workspace tools = zero tools.
		// With the tree, the orchestrator auto-discovers tree-child as a delegate.
		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);

		expect(result.kind).toBe("result");
		expect(result.success).toBe(true);
		expect(result.output).toBe("I can delegate to tree-child.");

		await processPromise;
	}, 15_000);
});
