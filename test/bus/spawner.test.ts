import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { runAgentProcess } from "../../src/bus/agent-process.ts";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";
import type { SpawnAgentOptions } from "../../src/bus/spawner.ts";
import { AgentSpawner } from "../../src/bus/spawner.ts";
import { agentInbox, agentReady } from "../../src/bus/topics.ts";
import type { EventMessage, ResultMessage } from "../../src/bus/types.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";

const AGENT_SPEC = {
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
			yield { type: "text_start" as const };
			yield { type: "text_delta" as const, delta: responseText };
			yield { type: "text_end" as const };
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

/** Create a SpawnFn that runs runAgentProcess in-process with a mock LLM client */
function createInProcessSpawnFn(client: Client) {
	return (_handleId: string, env: Record<string, string>) => {
		const controller = new AbortController();
		const promise = runAgentProcess({
			busUrl: env.SPROUT_BUS_URL!,
			handleId: env.SPROUT_HANDLE_ID!,
			sessionId: env.SPROUT_SESSION_ID!,
			genomePath: env.SPROUT_GENOME_PATH!,
			client,
			workDir: env.SPROUT_WORK_DIR!,
			signal: controller.signal,
		});
		return {
			kill: () => controller.abort(),
			exited: promise.then(() => 0),
		};
	};
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

describe("AgentSpawner", () => {
	let server: BusServer;
	let bus: BusClient;
	let tempDir: string;
	let genomeDir: string;
	let spawner: AgentSpawner;

	const SESSION_ID = "spawner-test-session";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-spawner-"));
		genomeDir = join(tempDir, "genome");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.addAgent(AGENT_SPEC as any);

		server = new BusServer({ port: 0 });
		await server.start();

		bus = new BusClient(server.url);
		await bus.connect();
	});

	function spawnWithResolver(opts: SpawnAgentOptions) {
		return spawner.spawnAgent({
			...opts,
			providerIdOverride: TEST_PROVIDER_ID,
			resolverSettings: TEST_RESOLVER_SETTINGS,
		});
	}

	afterEach(async () => {
		spawner?.shutdown();
		// Wait for all agent processes to fully exit before deleting the temp dir.
		// Without this, in-flight mkdir calls inside runAgentProcess race with rm.
		if (spawner) {
			const exits = spawner
				.getHandles()
				.map((id) => spawner.getHandle(id)?.process.exited)
				.filter(Boolean);
			await Promise.allSettled(exits);
		}
		await bus.disconnect();
		await server.stop();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("spawnAgent", () => {
		test("blocking spawn runs agent and returns result", async () => {
			const mockClient = createMockClient("Blocking result.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const opts: SpawnAgentOptions = {
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Do the thing",
				blocking: true,
				shared: false,
				workDir: tempDir,
			};

			const result = (await spawnWithResolver(opts)) as ResultMessage;

			expect(result.output).toBe("Blocking result.");
			expect(result.success).toBe(true);
			expect(result.turns).toBe(1);
		}, 15_000);

		test("non-blocking spawn returns handle ID immediately", async () => {
			const mockClient = createMockClient("Background result.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const opts: SpawnAgentOptions = {
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Do the thing in background",
				blocking: false,
				shared: false,
				workDir: tempDir,
			};

			const handleId = await spawnWithResolver(opts);

			// Returns a string handle ID (ULID), not a result
			expect(typeof handleId).toBe("string");
			expect((handleId as string).length).toBe(26); // ULID length
		}, 15_000);

		test("spawned agent receives start message with correct fields", async () => {
			const requests: Request[] = [];
			const mockClient = buildMockClient(async (request: Request): Promise<Response> => {
				requests.push(request);
				return {
					id: "mock-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("Done with hints."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			});

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const opts: SpawnAgentOptions = {
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Test with hints",
				hints: ["hint one", "hint two"],
				blocking: true,
				shared: false,
				workDir: tempDir,
			};

			const result = (await spawnWithResolver(opts)) as ResultMessage;

			expect(result.output).toBe("Done with hints.");
			// Verify hints were included in the goal the agent received
			const firstRequest = requests[0]!;
			const userMessages = JSON.stringify(firstRequest.messages);
			expect(userMessages).toContain("hint one");
			expect(userMessages).toContain("hint two");
		}, 15_000);

		test("propagates eval mode in the start message", async () => {
			const handleId = "01SPAWNERATIFTEST000000000";
			const childBus = new BusClient(server.url);
			const observerBus = new BusClient(server.url);
			await childBus.connect();
			await observerBus.connect();
			let readyTimer: ReturnType<typeof setInterval> | undefined;
			try {
				spawner = new AgentSpawner(bus, server.url, SESSION_ID, (_spawnedHandleId) => {
					readyTimer = setInterval(() => {
						void childBus.publish(agentReady(SESSION_ID, handleId), JSON.stringify({ ok: true }));
					}, 10);
					return {
						kill: () => {
							if (readyTimer) clearInterval(readyTimer);
						},
						exited: Promise.resolve(0),
					};
				});

				const inboxPromise = observerBus.waitForMessage(agentInbox(SESSION_ID, handleId), 5_000);

				const spawnPromise = spawner.spawnAgent({
					agentName: "test-leaf",
					genomePath: genomeDir,
					caller: { agent_name: "root", depth: 0 },
					goal: "Benchmark task",
					blocking: false,
					shared: false,
					workDir: tempDir,
					handleId,
					evalMode: true,
					providerIdOverride: TEST_PROVIDER_ID,
					resolverSettings: TEST_RESOLVER_SETTINGS,
				});

				await expect(spawnPromise).resolves.toBe(handleId);

				const startMessage = JSON.parse(await inboxPromise);
				if (readyTimer) clearInterval(readyTimer);
				expect(startMessage.eval_mode).toBe(true);
			} finally {
				if (readyTimer) clearInterval(readyTimer);
				await observerBus.disconnect();
				await childBus.disconnect();
			}
		});

		test("generates unique handle IDs for each spawn", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const baseOpts: SpawnAgentOptions = {
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Task",
				blocking: false,
				shared: false,
				workDir: tempDir,
			};

			const id1 = await spawnWithResolver(baseOpts);
			const id2 = await spawnWithResolver(baseOpts);

			expect(id1).not.toBe(id2);
		}, 15_000);

		test("uses pre-assigned handleId when provided", async () => {
			const mockClient = createMockClient("Pre-assigned.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const preAssignedId = "01PREASSIGNED0000000000000";
			const result = await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Use my handle ID",
				blocking: true,
				shared: false,
				workDir: tempDir,
				handleId: preAssignedId,
			});

			const resultMsg = result as ResultMessage;
			expect(resultMsg.handle_id).toBe(preAssignedId);
			expect(resultMsg.success).toBe(true);
		}, 15_000);

		test("mnemonicName is stored on the handle", async () => {
			const mockClient = createMockClient("Named agent result.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const opts: SpawnAgentOptions = {
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Do a named thing",
				blocking: false,
				shared: false,
				workDir: tempDir,
				mnemonicName: "Curie",
			};

			const handleId = (await spawnWithResolver(opts)) as string;
			const handle = spawner.getHandle(handleId);
			expect(handle).toBeDefined();
			expect(handle!.mnemonicName).toBe("Curie");
		}, 15_000);
	});

	describe("waitAgent", () => {
		test("waits for a non-blocking agent to complete and returns result", async () => {
			const mockClient = createMockClient("Eventually done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Async task",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			const result = await spawner.waitAgent(handleId);

			expect(result.output).toBe("Eventually done.");
			expect(result.success).toBe(true);
		}, 15_000);

		test("returns cached result if agent already completed", async () => {
			const mockClient = createMockClient("Already done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Quick task",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// First wait gets the result
			const result1 = await spawner.waitAgent(handleId);
			// Second wait returns cached result
			const result2 = await spawner.waitAgent(handleId);

			expect(result1.output).toBe("Already done.");
			expect(result2.output).toBe("Already done.");
			expect(result1).toEqual(result2);
		}, 15_000);

		test("throws for unknown handle ID", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			expect(() => spawner.waitAgent("nonexistent-handle")).toThrow(/unknown handle/i);
		});

		test("rejects after custom waitTimeoutMs", async () => {
			// Mock client that blocks forever (agent never completes)
			const mockClient = {
				complete: async (_request: Request): Promise<Response> => {
					await new Promise(() => {}); // never resolves
					throw new Error("unreachable");
				},
				stream: async function* () {
					yield { type: "stream_start" as const };
					await new Promise(() => {}); // never resolves
				},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(
				bus,
				server.url,
				SESSION_ID,
				createInProcessSpawnFn(mockClient),
				200, // 200ms timeout
			);

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Task that never finishes",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			const start = Date.now();
			await expect(spawner.waitAgent(handleId)).rejects.toThrow(/timed out/i);
			const elapsed = Date.now() - start;

			// Should reject close to 200ms, not 30s or 120s
			expect(elapsed).toBeLessThan(2000);
			expect(elapsed).toBeGreaterThanOrEqual(150);

			// Kill the forever-blocking agent and wait for it to exit so
			// afterEach cleanup doesn't race with its internal bus client
			spawner.shutdown();
			await spawner.getHandle(handleId)!.process.exited;
		}, 15_000);

		test("multiple concurrent waitAgent calls all resolve with the same result", async () => {
			let resolveFirstCall: (() => void) | null = null;
			const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
				// Block until released so we can set up multiple waiters
				await new Promise<void>((resolve) => {
					resolveFirstCall = resolve;
				});
				return {
					id: "mock-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("Shared result."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			});

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Concurrent wait task",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// Set up multiple concurrent waiters before the result arrives
			const wait1 = spawner.waitAgent(handleId);
			const wait2 = spawner.waitAgent(handleId);
			const wait3 = spawner.waitAgent(handleId);

			// Wait for the mock client to be entered before releasing it
			while (!resolveFirstCall) await delay(10);
			(resolveFirstCall as () => void)();

			const [r1, r2, r3] = await Promise.all([wait1, wait2, wait3]);

			expect(r1.output).toBe("Shared result.");
			expect(r2.output).toBe("Shared result.");
			expect(r3.output).toBe("Shared result.");
		}, 15_000);
	});

	describe("messageAgent", () => {
		test("sends continue message to idle shared agent and waits for result", async () => {
			let callCount = 0;
			const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
				callCount++;
				const text = callCount === 1 ? "First." : "Continued.";
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant(text),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			});

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// Spawn a shared agent (blocking waits for initial result)
			const initialResult = await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Initial task",
				blocking: true,
				shared: true,
				workDir: tempDir,
			});
			expect((initialResult as ResultMessage).output).toBe("First.");

			// Get the handle ID from the spawner's handles
			const handles = spawner.getHandles();
			expect(handles.length).toBe(1);
			const handleId = handles[0]!;

			// Send continue message (blocking = true waits for result)
			const continueResult = await spawner.messageAgent(
				handleId,
				"Do the next thing",
				{ agent_name: "root", depth: 0 },
				true,
			);

			expect(continueResult!.output).toBe("Continued.");
		}, 15_000);

		test("sends steer message to running agent (non-blocking)", async () => {
			let resolveFirstCall: (() => void) | null = null;
			let callCount = 0;
			const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// First call takes a while so we can steer it
					await new Promise<void>((resolve) => {
						resolveFirstCall = resolve;
					});
				}
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant(`Response ${callCount}.`),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			});

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// Spawn non-blocking (so we can interact while it's running)
			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Long running task",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// Wait for agent to enter the mock client (blocking on first call)
			while (!resolveFirstCall) await delay(10);

			// Send steer (non-blocking) -- this should not throw even though agent is running
			const steerResult = await spawner.messageAgent(
				handleId,
				"Change priority",
				{ agent_name: "root", depth: 0 },
				false,
			);
			expect(steerResult).toBeUndefined();

			// Let the first call complete
			(resolveFirstCall as () => void)();

			// Wait for the agent to finish
			const result = await spawner.waitAgent(handleId);
			expect(result.success).toBe(true);
		}, 15_000);

		test("re-spawns completed agent and returns result with history", async () => {
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

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// First: spawn and complete a non-shared blocking agent
			const initialResult = await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Initial task",
				blocking: true,
				shared: false,
				workDir: tempDir,
			});
			expect((initialResult as ResultMessage).output).toBe("Response 1.");

			const handleId = spawner.getHandles()[0]!;
			const handle = spawner.getHandle(handleId)!;
			// Wait for the process to exit
			await handle.process.exited;
			expect(handle.status).toBe("completed");

			// Second: messageAgent on the completed handle should re-spawn
			const continueResult = await spawner.messageAgent(
				handleId,
				"Follow-up message",
				{ agent_name: "root", depth: 0 },
				true,
			);

			expect(continueResult!.output).toBe("Response 2.");

			// The second LLM request should contain history from the first run
			expect(capturedRequests.length).toBe(2);
			const secondRequest = capturedRequests[1]!;
			const allContent = JSON.stringify(secondRequest.messages);
			expect(allContent).toContain("Initial task");
			expect(allContent).toContain("Response 1.");
			expect(allContent).toContain("Follow-up message");
		}, 30_000);

		test("re-spawn preserves explicit agent_id across runs", async () => {
			let callCount = 0;
			const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
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

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = "01RESPAWNAGENTID0000000000000";
			const childAgentId = "01CHILDAGENTID00000000000000";

			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Initial task",
				blocking: true,
				shared: false,
				workDir: tempDir,
				handleId,
				agentId: childAgentId,
			});

			const firstHandle = spawner.getHandle(handleId)!;
			await firstHandle.process.exited;

			await spawner.messageAgent(
				handleId,
				"Follow-up message",
				{ agent_name: "root", depth: 0 },
				true,
			);

			const logPath = join(genomeDir, "logs", SESSION_ID, `${handleId}.jsonl`);
			const raw = await readFile(logPath, "utf8");
			const events = raw
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as { kind: string; agent_id?: string });
			const sessionStarts = events.filter((event) => event.kind === "session_start");

			expect(sessionStarts.length).toBeGreaterThanOrEqual(2);
			for (const event of sessionStarts) {
				expect(event.agent_id).toBe(childAgentId);
			}
		}, 30_000);

		test("throws for unknown handle ID", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			expect(() =>
				spawner.messageAgent("nonexistent", "Hello", { agent_name: "root", depth: 0 }, false),
			).toThrow(/unknown handle/i);
		});
	});

	describe("subscribeSessionEvents", () => {
		test("callback receives sub-agent events during execution", async () => {
			const mockClient = createMockClient("Event test done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const events: EventMessage[] = [];
			await spawner.subscribeSessionEvents((event) => events.push(event));

			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Say hello",
				hints: [],
				blocking: true,
				shared: false,
				workDir: tempDir,
			});

			// The agent emits at least session_start and session_end
			expect(events.length).toBeGreaterThan(0);
			expect(events[0]!.kind).toBe("event");
			expect(events[0]!.event).toBeDefined();

			// Verify we got session lifecycle events
			const eventKinds = events.map((e) => e.event.kind);
			expect(eventKinds).toContain("session_start");
			expect(eventKinds).toContain("session_end");
		}, 15_000);

		test("events include correct handle_id", async () => {
			const mockClient = createMockClient("Handle ID test.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const events: EventMessage[] = [];
			await spawner.subscribeSessionEvents((event) => events.push(event));

			const preAssignedId = "01EVENTHANDLE000000000000A";
			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Handle ID check",
				blocking: true,
				shared: false,
				workDir: tempDir,
				handleId: preAssignedId,
			});

			expect(events.length).toBeGreaterThan(0);
			for (const event of events) {
				expect(event.handle_id).toBe(preAssignedId);
			}
		}, 15_000);
	});

	describe("updateSessionId", () => {
		test("agents spawned after update use new session ID topic", async () => {
			const mockClient = createMockClient("After update.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const newSessionId = "spawner-test-session-v2";

			const events: EventMessage[] = [];
			await spawner.subscribeSessionEvents((event) => events.push(event));

			// Update session ID and resubscribe
			await spawner.updateSessionId(newSessionId);

			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Post-update task",
				blocking: true,
				shared: false,
				workDir: tempDir,
			});

			// Events should arrive via the new session-wide topic
			expect(events.length).toBeGreaterThan(0);
			const eventKinds = events.map((e) => e.event.kind);
			expect(eventKinds).toContain("session_start");
			expect(eventKinds).toContain("session_end");
		}, 15_000);
	});

	describe("subscribeSessionEvents multi-agent", () => {
		test("events from concurrent agents arrive at a single subscription", async () => {
			const mockClient = createMockClient("Multi-agent test.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const events: EventMessage[] = [];
			await spawner.subscribeSessionEvents((event) => events.push(event));

			const handleA = "01MULTIAGENT_A0000000000000";
			const handleB = "01MULTIAGENT_B0000000000000";

			// Spawn two agents concurrently to test interleaved delivery
			await Promise.all([
				spawnWithResolver({
					agentName: "test-leaf",
					genomePath: genomeDir,
					caller: { agent_name: "root", depth: 0 },
					goal: "Agent A task",
					blocking: true,
					shared: false,
					workDir: tempDir,
					handleId: handleA,
				}),
				spawnWithResolver({
					agentName: "test-leaf",
					genomePath: genomeDir,
					caller: { agent_name: "root", depth: 0 },
					goal: "Agent B task",
					blocking: true,
					shared: false,
					workDir: tempDir,
					handleId: handleB,
				}),
			]);

			// Events from BOTH agents should arrive via the single subscription
			const handlesInEvents = new Set(events.map((e) => e.handle_id));
			expect(handlesInEvents.has(handleA)).toBe(true);
			expect(handlesInEvents.has(handleB)).toBe(true);

			// Both should have session_start and session_end
			const agentAEvents = events.filter((e) => e.handle_id === handleA);
			const agentBEvents = events.filter((e) => e.handle_id === handleB);
			expect(agentAEvents.map((e) => e.event.kind)).toContain("session_start");
			expect(agentBEvents.map((e) => e.event.kind)).toContain("session_start");
		}, 30_000);
	});

	describe("subscribeSessionEvents idempotency", () => {
		test("second call is a no-op (does not duplicate events)", async () => {
			const mockClient = createMockClient("Idempotent test.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const events1: EventMessage[] = [];
			const events2: EventMessage[] = [];
			await spawner.subscribeSessionEvents((event) => events1.push(event));
			// Second call should be ignored
			await spawner.subscribeSessionEvents((event) => events2.push(event));

			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Single callback test",
				blocking: true,
				shared: false,
				workDir: tempDir,
			});

			// First callback should receive events
			expect(events1.length).toBeGreaterThan(0);
			// Second callback should NOT receive events (was ignored)
			expect(events2.length).toBe(0);
		}, 15_000);
	});

	describe("access control", () => {
		test("waitAgent rejects non-owner on non-shared handle", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Work",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// Wait for the agent to complete so we have a cached result
			await spawner.waitAgent(handleId);

			// A different caller should be rejected
			expect(() => spawner.waitAgent(handleId, { agent_name: "other-agent", depth: 1 })).toThrow(
				/not shared/,
			);
		}, 15_000);

		test("waitAgent allows owner on non-shared handle", async () => {
			const mockClient = createMockClient("Owner result.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Work",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// Owner should be allowed
			const result = await spawner.waitAgent(handleId, { agent_name: "root", depth: 0 });
			expect(result.output).toBe("Owner result.");
		}, 15_000);

		test("waitAgent allows non-owner on shared handle", async () => {
			const mockClient = createMockClient("Shared result.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Work",
				blocking: false,
				shared: true,
				workDir: tempDir,
			})) as string;

			// Non-owner should be allowed on shared handle
			const result = await spawner.waitAgent(handleId, { agent_name: "other-agent", depth: 1 });
			expect(result.output).toBe("Shared result.");
		}, 15_000);

		test("messageAgent rejects non-owner on non-shared handle", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Work",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// Wait for completion so the handle is in a messageable state
			await spawner.waitAgent(handleId);

			// A different caller should be rejected
			expect(() =>
				spawner.messageAgent(handleId, "hello", { agent_name: "other-agent", depth: 1 }, true),
			).toThrow(/not shared/);
		}, 15_000);

		test("messageAgent allows non-owner on shared handle", async () => {
			let callCount = 0;
			const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
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

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// Spawn shared, blocking to get initial result
			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Work",
				blocking: true,
				shared: true,
				workDir: tempDir,
			});

			const handleId = spawner.getHandles()[0]!;

			// Non-owner should be allowed on shared handle
			const result = await spawner.messageAgent(
				handleId,
				"continue",
				{ agent_name: "other-agent", depth: 1 },
				true,
			);
			expect(result!.output).toBe("Response 2.");
		}, 15_000);

		test("ownerId is set on AgentHandle from caller", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "my-parent", depth: 2 },
				goal: "Work",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			const handle = spawner.getHandle(handleId);
			expect(handle).toBeDefined();
			expect(handle!.ownerId).toBe("my-parent");
		}, 15_000);
	});

	describe("registerCompletedHandle", () => {
		test("registers a handle with completed status and cached result", () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const result: ResultMessage = {
				kind: "result",
				handle_id: "01RESUMED00000000000000000",
				output: "Previously completed output",
				success: true,
				stumbles: 0,
				turns: 3,
				timed_out: false,
			};

			spawner.registerCompletedHandle("01RESUMED00000000000000000", result, "root");

			const handle = spawner.getHandle("01RESUMED00000000000000000");
			expect(handle).toBeDefined();
			expect(handle!.status).toBe("completed");
			expect(handle!.result).toEqual(result);
			expect(handle!.ownerId).toBe("root");
		});

		test("waitAgent returns pre-registered result immediately", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const result: ResultMessage = {
				kind: "result",
				handle_id: "01WAITRESUME000000000000000",
				output: "Cached from previous session",
				success: true,
				stumbles: 1,
				turns: 5,
				timed_out: false,
			};

			spawner.registerCompletedHandle("01WAITRESUME000000000000000", result, "root");

			const waited = await spawner.waitAgent("01WAITRESUME000000000000000");
			expect(waited).toEqual(result);
		});

		test("getHandles includes pre-registered handles", () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const result: ResultMessage = {
				kind: "result",
				handle_id: "01HANDLELIST0000000000000000",
				output: "Listed",
				success: true,
				stumbles: 0,
				turns: 1,
				timed_out: false,
			};

			spawner.registerCompletedHandle("01HANDLELIST0000000000000000", result, "root");

			expect(spawner.getHandles()).toContain("01HANDLELIST0000000000000000");
		});
	});

	describe("clearHandles", () => {
		test("clears all handles and empties the map", async () => {
			const mockClient = createMockClient("Clear test.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Task to clear",
				blocking: true,
				shared: false,
				workDir: tempDir,
			});

			expect(spawner.getHandles().length).toBe(1);

			await spawner.clearHandles();

			expect(spawner.getHandles().length).toBe(0);
		}, 15_000);

		test("throws unknown handle after clearHandles", async () => {
			const mockClient = createMockClient("Clear test.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Task to clear",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			await spawner.waitAgent(handleId);
			await spawner.clearHandles();

			expect(() => spawner.waitAgent(handleId)).toThrow(/unknown handle/i);
		}, 15_000);

		test("rejects pending waitAgent promises immediately", async () => {
			// Mock client that blocks forever so the agent never completes
			const mockClient = {
				complete: async (_request: Request): Promise<Response> => {
					await new Promise(() => {}); // never resolves
					throw new Error("unreachable");
				},
				stream: async function* () {
					yield { type: "stream_start" as const };
					await new Promise(() => {}); // never resolves
				},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Blocking task",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// Start waiting (will never resolve on its own since agent blocks)
			const waitPromise = spawner.waitAgent(handleId);

			// clearHandles should reject the pending waiter promptly
			const start = Date.now();
			await spawner.clearHandles();
			await expect(waitPromise).rejects.toThrow(/session cleared/i);
			const elapsed = Date.now() - start;

			// Should resolve almost immediately, not after the 15min timeout
			expect(elapsed).toBeLessThan(2000);
		}, 15_000);
	});

	describe("updateSessionId unsubscribes old topic", () => {
		test("events on old session topic no longer reach callback after update", async () => {
			const mockClient = createMockClient("Old topic test.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const events: EventMessage[] = [];
			await spawner.subscribeSessionEvents((event) => events.push(event));

			// Spawn an agent on the original session to confirm subscription works
			await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Before update",
				blocking: true,
				shared: false,
				workDir: tempDir,
			});

			const eventsBeforeUpdate = events.length;
			expect(eventsBeforeUpdate).toBeGreaterThan(0);

			// Update session ID (unsubscribes old topic, subscribes new)
			await spawner.updateSessionId("new-session-id-test");

			// Manually publish to the OLD session topic — should NOT arrive
			const oldTopic = `session/${SESSION_ID}/events`;
			await bus.publish(
				oldTopic,
				JSON.stringify({
					kind: "event",
					handle_id: "ghost",
					event: { kind: "session_start", agent_id: "ghost", depth: 1, data: {} },
				}),
			);

			// Give time for any message delivery
			await delay(100);

			// No new events should have arrived from the old topic
			expect(events.length).toBe(eventsBeforeUpdate);
		}, 15_000);
	});

	describe("shutdown", () => {
		test("kills all running agent processes", async () => {
			let resolveCall: (() => void) | null = null;
			const mockClient = buildMockClient(async (_request: Request): Promise<Response> => {
				// Block indefinitely so the agent stays running
				await new Promise<void>((resolve) => {
					resolveCall = resolve;
				});
				return {
					id: "mock-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("Done."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			});

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawnWithResolver({
				agentName: "test-leaf",
				genomePath: genomeDir,
				caller: { agent_name: "root", depth: 0 },
				goal: "Long running task",
				blocking: false,
				shared: false,
				workDir: tempDir,
			})) as string;

			// Wait for agent to enter the mock client
			while (!resolveCall) await delay(10);

			// Shutdown should kill all processes
			spawner.shutdown();

			// Unblock the mock so the process can actually exit
			(resolveCall as () => void)();

			// The handle should reflect the shutdown
			const handle = spawner.getHandle(handleId);
			expect(handle).toBeDefined();
		}, 15_000);
	});
});
