import { describe, expect, test } from "bun:test";
import { runInteractiveMode } from "../../src/host/cli-interactive.ts";

class FakeBus {
	readonly commands: Array<{ kind: string; data: Record<string, unknown> }> = [];
	readonly events: Array<{ kind: string; data: Record<string, unknown> }> = [];

	emitCommand(cmd: { kind: string; data: Record<string, unknown> }) {
		this.commands.push(cmd);
	}

	emitEvent(kind: string, _agentId: string, _depth: number, data: Record<string, unknown>) {
		this.events.push({ kind, data });
	}
}

describe("runInteractiveMode", () => {
	test("web-only path delegates to runWebOnlyMode and skips TUI setup", async () => {
		const bus = new FakeBus();
		const called: string[] = [];

		await runInteractiveMode(
			{
				command: {
					genomePath: "/tmp/genome",
					webOnly: true,
					web: true,
				},
				sessionId: "01WEBONLY",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01WEBONLY", isRunning: false, currentModel: undefined },
					logger: { info: () => {} },
					availableModels: ["fast"],
				},
				initialEvents: [],
				cleanupInfra: async () => {
					called.push("cleanup");
				},
				onResumeHint: () => {
					called.push("resume");
				},
				inputHistoryPath: () => "/tmp/history",
				handleSlashCommand: async () => ({ action: "none" }),
			},
			{
				createWebServer: async () => ({
					start: async () => {
						called.push("web-start");
					},
					stop: async () => {
						called.push("web-stop");
					},
				}),
				runWebOnlyMode: async (opts) => {
					called.push("web-only");
					await opts.stopWebServer();
					await opts.cleanupInfra();
					opts.onResumeHint(opts.sessionId);
				},
				createInputHistory: async () => {
					throw new Error("history should not be created in web-only mode");
				},
				renderApp: async () => {
					throw new Error("renderApp should not run in web-only mode");
				},
				registerInteractiveSigint: () =>
					({
						onSignal: () => {},
						clearPending: () => {},
						dispose: () => {},
					}) as any,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: () => {},
			},
		);

		expect(called).toEqual(["web-start", "web-only", "web-stop", "cleanup", "resume"]);
	});

	test("non-local web bind prints nonce to stdout", async () => {
		const bus = new FakeBus();
		const stdout: string[] = [];
		const stderr: string[] = [];

		await runInteractiveMode(
			{
				command: {
					genomePath: "/tmp/genome",
					webOnly: true,
					web: true,
					host: "0.0.0.0",
				},
				sessionId: "01NONCE",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01NONCE", isRunning: false, currentModel: undefined },
					logger: { info: () => {} },
					availableModels: [],
				},
				initialEvents: [],
				cleanupInfra: async () => {},
				onResumeHint: () => {},
				inputHistoryPath: () => "/tmp/history",
				handleSlashCommand: async () => ({ action: "none" }),
			},
			{
				createWebServer: async () => ({
					start: async () => {},
					stop: async () => {},
					getWebToken: () => "generated-nonce",
				}),
				runWebOnlyMode: async (opts) => {
					await opts.stopWebServer();
					await opts.cleanupInfra();
					opts.onResumeHint(opts.sessionId);
				},
				createInputHistory: async () => {
					throw new Error("history should not be created in web-only mode");
				},
				renderApp: async () => {
					throw new Error("renderApp should not run in web-only mode");
				},
				registerInteractiveSigint: () =>
					({
						onSignal: () => {},
						clearPending: () => {},
						dispose: () => {},
					}) as any,
				buildWebOpenUrl: (port, webToken, host) =>
					`http://${host ?? "localhost"}:${port}${webToken ? `/?token=${webToken}` : ""}`,
				openUrl: () => {},
				logOut: (line) => {
					stdout.push(line);
				},
				logError: (line) => {
					stderr.push(line);
				},
			},
		);

		expect(stdout).toEqual([
			"Web nonce: generated-nonce",
			"Web UI URL: http://0.0.0.0:7777/?token=generated-nonce",
		]);
		expect(stderr).toContain("Web UI: http://0.0.0.0:7777");
	});

	test("interactive web mode emits recoverable web URL event", async () => {
		const bus = new FakeBus();

		await runInteractiveMode(
			{
				command: {
					genomePath: "/tmp/genome",
					web: true,
					host: "0.0.0.0",
				},
				sessionId: "01WEBHINT",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01WEBHINT", isRunning: false, currentModel: undefined },
					logger: { info: () => {} },
					availableModels: [],
				},
				initialEvents: [],
				cleanupInfra: async () => {},
				onResumeHint: () => {},
				inputHistoryPath: () => "/tmp/history",
				handleSlashCommand: async () => ({ action: "none" }),
			},
			{
				createWebServer: async () => ({
					start: async () => {},
					stop: async () => {},
					getWebToken: () => "generated-nonce",
				}),
				runWebOnlyMode: async () => {},
				createInputHistory: async () => ({
					load: async () => {},
					save: async () => {},
					add: () => {},
					all: () => [],
				}),
				renderApp: async () => ({
					waitUntilExit: async () => {},
					unmount: () => {},
				}),
				registerInteractiveSigint: () =>
					({
						onSignal: () => {},
						clearPending: () => {},
						dispose: () => {},
					}) as any,
				buildWebOpenUrl: (port, webToken, host) =>
					`http://${host ?? "localhost"}:${port}${webToken ? `/?token=${webToken}` : ""}`,
				openUrl: () => {},
				logOut: () => {},
				logError: () => {},
			},
		);

		expect(bus.events).toContainEqual({
			kind: "warning",
			data: { message: "Web UI URL: http://0.0.0.0:7777/?token=generated-nonce" },
		});
	});

	test("interactive TUI path loads/saves history, submits commands, and cleans up", async () => {
		const bus = new FakeBus();
		const called: string[] = [];
		const added: string[] = [];
		const hints: string[] = [];

		await runInteractiveMode(
			{
				command: { genomePath: "/tmp/genome" },
				sessionId: "01TUI",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01TUI", isRunning: false, currentModel: "fast" },
					logger: { info: () => {} },
					availableModels: ["fast"],
				},
				initialEvents: [],
				cleanupInfra: async () => {
					called.push("cleanup");
				},
				onResumeHint: (sessionId) => {
					hints.push(sessionId);
				},
				inputHistoryPath: () => "/tmp/history",
				handleSlashCommand: async () => ({ action: "none" }),
			},
			{
				createWebServer: async () => ({
					start: async () => {},
					stop: async () => {},
				}),
				runWebOnlyMode: async () => {},
				createInputHistory: async () => ({
					load: async () => {
						called.push("history-load");
					},
					save: async () => {
						called.push("history-save");
					},
					add: (text: string) => {
						added.push(text);
					},
					all: () => [],
				}),
				renderApp: async (renderOpts) => {
					renderOpts.onSubmit("goal text");
					renderOpts.onSteer("steer text");
					return {
						waitUntilExit: async () => {
							called.push("wait-exit");
						},
						unmount: () => {
							called.push("unmount");
						},
					};
				},
				registerInteractiveSigint: () =>
					({
						onSignal: () => {},
						clearPending: () => {},
						dispose: () => {
							called.push("sigint-dispose");
						},
					}) as any,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: () => {},
			},
		);

		expect(bus.commands).toEqual([{ kind: "submit_goal", data: { goal: "goal text" } }]);
		expect(added).toEqual(["goal text", "steer text"]);
		expect(called).toEqual([
			"history-load",
			"wait-exit",
			"sigint-dispose",
			"cleanup",
			"history-save",
		]);
		expect(hints).toEqual(["01TUI"]);
	});

	test("starting /web in a resumed TUI seeds WebServer with initialEvents", async () => {
		const bus = new FakeBus();
		const createWebServerCalls: Array<{ initialEvents?: unknown[] }> = [];
		const resumedEvents = [
			{
				kind: "perceive",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: { goal: "resumed goal" },
			},
		];

		await runInteractiveMode(
			{
				command: { genomePath: "/tmp/genome" },
				sessionId: "01RESUMEWEB",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01RESUMEWEB", isRunning: false, currentModel: "fast" },
					logger: { info: () => {} },
					availableModels: ["fast"],
				},
				initialEvents: resumedEvents as any,
				cleanupInfra: async () => {},
				onResumeHint: () => {},
				inputHistoryPath: () => "/tmp/history",
				handleSlashCommand: async (cmd) =>
					cmd.kind === "web" ? { action: "start_web" } : { action: "none" },
			},
			{
				createWebServer: async (opts) => {
					createWebServerCalls.push({ initialEvents: opts.initialEvents as unknown[] | undefined });
					return {
						start: async () => {},
						stop: async () => {},
					};
				},
				runWebOnlyMode: async () => {},
				createInputHistory: async () => ({
					load: async () => {},
					save: async () => {},
					add: () => {},
					all: () => [],
				}),
				renderApp: async (renderOpts) => {
					await renderOpts.onSlashCommand({ kind: "web" } as any);
					// /web start is launched in a background task.
					await new Promise((resolve) => setTimeout(resolve, 0));
					return {
						waitUntilExit: async () => {},
						unmount: () => {},
					};
				},
				registerInteractiveSigint: () =>
					({
						onSignal: () => {},
						clearPending: () => {},
						dispose: () => {},
					}) as any,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: () => {},
			},
		);

		expect(createWebServerCalls).toHaveLength(1);
		expect(createWebServerCalls[0]!.initialEvents).toEqual(resumedEvents);
	});

	test("web startup failure logs error and cleans up infra", async () => {
		const bus = new FakeBus();
		let cleanupCount = 0;
		const errors: string[] = [];
		let createdHistory = false;

		await runInteractiveMode(
			{
				command: { genomePath: "/tmp/genome", web: true },
				sessionId: "01FAILWEB",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01FAILWEB", isRunning: false, currentModel: undefined },
					logger: { info: () => {} },
					availableModels: [],
				},
				cleanupInfra: async () => {
					cleanupCount++;
				},
				onResumeHint: () => {},
				inputHistoryPath: () => "/tmp/history",
				handleSlashCommand: async () => ({ action: "none" }),
			},
			{
				createWebServer: async () => ({
					start: async () => {
						throw new Error("bind failed");
					},
					stop: async () => {},
				}),
				runWebOnlyMode: async () => {},
				createInputHistory: async () => {
					createdHistory = true;
					return {
						load: async () => {},
						save: async () => {},
						add: () => {},
						all: () => [],
					};
				},
				renderApp: async () => {
					throw new Error("renderApp should not run when web start fails");
				},
				registerInteractiveSigint: () =>
					({
						onSignal: () => {},
						clearPending: () => {},
						dispose: () => {},
					}) as any,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: (line) => {
					errors.push(line);
				},
			},
		);

		expect(cleanupCount).toBe(1);
		expect(createdHistory).toBe(false);
		expect(errors[0]).toContain("Failed to start web server: bind failed");
	});
});
