import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentProcess } from "../../src/bus/agent-process.ts";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";
import type { SpawnAgentOptions } from "../../src/bus/spawner.ts";
import { AgentSpawner } from "../../src/bus/spawner.ts";
import type { EventMessage, ResultMessage } from "../../src/bus/types.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";

const AGENT_SPEC = {
	name: "test-leaf",
	description: "A minimal test agent",
	model: "best",
	capabilities: ["read_file"],
	constraints: {
		max_turns: 5,
		max_depth: 0,
		timeout_ms: 30000,
		can_spawn: false,
		can_learn: false,
	},
	tags: ["test"],
	version: 1,
	system_prompt: "You are a test agent. Respond with a brief answer.",
};

function createMockClient(responseText: string): Client {
	return {
		complete: async (_request: Request): Promise<Response> => ({
			id: "mock-1",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: Msg.assistant(responseText),
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
		}),
		stream: async function* () {},
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

	afterEach(async () => {
		spawner?.shutdown();
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

			const result = (await spawner.spawnAgent(opts)) as ResultMessage;

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

			const handleId = await spawner.spawnAgent(opts);

			// Returns a string handle ID (ULID), not a result
			expect(typeof handleId).toBe("string");
			expect((handleId as string).length).toBe(26); // ULID length
		}, 15_000);

		test("spawned agent receives start message with correct fields", async () => {
			const requests: Request[] = [];
			const mockClient = {
				complete: async (request: Request): Promise<Response> => {
					requests.push(request);
					return {
						id: "mock-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant("Done with hints."),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
					};
				},
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

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

			const result = (await spawner.spawnAgent(opts)) as ResultMessage;

			expect(result.output).toBe("Done with hints.");
			// Verify hints were included in the goal the agent received
			const firstRequest = requests[0]!;
			const userMessages = JSON.stringify(firstRequest.messages);
			expect(userMessages).toContain("hint one");
			expect(userMessages).toContain("hint two");
		}, 15_000);

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

			const id1 = await spawner.spawnAgent(baseOpts);
			const id2 = await spawner.spawnAgent(baseOpts);

			expect(id1).not.toBe(id2);
		}, 15_000);

		test("uses pre-assigned handleId when provided", async () => {
			const mockClient = createMockClient("Pre-assigned.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const preAssignedId = "01PREASSIGNED0000000000000";
			const result = await spawner.spawnAgent({
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
	});

	describe("waitAgent", () => {
		test("waits for a non-blocking agent to complete and returns result", async () => {
			const mockClient = createMockClient("Eventually done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawner.spawnAgent({
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

			const handleId = (await spawner.spawnAgent({
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
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(
				bus,
				server.url,
				SESSION_ID,
				createInProcessSpawnFn(mockClient),
				200, // 200ms timeout
			);

			const handleId = (await spawner.spawnAgent({
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
			const mockClient = {
				complete: async (_request: Request): Promise<Response> => {
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
				},
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawner.spawnAgent({
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
			const mockClient = {
				complete: async (_request: Request): Promise<Response> => {
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
				},
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// Spawn a shared agent (blocking waits for initial result)
			const initialResult = await spawner.spawnAgent({
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
			const mockClient = {
				complete: async (_request: Request): Promise<Response> => {
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
				},
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// Spawn non-blocking (so we can interact while it's running)
			const handleId = (await spawner.spawnAgent({
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
			const mockClient = {
				complete: async (request: Request): Promise<Response> => {
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
				},
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// First: spawn and complete a non-shared blocking agent
			const initialResult = await spawner.spawnAgent({
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

		test("throws for unknown handle ID", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			expect(() =>
				spawner.messageAgent("nonexistent", "Hello", { agent_name: "root", depth: 0 }, false),
			).toThrow(/unknown handle/i);
		});
	});

	describe("onEvent", () => {
		test("callback receives sub-agent events during execution", async () => {
			const mockClient = createMockClient("Event test done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const events: EventMessage[] = [];
			spawner.onEvent((event) => events.push(event));

			await spawner.spawnAgent({
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
			spawner.onEvent((event) => events.push(event));

			const preAssignedId = "01EVENTHANDLE000000000000A";
			await spawner.spawnAgent({
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

	describe("access control", () => {
		test("waitAgent rejects non-owner on non-shared handle", async () => {
			const mockClient = createMockClient("Done.");
			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawner.spawnAgent({
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

			const handleId = (await spawner.spawnAgent({
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

			const handleId = (await spawner.spawnAgent({
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

			const handleId = (await spawner.spawnAgent({
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
			const mockClient = {
				complete: async (_request: Request): Promise<Response> => {
					callCount++;
					return {
						id: `mock-${callCount}`,
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: Msg.assistant(`Response ${callCount}.`),
						finish_reason: { reason: "stop" },
						usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
					};
				},
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			// Spawn shared, blocking to get initial result
			await spawner.spawnAgent({
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

			const handleId = (await spawner.spawnAgent({
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

	describe("shutdown", () => {
		test("kills all running agent processes", async () => {
			let resolveCall: (() => void) | null = null;
			const mockClient = {
				complete: async (_request: Request): Promise<Response> => {
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
				},
				stream: async function* () {},
				providers: () => ["anthropic"],
			} as unknown as Client;

			spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

			const handleId = (await spawner.spawnAgent({
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
