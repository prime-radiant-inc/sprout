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

	test("controller updates shadow history when agent emits compaction event", async () => {
		const sessionsDir = join(tempDir, "sessions");

		const factory: AgentFactory = async (options) => {
			return {
				agent: {
					steer() {},
					requestCompaction() {},
					async run(goal: string) {
						// Build up some history
						options.events.emitEvent("perceive", "root", 0, { goal });
						options.events.emitEvent("plan_end", "root", 0, {
							turn: 1,
							assistant_message: {
								role: "assistant",
								content: [{ kind: "text", text: "Working on it..." }],
							},
							context_tokens: 180000,
							context_window_size: 200000,
						});

						// Simulate agent-internal compaction emitting a compaction event
						options.events.emitEvent("compaction", "root", 0, {
							summary: "Compacted: was working on a task",
							beforeCount: 2,
							afterCount: 1,
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
		new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			factory,
		});

		const events: any[] = [];
		bus.onEvent((e) => events.push(e));

		bus.emitCommand({ kind: "submit_goal", data: { goal: "build something big" } });

		// Wait for async operations
		await new Promise((r) => setTimeout(r, 200));

		// Verify compaction event was received
		const compactionEvents = events.filter((e) => e.kind === "compaction");
		expect(compactionEvents).toHaveLength(1);
		expect(compactionEvents[0].data.summary).toBe("Compacted: was working on a task");
	});

	test("manual compact command calls requestCompaction on the agent", async () => {
		const sessionsDir = join(tempDir, "sessions");
		let requestCompactionCalled = false;

		const factory: AgentFactory = async (options) => ({
			agent: {
				steer() {},
				requestCompaction() {
					requestCompactionCalled = true;
				},
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

					// Keep running long enough for compact command to arrive
					await new Promise((r) => setTimeout(r, 100));

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

		const bus = new EventBus();
		new SessionController({
			bus,
			genomePath: join(tempDir, "genome"),
			sessionsDir,
			factory,
		});

		// Start run
		bus.emitCommand({ kind: "submit_goal", data: { goal: "do something" } });
		await new Promise((r) => setTimeout(r, 20));

		// Issue compact command while agent is running
		bus.emitCommand({ kind: "compact", data: {} });

		// Wait for everything
		await new Promise((r) => setTimeout(r, 200));

		expect(requestCompactionCalled).toBe(true);
	});
});
