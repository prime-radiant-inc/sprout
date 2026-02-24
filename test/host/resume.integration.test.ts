import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/host/event-bus.ts";
import { replayEventLog } from "../../src/host/resume.ts";
import { type AgentFactory, SessionController } from "../../src/host/session-controller.ts";
import type { Message } from "../../src/llm/types.ts";

describe("Resume integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-resume-int-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("replayEventLog reconstructs history from SessionController events", async () => {
		const sessionsDir = join(tempDir, "sessions");

		// Factory that simulates a real agent: emits perceive, plan_end, primitive_end
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					// Simulate perceive
					options.events.emitEvent("perceive", "root", 0, { goal });

					// Simulate plan_end with assistant message (tool call)
					const assistantMessage: Message = {
						role: "assistant",
						content: [
							{ kind: "text", text: "I'll run a command." },
							{
								kind: "tool_use",
								tool_call: {
									id: "call_1",
									name: "exec",
									arguments: { command: "echo hello" },
								},
							},
						],
					};
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						assistant_message: assistantMessage,
						context_tokens: 1000,
						context_window_size: 200000,
					});

					// Simulate primitive_end with tool result
					const toolResultMessage: Message = {
						role: "tool",
						content: [
							{
								kind: "tool_result",
								tool_result: {
									tool_call_id: "call_1",
									content: "hello\n",
									is_error: false,
								},
							},
						],
					};
					options.events.emitEvent("primitive_end", "root", 0, {
						name: "exec",
						success: true,
						output: "hello\n",
						tool_result_message: toolResultMessage,
					});

					// Simulate final plan_end (no tool calls, text response)
					const finalMessage: Message = {
						role: "assistant",
						content: [{ kind: "text", text: "Done! The command output was 'hello'." }],
					};
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 2,
						assistant_message: finalMessage,
						context_tokens: 2000,
						context_window_size: 200000,
					});

					// Also emit a depth-1 event that should be IGNORED by resume
					options.events.emitEvent("plan_end", "child", 1, {
						turn: 1,
						assistant_message: {
							role: "assistant",
							content: [{ kind: "text", text: "subagent response" }],
						},
					});

					// Allow async log writes to flush
					await new Promise((r) => setTimeout(r, 100));

					return {
						output: "Done!",
						success: true,
						stumbles: 0,
						turns: 2,
						timed_out: false,
					};
				},
			} as any,
			learnProcess: null,
		});

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			factory,
		});

		await controller.submitGoal("Run echo hello");

		// Wait for log writes
		await new Promise((r) => setTimeout(r, 500));

		// Now replay the event log
		const logPath = join(sessionsDir, `${controller.sessionId}.jsonl`);
		const history = await replayEventLog(logPath);

		// Expected history:
		// 1. User message from perceive (goal)
		// 2. Assistant message from plan_end (tool call)
		// 3. Tool result from primitive_end
		// 4. Assistant message from final plan_end
		// (depth-1 events should be excluded)
		expect(history).toHaveLength(4);
		expect(history[0]!.role).toBe("user");
		expect(history[1]!.role).toBe("assistant");
		expect(history[2]!.role).toBe("tool");
		expect(history[3]!.role).toBe("assistant");

		// Verify content
		const userMsg = history[0]!;
		expect((userMsg.content as any[])[0].text).toBe("Run echo hello");

		const assistantMsg = history[1]!;
		expect(assistantMsg.content.some((c) => c.kind === "tool_use")).toBe(true);

		const toolMsg = history[2]!;
		expect(toolMsg.content[0]!.kind).toBe("tool_result");
	});

	test("resumed session passes correct history to new agent", async () => {
		const sessionsDir = join(tempDir, "sessions");

		// First run: generate events
		const firstFactory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					options.events.emitEvent("perceive", "root", 0, { goal });
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						assistant_message: {
							role: "assistant",
							content: [{ kind: "text", text: "First response" }],
						},
					});
					await new Promise((r) => setTimeout(r, 200));
					return {
						output: "done",
						success: true,
						stumbles: 0,
						turns: 1,
						timed_out: false,
					};
				},
			} as any,
			learnProcess: null,
		});

		const bus1 = new EventBus();
		const ctrl1 = new SessionController({
			bus: bus1,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			factory: firstFactory,
		});

		await ctrl1.submitGoal("first goal");
		await new Promise((r) => setTimeout(r, 500));

		// Replay the log
		const logPath = join(sessionsDir, `${ctrl1.sessionId}.jsonl`);
		const history = await replayEventLog(logPath);

		// Second run: resume with captured history
		let capturedHistory: Message[] | undefined;
		const secondFactory: AgentFactory = async (options) => {
			capturedHistory = options.initialHistory;
			return {
				agent: {
					steer() {},
					async run() {
						return {
							output: "done",
							success: true,
							stumbles: 0,
							turns: 1,
							timed_out: false,
						};
					},
				} as any,
				learnProcess: null,
			};
		};

		const bus2 = new EventBus();
		const ctrl2 = new SessionController({
			bus: bus2,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			sessionId: ctrl1.sessionId,
			initialHistory: history,
			factory: secondFactory,
		});

		await ctrl2.submitGoal("continue");

		expect(capturedHistory).toBeDefined();
		expect(capturedHistory!.length).toBeGreaterThan(0);
		// History should include the messages from the first run
		expect(capturedHistory!.some((m) => m.role === "user")).toBe(true);
		expect(capturedHistory!.some((m) => m.role === "assistant")).toBe(true);
	});
});
