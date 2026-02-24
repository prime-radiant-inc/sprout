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
		expect(capturedInitialHistory!.length).toBeGreaterThan(0);
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
});
