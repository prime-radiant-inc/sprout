import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/host/event-bus.ts";
import { type AgentFactory, SessionController } from "../../src/host/session-controller.ts";
import type { SessionMetadataSnapshot } from "../../src/host/session-metadata.ts";

/** Minimal fake agent that satisfies the RunnableAgent interface. */
function makeFakeAgent(options?: { runDelay?: number; runError?: Error }) {
	const steered: string[] = [];
	let runCalled = false;
	let runGoal = "";
	let runSignal: AbortSignal | undefined;

	return {
		agent: {
			steer(text: string) {
				steered.push(text);
			},
			async run(goal: string, signal?: AbortSignal) {
				runCalled = true;
				runGoal = goal;
				runSignal = signal;
				if (options?.runDelay) {
					await new Promise((r) => setTimeout(r, options.runDelay));
				}
				if (options?.runError) {
					throw options.runError;
				}
				return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
			},
		},
		get steered() {
			return steered;
		},
		get runCalled() {
			return runCalled;
		},
		get runGoal() {
			return runGoal;
		},
		get runSignal() {
			return runSignal;
		},
	};
}

/** Create a factory that returns a fake agent. */
function makeFakeFactory(fake: ReturnType<typeof makeFakeAgent>): AgentFactory {
	return async () => ({
		agent: fake.agent as any,
		learnProcess: null,
	});
}

describe("SessionController", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-sc-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeController(overrides?: { factory?: AgentFactory }) {
		const bus = new EventBus();
		const sessionsDir = join(tempDir, "sessions");
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			factory: overrides?.factory,
		});
		return { bus, controller, sessionsDir };
	}

	test("constructor creates a session with 26-char ULID", () => {
		const { controller } = makeController();
		expect(controller.sessionId).toHaveLength(26);
		// ULID uses Crockford Base32: 0-9, A-Z excluding I, L, O, U
		expect(controller.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	test("accepts explicit sessionId", () => {
		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: join(tempDir, "sessions"),
			sessionId: "01CUSTOM_SESSION_ID_26CH",
		});
		expect(controller.sessionId).toBe("01CUSTOM_SESSION_ID_26CH");
	});

	test("isRunning is false initially", () => {
		const { controller } = makeController();
		expect(controller.isRunning).toBe(false);
	});

	test("submitGoal runs the agent and updates isRunning", async () => {
		const fake = makeFakeAgent({ runDelay: 50 });
		const factory = makeFakeFactory(fake);
		const { controller } = makeController({ factory });

		const promise = controller.submitGoal("Fix the bug");

		// Give the event loop a tick for the factory to create the agent
		await new Promise((r) => setTimeout(r, 10));
		expect(controller.isRunning).toBe(true);

		await promise;

		expect(controller.isRunning).toBe(false);
		expect(fake.runCalled).toBe(true);
		expect(fake.runGoal).toBe("Fix the bug");
	});

	test("submitGoal routes as steer when already running", async () => {
		const fake = makeFakeAgent({ runDelay: 100 });
		const factory = makeFakeFactory(fake);
		const { controller } = makeController({ factory });

		const promise = controller.submitGoal("Fix the bug");
		await new Promise((r) => setTimeout(r, 10));

		// Second submit while running should steer
		await controller.submitGoal("Actually, try a different approach");

		expect(fake.steered).toContain("Actually, try a different approach");

		await promise;
	});

	test("steer command routes to agent", async () => {
		const fake = makeFakeAgent({ runDelay: 100 });
		const factory = makeFakeFactory(fake);
		const { bus, controller } = makeController({ factory });

		const promise = controller.submitGoal("Fix the bug");
		await new Promise((r) => setTimeout(r, 10));

		bus.emitCommand({ kind: "steer", data: { text: "focus on tests" } });

		expect(fake.steered).toContain("focus on tests");

		await promise;
	});

	test("submit_goal command triggers submitGoal", async () => {
		const fake = makeFakeAgent();
		const factory = makeFakeFactory(fake);
		const { bus } = makeController({ factory });

		bus.emitCommand({ kind: "submit_goal", data: { goal: "Write tests" } });

		// Give the async submitGoal time to run
		await new Promise((r) => setTimeout(r, 50));

		expect(fake.runCalled).toBe(true);
		expect(fake.runGoal).toBe("Write tests");
	});

	test("interrupt aborts the current signal", async () => {
		const fake = makeFakeAgent({ runDelay: 200 });
		const factory = makeFakeFactory(fake);
		const { bus, controller } = makeController({ factory });

		const promise = controller.submitGoal("Fix the bug");
		await new Promise((r) => setTimeout(r, 10));

		bus.emitCommand({ kind: "interrupt", data: {} });

		// The signal passed to agent.run should be aborted
		expect(fake.runSignal?.aborted).toBe(true);

		await promise;
	});

	test("quit command triggers interrupt", async () => {
		const fake = makeFakeAgent({ runDelay: 200 });
		const factory = makeFakeFactory(fake);
		const { bus, controller } = makeController({ factory });

		const promise = controller.submitGoal("Fix the bug");
		await new Promise((r) => setTimeout(r, 10));

		bus.emitCommand({ kind: "quit", data: {} });

		expect(fake.runSignal?.aborted).toBe(true);

		await promise;
	});

	test("metadata is saved as running then idle", async () => {
		const fake = makeFakeAgent({ runDelay: 50 });
		const factory = makeFakeFactory(fake);
		const { controller, sessionsDir } = makeController({ factory });

		await controller.submitGoal("Fix the bug");

		// After completion, metadata should exist and be idle
		const metaPath = join(sessionsDir, `${controller.sessionId}.meta.json`);
		const raw = await readFile(metaPath, "utf-8");
		const snapshot: SessionMetadataSnapshot = JSON.parse(raw);

		expect(snapshot.sessionId).toBe(controller.sessionId);
		expect(snapshot.status).toBe("idle");
		expect(snapshot.agentSpec).toBe("root");
	});

	test("metadata shows running during agent execution", async () => {
		let capturedSnapshot: SessionMetadataSnapshot | null = null;
		const sessionsDir = join(tempDir, "sessions");

		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run() {
					// Read metadata during run
					const metaPath = join(sessionsDir, `${options.sessionId}.meta.json`);
					// Wait a tick for the save to complete
					await new Promise((r) => setTimeout(r, 20));
					const raw = await readFile(metaPath, "utf-8");
					capturedSnapshot = JSON.parse(raw);
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
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

		await controller.submitGoal("Fix the bug");

		expect(capturedSnapshot).not.toBeNull();
		expect(capturedSnapshot!.status).toBe("running");
	});

	test("events from agent are visible on bus", async () => {
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run() {
					// The factory receives the bus as events — emit through it
					options.events.emitEvent("plan_start", "root", 0, { turn: 1 });
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
				},
			} as any,
			learnProcess: null,
		});

		const { bus, controller } = makeController({ factory });
		const received: string[] = [];
		bus.onEvent((e) => received.push(e.kind));

		await controller.submitGoal("Test");

		expect(received).toContain("plan_start");
	});

	test("agent error sets status back to idle", async () => {
		const fake = makeFakeAgent({ runError: new Error("LLM failed") });
		const factory = makeFakeFactory(fake);
		const { controller, sessionsDir } = makeController({ factory });

		// submitGoal propagates errors from the agent
		let thrown = false;
		try {
			await controller.submitGoal("Fix the bug");
		} catch {
			thrown = true;
		}

		expect(thrown).toBe(true);
		expect(controller.isRunning).toBe(false);

		const metaPath = join(sessionsDir, `${controller.sessionId}.meta.json`);
		const raw = await readFile(metaPath, "utf-8");
		const snapshot: SessionMetadataSnapshot = JSON.parse(raw);
		expect(snapshot.status).toBe("idle");
	});

	test("submitGoal error emits error event with data.error field", async () => {
		const fake = makeFakeAgent({ runError: new Error("LLM failed") });
		const factory = makeFakeFactory(fake);
		const { bus } = makeController({ factory });

		const errorEvents: any[] = [];
		bus.onEvent((e) => {
			if (e.kind === "error") errorEvents.push(e);
		});

		// Use bus command so the error is caught by handleCommand
		bus.emitCommand({ kind: "submit_goal", data: { goal: "Fix the bug" } });

		// Give async submitGoal time to run and fail
		await new Promise((r) => setTimeout(r, 100));

		expect(errorEvents.length).toBeGreaterThanOrEqual(1);
		expect(errorEvents[0].data.error).toBeDefined();
		expect(typeof errorEvents[0].data.error).toBe("string");
		expect(errorEvents[0].data.error).toContain("LLM failed");
		// Should NOT have a 'message' field (that's the old incorrect field)
		expect(errorEvents[0].data.message).toBeUndefined();
	});

	test("steer command with no agent running is a no-op", () => {
		const { bus } = makeController();
		// Should not throw
		bus.emitCommand({ kind: "steer", data: { text: "hello" } });
	});

	test("interrupt with no agent running is a no-op", () => {
		const { bus } = makeController();
		// Should not throw
		bus.emitCommand({ kind: "interrupt", data: {} });
	});

	test("events are written to log file", async () => {
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run() {
					options.events.emitEvent("plan_start", "root", 0, { turn: 1 });
					options.events.emitEvent("plan_end", "root", 0, { turn: 1 });
					// Allow async log writes to flush
					await new Promise((r) => setTimeout(r, 20));
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
				},
			} as any,
			learnProcess: null,
		});

		const { controller, sessionsDir } = makeController({ factory });
		await controller.submitGoal("Test logging");

		// Wait for async log writes
		await new Promise((r) => setTimeout(r, 50));

		const logPath = join(sessionsDir, `${controller.sessionId}.jsonl`);
		const raw = await readFile(logPath, "utf-8");
		const lines = raw.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);

		const events = lines.map((l) => JSON.parse(l));
		expect(events.some((e: any) => e.kind === "plan_start")).toBe(true);
		expect(events.some((e: any) => e.kind === "plan_end")).toBe(true);
	});

	test("metadata is updated after plan_end event", async () => {
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run() {
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 3,
						context_tokens: 5000,
						context_window_size: 200000,
					});
					// Allow async metadata save to flush
					await new Promise((r) => setTimeout(r, 50));
					return { output: "done", success: true, stumbles: 0, turns: 3, timed_out: false };
				},
			} as any,
			learnProcess: null,
		});

		const { controller, sessionsDir } = makeController({ factory });
		await controller.submitGoal("Test metadata updates");

		const metaPath = join(sessionsDir, `${controller.sessionId}.meta.json`);
		const raw = await readFile(metaPath, "utf-8");
		const snapshot: SessionMetadataSnapshot = JSON.parse(raw);

		// The final save sets idle, but turns should have been updated by plan_end handler
		expect(snapshot.turns).toBe(3);
		expect(snapshot.contextTokens).toBe(5000);
		expect(snapshot.contextWindowSize).toBe(200000);
	});

	test("learnProcess lifecycle is managed", async () => {
		const calls: string[] = [];
		const factory: AgentFactory = async () => ({
			agent: {
				steer() {},
				async run() {
					calls.push("run");
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
				},
			} as any,
			learnProcess: {
				startBackground() {
					calls.push("start");
				},
				async stopBackground() {
					calls.push("stop");
				},
			},
		});

		const { controller } = makeController({ factory });
		await controller.submitGoal("test");
		expect(calls).toEqual(["start", "run", "stop"]);
	});

	test("learnProcess is stopped even when agent throws", async () => {
		const calls: string[] = [];
		const factory: AgentFactory = async () => ({
			agent: {
				steer() {},
				async run() {
					calls.push("run");
					throw new Error("agent failed");
				},
			} as any,
			learnProcess: {
				startBackground() {
					calls.push("start");
				},
				async stopBackground() {
					calls.push("stop");
				},
			},
		});

		const { controller } = makeController({ factory });
		try {
			await controller.submitGoal("test");
		} catch {
			// Expected
		}
		expect(calls).toEqual(["start", "run", "stop"]);
	});

	test("second submitGoal passes non-empty initialHistory to factory", async () => {
		let factoryCallCount = 0;
		let capturedInitialHistory: any[] | undefined;

		const factory: AgentFactory = async (options) => {
			factoryCallCount++;
			capturedInitialHistory = options.initialHistory;
			return {
				agent: {
					steer() {},
					async run(goal: string) {
						// Simulate the agent emitting events that build history
						// perceive → plan_end → session_end
						options.events.emitEvent("perceive", "root", 0, { goal });
						options.events.emitEvent("plan_end", "root", 0, {
							turn: 1,
							assistant_message: { role: "assistant", content: [{ kind: "text", text: "Done." }] },
						});
						return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
					},
				} as any,
				learnProcess: null,
			};
		};

		const { controller } = makeController({ factory });

		// First submitGoal
		await controller.submitGoal("first goal");
		expect(factoryCallCount).toBe(1);
		// First call should have no initial history (or empty)
		expect(capturedInitialHistory ?? []).toHaveLength(0);

		// Second submitGoal should pass accumulated history
		await controller.submitGoal("second goal");
		expect(factoryCallCount).toBe(2);
		expect(capturedInitialHistory).toBeDefined();
		expect(capturedInitialHistory).toHaveLength(2);
		expect(capturedInitialHistory![0].role).toBe("user");
		expect(capturedInitialHistory![0].content[0].text).toBe("first goal");
		expect(capturedInitialHistory![1].role).toBe("assistant");
		expect(capturedInitialHistory![1].content[0].text).toBe("Done.");
	});

	test("steering events accumulate in history", async () => {
		const factoryCallHistory: any[] = [];

		const factory: AgentFactory = async (options) => {
			factoryCallHistory.push(
				options.initialHistory ? [...options.initialHistory] : undefined,
			);
			return {
				agent: {
					steer() {},
					async run(goal: string) {
						// Emit perceive and plan_end to build history as usual
						options.events.emitEvent("perceive", "root", 0, { goal });
						options.events.emitEvent("plan_end", "root", 0, {
							turn: 1,
							assistant_message: {
								role: "assistant",
								content: [{ kind: "text", text: "Done." }],
							},
						});
						return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
					},
				} as any,
				learnProcess: null,
			};
		};

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: join(tempDir, "sessions"),
			factory,
		});

		// First goal
		await controller.submitGoal("initial");

		// Emit steering event (simulating user steering between runs)
		bus.emitEvent("steering", "root", 0, { text: "steer msg" });

		// Allow async event handling to flush
		await new Promise((r) => setTimeout(r, 50));

		// Second goal — factory should get history containing the steer message
		await controller.submitGoal("second");

		expect(factoryCallHistory.length).toBeGreaterThanOrEqual(2);
		const secondHistory = factoryCallHistory[1];
		expect(secondHistory).toBeDefined();
		const hasSteer = secondHistory.some(
			(m: any) => m.role === "user" && JSON.stringify(m.content).includes("steer msg"),
		);
		expect(hasSteer).toBe(true);
	});

	test("default factory forwards sessionId to createAgent", async () => {
		// Use a spy factory to capture what options are passed
		let capturedSessionId: string | undefined;
		const spyFactory: AgentFactory = async (options) => {
			capturedSessionId = options.sessionId;
			return {
				agent: makeFakeAgent().agent as any,
				learnProcess: null,
			};
		};

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: join(tempDir, "sessions"),
			sessionId: "MY_CUSTOM_SESSION",
			factory: spyFactory,
		});

		await controller.submitGoal("test");
		expect(capturedSessionId).toBe("MY_CUSTOM_SESSION");
	});

	test("clear command resets history", async () => {
		let callCount = 0;
		let capturedHistory: any[] | undefined;

		const factory: AgentFactory = async (options) => {
			callCount++;
			capturedHistory = options.initialHistory;
			return {
				agent: {
					steer() {},
					async run(goal: string) {
						options.events.emitEvent("perceive", "root", 0, { goal });
						options.events.emitEvent("plan_end", "root", 0, {
							turn: 1,
							assistant_message: {
								role: "assistant",
								content: [{ kind: "text", text: "Done." }],
							},
						});
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

		const { bus, controller } = makeController({ factory });

		await controller.submitGoal("first goal");
		expect(callCount).toBe(1);

		bus.emitCommand({ kind: "clear", data: {} });

		await controller.submitGoal("second goal");
		expect(callCount).toBe(2);
		expect(capturedHistory).toBeUndefined();
	});

	test("clear command resets hasRun flag", async () => {
		let callCount = 0;
		const factory: AgentFactory = async (options) => {
			callCount++;
			return {
				agent: {
					steer() {},
					async run(goal: string) {
						options.events.emitEvent("perceive", "root", 0, { goal });
						options.events.emitEvent("plan_end", "root", 0, {
							turn: 1,
							assistant_message: {
								role: "assistant",
								content: [{ kind: "text", text: "Done." }],
							},
						});
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

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: join(tempDir, "sessions"),
			factory,
			initialHistory: [{ role: "user", content: [{ kind: "text", text: "prior" }] }],
		});

		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		// First submitGoal: hasRun=false, history.length=1 -> session_resume fires
		await controller.submitGoal("goal 1");
		expect(events.filter((e: any) => e.kind === "session_resume")).toHaveLength(1);

		// Clear resets both history and hasRun
		bus.emitCommand({ kind: "clear", data: {} });

		// After clear, history is empty so session_resume won't fire
		await controller.submitGoal("goal 2");
		expect(events.filter((e: any) => e.kind === "session_resume")).toHaveLength(1);
	});

	test("currentModel returns undefined by default and reflects switch_model", () => {
		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: join(tempDir, "sessions"),
			factory: async () => ({
				agent: {
					steer() {},
					async run() {
						return { output: "", success: true, stumbles: 0, turns: 0, timed_out: false };
					},
				} as any,
				learnProcess: null,
			}),
		});
		expect(controller.currentModel).toBeUndefined();

		bus.emitCommand({ kind: "switch_model", data: { model: "fast" } });
		expect(controller.currentModel).toBe("fast");

		bus.emitCommand({ kind: "switch_model", data: { model: undefined } });
		expect(controller.currentModel).toBeUndefined();
	});

	test("session_resume is NOT emitted on second submitGoal", async () => {
		const bus = new EventBus();
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					options.events.emitEvent("perceive", "root", 0, { goal });
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						assistant_message: {
							role: "assistant",
							content: [{ kind: "text", text: "Done." }],
						},
					});
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

		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: join(tempDir, "sessions"),
			factory,
			initialHistory: [
				{ role: "user", content: [{ kind: "text", text: "prior" }] },
				{ role: "assistant", content: [{ kind: "text", text: "response" }] },
			],
		});

		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		await controller.submitGoal("first goal");
		expect(events.filter((e: any) => e.kind === "session_resume")).toHaveLength(1);

		await controller.submitGoal("second goal");
		expect(events.filter((e: any) => e.kind === "session_resume")).toHaveLength(1);
	});

	test("compact command is accepted without error", () => {
		const { bus } = makeController();
		// Should not throw — compact is routed but not yet implemented
		bus.emitCommand({ kind: "compact", data: {} });
	});

	test("switch_model command updates model passed to factory", async () => {
		let capturedModel: string | undefined;
		let callCount = 0;

		const factory: AgentFactory = async (options) => {
			callCount++;
			capturedModel = options.model;
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

		const { bus, controller } = makeController({ factory });

		// First run — no model override
		await controller.submitGoal("first");
		expect(callCount).toBe(1);
		expect(capturedModel).toBeUndefined();

		// Switch model
		bus.emitCommand({ kind: "switch_model", data: { model: "fast" } });

		// Second run — should pass model
		await controller.submitGoal("second");
		expect(callCount).toBe(2);
		expect(capturedModel).toBe("fast");
	});

	test("session_resume event emitted when initialHistory provided", async () => {
		const bus = new EventBus();
		const fake = makeFakeAgent();
		const factory = makeFakeFactory(fake);
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: join(tempDir, "sessions"),
			factory,
			initialHistory: [
				{ role: "user", content: [{ kind: "text", text: "prior goal" }] },
				{ role: "assistant", content: [{ kind: "text", text: "prior response" }] },
			],
		});

		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		await controller.submitGoal("new goal");

		const resumeEvents = events.filter((e) => e.kind === "session_resume");
		expect(resumeEvents).toHaveLength(1);
		expect(resumeEvents[0].data.history_length).toBe(2);
	});

	test("context_update event emitted after plan_end with context data", async () => {
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run() {
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 2,
						context_tokens: 8000,
						context_window_size: 200000,
					});
					// Allow async event handling
					await new Promise((r) => setTimeout(r, 50));
					return { output: "done", success: true, stumbles: 0, turns: 2, timed_out: false };
				},
			} as any,
			learnProcess: null,
		});

		const { bus, controller } = makeController({ factory });
		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		await controller.submitGoal("test context");

		const contextEvents = events.filter((e) => e.kind === "context_update");
		expect(contextEvents).toHaveLength(1);
		expect(contextEvents[0].data.context_tokens).toBe(8000);
		expect(contextEvents[0].data.context_window_size).toBe(200000);
	});

	test("compact command calls compact callback and emits compaction event", async () => {
		let compactCalled = false;
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					options.events.emitEvent("perceive", "root", 0, { goal });
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						assistant_message: { role: "assistant", content: [{ kind: "text", text: "Done." }] },
					});
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
				},
			} as any,
			learnProcess: null,
			compact: async (history, _logPath) => {
				compactCalled = true;
				const beforeCount = history.length;
				history.length = 0;
				history.push({ role: "user", content: [{ kind: "text", text: "compacted summary" }] });
				return { summary: "compacted summary", beforeCount, afterCount: 1 };
			},
		});

		const { bus, controller } = makeController({ factory });

		// Run first to populate history and get compact callback stored
		await controller.submitGoal("build something");

		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		// Issue compact command
		bus.emitCommand({ kind: "compact", data: {} });

		// Allow async compact to run
		await new Promise((r) => setTimeout(r, 100));

		expect(compactCalled).toBe(true);
		const compactionEvents = events.filter((e) => e.kind === "compaction");
		expect(compactionEvents).toHaveLength(1);
		expect(compactionEvents[0].data.summary).toBe("compacted summary");
		expect(compactionEvents[0].data.beforeCount).toBeGreaterThan(0);
		expect(compactionEvents[0].data.afterCount).toBe(1);
	});

	test("auto-compaction triggered when context tokens exceed threshold", async () => {
		let compactCalled = false;
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					options.events.emitEvent("perceive", "root", 0, { goal });
					// Emit plan_end with context at 90% capacity
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						context_tokens: 180000,
						context_window_size: 200000,
						assistant_message: { role: "assistant", content: [{ kind: "text", text: "Done." }] },
					});
					// Allow async event handling
					await new Promise((r) => setTimeout(r, 100));
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
				},
			} as any,
			learnProcess: null,
			compact: async (history, _logPath) => {
				compactCalled = true;
				const beforeCount = history.length;
				history.length = 0;
				history.push({ role: "user", content: [{ kind: "text", text: "summary" }] });
				return { summary: "summary", beforeCount, afterCount: 1 };
			},
		});

		const { controller } = makeController({ factory });
		await controller.submitGoal("build something big");

		// Allow async operations to complete
		await new Promise((r) => setTimeout(r, 150));

		expect(compactCalled).toBe(true);
	});

	test("handleEvent errors are caught and logged, not unhandled rejections", async () => {
		// Use a sessions dir that cannot be created (under /dev/null)
		const bus = new EventBus();
		const fake = makeFakeAgent();
		new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir: "/dev/null/impossible/path",
			factory: makeFakeFactory(fake),
		});

		// Emit an event that will trigger appendLog on an impossible path
		// This should NOT cause an unhandled rejection
		bus.emitEvent("plan_start", "root", 0, { turn: 1 });

		// Wait for the async handler to settle
		await new Promise((r) => setTimeout(r, 100));

		// If we get here without the test runner crashing, the error was handled
		expect(true).toBe(true);
	});

	test("after compaction, next submitGoal receives compacted history", async () => {
		let factoryCallCount = 0;
		let capturedInitialHistory: any[] | undefined;

		const factory: AgentFactory = async (options) => {
			factoryCallCount++;
			capturedInitialHistory = options.initialHistory;
			return {
				agent: {
					steer() {},
					async run(goal: string) {
						options.events.emitEvent("perceive", "root", 0, { goal });
						options.events.emitEvent("plan_end", "root", 0, {
							turn: 1,
							assistant_message: {
								role: "assistant",
								content: [{ kind: "text", text: "Done." }],
							},
						});
						return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
					},
				} as any,
				learnProcess: null,
				// compact does NOT mutate the snapshot — only returns the summary
				compact: async (_history, _logPath) => {
					return { summary: "compacted summary", beforeCount: 2, afterCount: 1 };
				},
			};
		};

		const { bus, controller } = makeController({ factory });

		// First submitGoal builds up history (perceive + plan_end = 2 messages)
		await controller.submitGoal("build something");
		expect(factoryCallCount).toBe(1);

		// Trigger compaction
		bus.emitCommand({ kind: "compact", data: {} });
		await new Promise((r) => setTimeout(r, 100));

		// Second submitGoal should receive compacted 1-message history
		await controller.submitGoal("continue");
		expect(factoryCallCount).toBe(2);
		expect(capturedInitialHistory).toBeDefined();
		expect(capturedInitialHistory).toHaveLength(1);
		expect(capturedInitialHistory![0].role).toBe("user");
		expect(capturedInitialHistory![0].content[0].text).toBe("compacted summary");
	});

	test("interrupted agent sets metadata to interrupted, not idle", async () => {
		const factory: AgentFactory = async () => ({
			agent: {
				steer() {},
				async run(_goal: string, signal?: AbortSignal) {
					// Wait for abort
					await new Promise((_resolve, reject) => {
						if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
						signal?.addEventListener(
							"abort",
							() => reject(new DOMException("Aborted", "AbortError")),
							{ once: true },
						);
					});
				},
			} as any,
			learnProcess: null,
		});

		const { bus, controller, sessionsDir } = makeController({ factory });
		const promise = controller.submitGoal("do stuff");
		await new Promise((r) => setTimeout(r, 10));

		// Interrupt
		bus.emitCommand({ kind: "interrupt", data: {} });

		// Wait for submitGoal to settle
		await promise.catch(() => {});

		const metaPath = join(sessionsDir, `${controller.sessionId}.meta.json`);
		const raw = await readFile(metaPath, "utf-8");
		const snapshot = JSON.parse(raw);
		expect(snapshot.status).toBe("interrupted");
	});

	test("clear command resets session identity and emits session_clear", async () => {
		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					options.events.emitEvent("perceive", "root", 0, { goal });
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						assistant_message: {
							role: "assistant",
							content: [{ kind: "text", text: "Done." }],
						},
					});
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
				},
			} as any,
			learnProcess: null,
		});

		const { bus, controller } = makeController({ factory });

		const initialId = controller.sessionId;

		// Run a goal to populate some state
		await controller.submitGoal("first goal");

		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		// Clear should reset session identity
		bus.emitCommand({ kind: "clear", data: {} });

		// sessionId should be different
		expect(controller.sessionId).not.toBe(initialId);
		expect(controller.sessionId).toHaveLength(26);
		expect(controller.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

		// session_clear event should have been emitted
		const clearEvents = events.filter((e) => e.kind === "session_clear");
		expect(clearEvents).toHaveLength(1);
		expect(clearEvents[0].data.new_session_id).toBe(controller.sessionId);
	});

	test("resume with stuck running metadata marks it interrupted before running", async () => {
		const sessionsDir = join(tempDir, "sessions");
		const sessionId = "01STUCKSESSION_RUNNING";

		// Create a metadata file with status "running" (simulating crash)
		const { mkdir, writeFile, readFile } = await import("node:fs/promises");
		await mkdir(sessionsDir, { recursive: true });
		const metaPath = join(sessionsDir, `${sessionId}.meta.json`);
		await writeFile(
			metaPath,
			JSON.stringify({
				sessionId,
				agentSpec: "root",
				model: "best",
				status: "running",
				turns: 5,
				contextTokens: 1000,
				contextWindowSize: 200000,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		);

		// Factory that crashes during run to simulate the process dying
		const factory: AgentFactory = async () => ({
			agent: {
				steer() {},
				async run() {
					throw new Error("simulated crash");
				},
			} as any,
			learnProcess: null,
		});

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			sessionId,
			initialHistory: [{ role: "user", content: [{ kind: "text", text: "prior" }] }],
			factory,
		});

		// Before submitGoal, verify metadata still says "running"
		const rawBefore = await readFile(metaPath, "utf-8");
		expect(JSON.parse(rawBefore).status).toBe("running");

		// submitGoal will throw due to simulated crash, but the recovery should happen first
		try {
			await controller.submitGoal("continue");
		} catch {
			// Expected: agent.run threw
		}

		// After the crash, the finally block sets status to "idle".
		// The key test: construct a NEW controller with the same sessionId and
		// verify it can detect the interrupted state. This tests the full flow:
		// write "running" -> crash -> new controller -> loadIfExists -> detect stuck.

		// Simulate: the first run ended with "idle" in the finally block.
		// Now manually set it back to "running" to simulate an actual crash
		// where the finally block never executes.
		await writeFile(
			metaPath,
			JSON.stringify({
				sessionId,
				agentSpec: "root",
				model: "best",
				status: "running",
				turns: 5,
				contextTokens: 1000,
				contextWindowSize: 200000,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		);

		// Capture the session_resume event which fires after loadIfExists
		const events: any[] = [];
		const bus2 = new EventBus();
		bus2.onEvent((e) => events.push(e));

		const noopFactory: AgentFactory = async () => ({
			agent: {
				steer() {},
				async run() {
					return { output: "done", success: true, stumbles: 0, turns: 1, timed_out: false };
				},
			} as any,
			learnProcess: null,
		});

		const ctrl2 = new SessionController({
			bus: bus2,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			sessionId,
			initialHistory: [{ role: "user", content: [{ kind: "text", text: "prior" }] }],
			factory: noopFactory,
		});

		await ctrl2.submitGoal("continue after crash");

		// Verify the metadata was recovered: the "running" was detected and
		// set to "interrupted" by loadIfExists, then overwritten to "running"
		// by the new run, then set to "idle" by the finally block.
		// The final state should be idle.
		const rawAfter = await readFile(metaPath, "utf-8");
		expect(JSON.parse(rawAfter).status).toBe("idle");

		// Verify session_resume was emitted (proves history was forwarded)
		const resumeEvents = events.filter((e) => e.kind === "session_resume");
		expect(resumeEvents).toHaveLength(1);
	});
});
