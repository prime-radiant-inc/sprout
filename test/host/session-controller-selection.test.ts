import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/host/event-bus.ts";
import { type AgentFactory, SessionController } from "../../src/host/session-controller.ts";
import type { SessionSelectionRequest } from "../../src/shared/session-selection.ts";

describe("SessionController selection state", () => {
	test("stores canonical selection snapshots after resolving unqualified model requests", () => {
		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: "/tmp/genome",
			projectDataDir: "/tmp/project",
			resolveSelection: (selection: SessionSelectionRequest) => {
				if (selection.kind !== "unqualified_model") {
					throw new Error(`Unexpected selection kind: ${selection.kind}`);
				}
				return {
					selection: {
						kind: "model",
						model: { providerId: "openai", modelId: "gpt-4o" },
					},
					resolved: { providerId: "openai", modelId: "gpt-4o" },
					source: "session",
				};
			},
		});

		bus.emitCommand({
			kind: "switch_model",
			data: { selection: { kind: "unqualified_model", modelId: "gpt-4o" } },
		});

		expect(controller.currentSelection).toEqual({
			selection: {
				kind: "model",
				model: { providerId: "openai", modelId: "gpt-4o" },
			},
			resolved: { providerId: "openai", modelId: "gpt-4o" },
			source: "session",
		});
	});

	test("passes canonical resolved model refs to the agent factory", async () => {
		let capturedModel: unknown;
		const factory: AgentFactory = async (options) => {
			capturedModel = options.model;
			return {
				agent: {
					steer() {},
					requestCompaction() {},
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

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: "/tmp/genome",
			projectDataDir: "/tmp/project",
			factory,
			resolveSelection: () => ({
				selection: {
					kind: "model",
					model: { providerId: "openai", modelId: "gpt-4o" },
				},
				resolved: { providerId: "openai", modelId: "gpt-4o" },
				source: "session",
			}),
		});

		bus.emitCommand({
			kind: "switch_model",
			data: { selection: { kind: "unqualified_model", modelId: "gpt-4o" } },
		});
		await controller.submitGoal("ship it");

		expect(capturedModel).toEqual({ providerId: "openai", modelId: "gpt-4o" });
	});

	test("inherit resets the controller to the runtime fallback selection snapshot", () => {
		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: "/tmp/genome",
			projectDataDir: "/tmp/project",
		});

		bus.emitCommand({
			kind: "switch_model",
			data: { selection: { kind: "inherit" } },
		});

		expect(controller.currentSelection).toEqual({
			selection: { kind: "inherit" },
			source: "runtime-fallback",
		});
		expect(controller.currentModel).toBeUndefined();
	});
});
