import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exists, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentProcess } from "../../src/bus/agent-process.ts";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";
import { agentEvents, agentInbox, agentResult } from "../../src/bus/topics.ts";
import type { ResultMessage, StartMessage } from "../../src/bus/types.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { ContentKind, Msg } from "../../src/llm/types.ts";

// Minimal agent spec for testing -- leaf agent with no delegation
const MINIMAL_AGENT_SPEC = {
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

/** Create a mock LLM client that returns a canned text response */
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

function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runAgentProcess", () => {
	let server: BusServer;
	let parentClient: BusClient;
	let tempDir: string;
	let genomeDir: string;

	const SESSION_ID = "test-session-001";
	const HANDLE_ID = "test-handle-001";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-agent-proc-"));
		genomeDir = join(tempDir, "genome");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.addAgent(MINIMAL_AGENT_SPEC as any);

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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

		await resultPromise;
		await delay(100);

		expect(collectedEvents.length).toBeGreaterThan(0);

		const parsed = collectedEvents.map((e) => JSON.parse(e));
		const kinds = parsed.map((e) => e.event.kind);
		expect(kinds).toContain("session_start");
		expect(kinds).toContain("session_end");

		await processPromise;
	}, 15_000);

	test("shared agent handles continue message after initial run", async () => {
		let callCount = 0;
		const mockClient = {
			complete: async (_request: Request): Promise<Response> => {
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
			},
			stream: async function* () {},
			providers: () => ["anthropic"],
		} as unknown as Client;

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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

		// Wait for first result
		await delay(500);
		expect(results.length).toBe(1);
		expect(results[0]!.output).toBe("First response.");

		// Send continue message
		const continueMsg = {
			kind: "continue",
			message: "Now do the second thing",
			caller: { agent_name: "root", depth: 0 },
		};
		await parentClient.publish(inboxTopic, JSON.stringify(continueMsg));

		// Wait for second result
		await delay(500);
		expect(results.length).toBe(2);
		expect(results[1]!.output).toBe("Continued response.");

		// Shut down the shared agent
		controller.abort();
		await processPromise;
	}, 15_000);

	test("queues continue messages that arrive while processing", async () => {
		let callCount = 0;
		const mockClient = {
			complete: async (_request: Request): Promise<Response> => {
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
					await delay(300); // Slow enough for second continue to arrive
				}
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant(responses[callCount] ?? `Response ${callCount}`),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			},
			stream: async function* () {},
			providers: () => ["anthropic"],
		} as unknown as Client;

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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

		// Wait for initial result
		await delay(500);
		expect(results.length).toBe(1);
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
		await delay(50); // Small gap to ensure ordering
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({
				kind: "continue",
				message: "Second continue",
				caller: { agent_name: "root", depth: 0 },
			}),
		);

		// Wait for both results (300ms for first + processing for second)
		await delay(1000);
		expect(results.length).toBe(3); // initial + 2 continues
		expect(results[1]!.output).toBe("Continue-1 response.");
		expect(results[2]!.output).toBe("Continue-2 response.");

		controller.abort();
		await processPromise;
	}, 15_000);

	test("steer messages are queued and applied in next continue cycle", async () => {
		const requests: Request[] = [];
		let callCount = 0;
		const mockClient = {
			complete: async (request: Request): Promise<Response> => {
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
			},
			stream: async function* () {},
			providers: () => ["anthropic"],
		} as unknown as Client;

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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

		// Wait for first result
		await delay(500);
		expect(results.length).toBe(1);

		// Send steer while idle — should be queued for next continue
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({ kind: "steer", message: "Priority change: focus on tests" }),
		);
		await delay(100);

		// Send continue — the steer should be injected into the conversation
		await parentClient.publish(
			inboxTopic,
			JSON.stringify({
				kind: "continue",
				message: "Continue working",
				caller: { agent_name: "root", depth: 0 },
			}),
		);

		await delay(500);
		expect(results.length).toBe(2);

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
		const mockClient = {
			complete: async (request: Request): Promise<Response> => {
				requests.push(request);
				callCount++;
				if (callCount === 1) {
					// First turn: return a tool call so the agent loops for a second turn.
					// Add a delay so the test can inject a steer before the second turn.
					await delay(200);
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
			},
			stream: async function* () {},
			providers: () => ["anthropic"],
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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

		// Wait for the first LLM call to be in progress, then send a steer.
		// The 200ms delay in the mock client gives us time.
		await delay(150);
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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

		const rawResult = await resultPromise;
		const result: ResultMessage = JSON.parse(rawResult);

		expect(result.kind).toBe("result");
		expect(result.success).toBe(false);
		expect(result.output).toContain("nonexistent-agent");

		// Process should exit after error
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

		await delay(100);

		// Abort before sending any start message
		controller.abort();

		// Process should exit cleanly without throwing
		await processPromise;
	}, 5_000);

	test("publishes error result when continue fails in idle loop", async () => {
		let callCount = 0;
		const mockClient = {
			complete: async (_request: Request): Promise<Response> => {
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
			},
			stream: async function* () {},
			providers: () => ["anthropic"],
		} as unknown as Client;

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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

		// Wait for first result (should succeed)
		await delay(500);
		expect(results.length).toBe(1);
		expect(results[0]!.success).toBe(true);

		// Send continue message -- this will trigger the error
		const continueMsg = {
			kind: "continue",
			message: "Now do the second thing",
			caller: { agent_name: "root", depth: 0 },
		};
		await parentClient.publish(inboxTopic, JSON.stringify(continueMsg));

		// Wait for error result
		await delay(500);
		expect(results.length).toBe(2);
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

		await delay(100);

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
		};
		await parentClient.publish(inboxTopic, JSON.stringify(startMsg));

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
});
