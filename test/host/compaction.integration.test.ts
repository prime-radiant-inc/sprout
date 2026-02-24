import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldCompact } from "../../src/host/compaction.ts";
import { EventBus } from "../../src/host/event-bus.ts";
import { type AgentFactory, SessionController } from "../../src/host/session-controller.ts";

describe("Compaction integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-compact-int-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("shouldCompact returns true at 80% threshold", () => {
		expect(shouldCompact(160000, 200000)).toBe(true);
		expect(shouldCompact(159999, 200000)).toBe(false);
		expect(shouldCompact(0, 0)).toBe(false);
		expect(shouldCompact(100, 0)).toBe(false);
	});

	test("auto-compaction triggers via SessionController when context exceeds threshold", async () => {
		const sessionsDir = join(tempDir, "sessions");
		let compactCalled = false;
		let compactHistoryLength = 0;

		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					// Build up some history
					options.events.emitEvent("perceive", "root", 0, { goal });
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						assistant_message: {
							role: "assistant",
							content: [{ kind: "text", text: "Working on it..." }],
						},
						// Emit at 90% context usage — above 80% threshold
						context_tokens: 180000,
						context_window_size: 200000,
					});

					// Allow auto-compaction to trigger
					await new Promise((r) => setTimeout(r, 150));

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
			compact: async (history, _logPath) => {
				compactCalled = true;
				compactHistoryLength = history.length;
				const beforeCount = history.length;
				// Simulate compaction: replace all history with summary
				history.length = 0;
				history.push({
					role: "user",
					content: [{ kind: "text", text: "Compacted: was working on a task" }],
				});
				return {
					summary: "Compacted: was working on a task",
					beforeCount,
					afterCount: 1,
				};
			},
		});

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			factory,
		});

		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		await controller.submitGoal("build something big");

		// Wait for async operations
		await new Promise((r) => setTimeout(r, 200));

		// Verify compaction was triggered
		expect(compactCalled).toBe(true);
		expect(compactHistoryLength).toBeGreaterThan(0);

		// Verify compaction event was emitted
		const compactionEvents = events.filter((e) => e.kind === "compaction");
		expect(compactionEvents).toHaveLength(1);
		expect(compactionEvents[0].data.summary).toBe("Compacted: was working on a task");
		expect(compactionEvents[0].data.beforeCount).toBeGreaterThan(0);
		expect(compactionEvents[0].data.afterCount).toBe(1);
	});

	test("manual compact command triggers compaction via bus", async () => {
		const sessionsDir = join(tempDir, "sessions");
		let compactCalled = false;

		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				async run(goal: string) {
					// Build up history
					options.events.emitEvent("perceive", "root", 0, { goal });
					options.events.emitEvent("plan_end", "root", 0, {
						turn: 1,
						assistant_message: {
							role: "assistant",
							content: [{ kind: "text", text: "Response" }],
						},
						context_tokens: 1000,
						context_window_size: 200000,
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
			compact: async (history, _logPath) => {
				compactCalled = true;
				const beforeCount = history.length;
				history.length = 0;
				history.push({
					role: "user",
					content: [{ kind: "text", text: "Summary" }],
				});
				return { summary: "Summary", beforeCount, afterCount: 1 };
			},
		});

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			factory,
		});

		// Run to build history and store compact fn
		await controller.submitGoal("do something");

		// Now issue compact command
		bus.emitCommand({ kind: "compact", data: {} });

		// Wait for async compact
		await new Promise((r) => setTimeout(r, 100));

		expect(compactCalled).toBe(true);
	});
});
