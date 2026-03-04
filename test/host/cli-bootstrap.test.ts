import { describe, expect, test } from "bun:test";
import { bootstrapInteractiveRuntime } from "../../src/host/cli-bootstrap.ts";

describe("bootstrapInteractiveRuntime", () => {
	test("builds runtime wiring and emits stderr-enabled info log", async () => {
		const created: Record<string, unknown> = {};
		const logger = {
			info: (category: string, message: string, data?: Record<string, unknown>) => {
				created.info = { category, message, data };
			},
		};

		const result = await bootstrapInteractiveRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				initialHistory: [{ role: "user", content: [{ kind: "text", text: "prior" }] }],
				completedHandles: [
					{
						handleId: "h1",
						ownerId: "root",
						result: {
							kind: "result",
							handle_id: "h1",
							output: "ok",
							success: true,
							stumbles: 0,
							turns: 1,
							timed_out: false,
						},
					},
				],
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
				logStderr: true,
				debug: false,
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: (opts) => {
					created.loggerOpts = opts;
					return logger;
				},
				createClient: async (incomingLogger) => {
					created.clientLogger = incomingLogger;
					return { id: "client" };
				},
				createController: (opts) => {
					created.controllerOpts = opts;
					return { sessionId: "01BOOT" };
				},
				loadAvailableModels: async (client) => {
					created.availableModelsClient = client;
					return ["fast", "balanced"];
				},
			},
		);

		expect((created.loggerOpts as any).stderrLevel).toBe("info");
		expect((created.info as any).data.level).toBe("info");
		expect((created.controllerOpts as any).completedHandles).toHaveLength(1);
		expect(result.availableModels).toEqual(["fast", "balanced"]);
	});

	test("omits stderr level when logStderr is false", async () => {
		const created: Record<string, unknown> = {};
		await bootstrapInteractiveRuntime(
			{
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01BOOT",
				infra: { spawner: { id: "spawner" } as any, genome: { id: "genome" } as any },
				logStderr: false,
				debug: true,
			},
			{
				createBus: () => ({ id: "bus" }),
				createLogger: (opts) => {
					created.loggerOpts = opts;
					return { info: () => {} };
				},
				createClient: async () => ({ id: "client" }),
				createController: () => ({ sessionId: "01BOOT" }),
				loadAvailableModels: async () => [],
			},
		);

		expect((created.loggerOpts as any).stderrLevel).toBeUndefined();
	});
});
