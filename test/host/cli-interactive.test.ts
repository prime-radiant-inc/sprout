import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWebBuildFreshness, runInteractiveMode } from "../../src/host/cli-interactive.ts";
import { EVENT_CAP, TUI_INITIAL_EVENT_CAP } from "../../src/kernel/constants.ts";

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
	test("web freshness treats public files as build inputs", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-web-freshness-"));
		try {
			const webRoot = join(root, "web");
			const staticDir = join(webRoot, "dist");
			const publicFile = join(webRoot, "public", "mockups", "tool-row-treatments.html");
			const oldInputs = [
				join(webRoot, "bun.lock"),
				join(webRoot, "index.html"),
				join(webRoot, "package.json"),
				join(webRoot, "src", "main.tsx"),
				join(webRoot, "tsconfig.json"),
				join(webRoot, "vite-env.d.ts"),
				join(webRoot, "vite.config.ts"),
			];
			const distFile = join(staticDir, "index.html");
			const oldTime = new Date("2026-01-01T00:00:00.000Z");
			const buildTime = new Date("2026-01-02T00:00:00.000Z");
			const publicTime = new Date("2026-01-03T00:00:00.000Z");

			await mkdir(join(webRoot, "public", "mockups"), { recursive: true });
			await mkdir(join(webRoot, "src"), { recursive: true });
			await mkdir(staticDir, { recursive: true });
			for (const file of oldInputs) {
				await writeFile(file, "input");
				await utimes(file, oldTime, oldTime);
			}
			await writeFile(distFile, "<html></html>");
			await utimes(distFile, buildTime, buildTime);
			await writeFile(publicFile, "<html>new public asset</html>");
			await utimes(publicFile, publicTime, publicTime);

			expect(await checkWebBuildFreshness(staticDir)).toBe("stale");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("web-only path delegates to runWebOnlyMode and skips TUI setup", async () => {
		const bus = new FakeBus();
		const called: string[] = [];
		const oauthReturnUrls: Array<string | undefined> = [];

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
					setOpenAICodexOAuthReturnUrl: (url?: string) => {
						oauthReturnUrls.push(url);
					},
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
					getWebToken: () => "generated-nonce",
				}),
				ensureWebBuildFreshness: async () => {
					called.push("web-assets");
					return undefined;
				},
				runWebOnlyMode: async (opts) => {
					called.push("web-only");
					await opts.stopWebServer();
					await opts.cleanupInfra();
					opts.onResumeHint(opts.sessionId);
				},
				createInputHistory: async () => {
					throw new Error("history should not be created in web-only mode");
				},
				loadPricingSnapshot: async () => null,
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
				logError: () => {},
			},
		);

		expect(called).toEqual([
			"web-assets",
			"web-start",
			"web-only",
			"web-stop",
			"cleanup",
			"resume",
		]);
		expect(oauthReturnUrls).toEqual([
			"http://localhost:7777/?token=generated-nonce&settings=providers&provider=openai-codex",
			undefined,
		]);
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
				ensureWebBuildFreshness: async () => undefined,
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
				loadPricingSnapshot: async () => null,
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
				ensureWebBuildFreshness: async () => undefined,
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
				loadPricingSnapshot: async () => null,
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

	test("builds stale web assets before starting web server", async () => {
		const bus = new FakeBus();
		const called: string[] = [];
		const stderr: string[] = [];

		await runInteractiveMode(
			{
				command: {
					genomePath: "/tmp/genome",
					webOnly: true,
					web: true,
				},
				sessionId: "01STALEWEB",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01STALEWEB", isRunning: false, currentModel: undefined },
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
					start: async () => {
						called.push("web-start");
					},
					stop: async () => {
						called.push("web-stop");
					},
				}),
				ensureWebBuildFreshness: async () => {
					called.push("web-assets");
					return "Web UI assets were stale; rebuilt web bundle.";
				},
				runWebOnlyMode: async (opts) => {
					called.push("web-only");
					await opts.stopWebServer();
					await opts.cleanupInfra();
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
				loadPricingSnapshot: async () => null,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: (line) => {
					stderr.push(line);
				},
			},
		);

		expect(called).toEqual(["web-assets", "web-start", "web-only", "web-stop"]);
		expect(stderr).toContain("Web UI assets were stale; rebuilt web bundle.");
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
				loadPricingSnapshot: async () => null,
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

	test("interactive TUI passes model and settings context into App", async () => {
		const bus = new FakeBus();
		const settingsControlPlane = {
			execute: async () => ({
				ok: true as const,
				snapshot: {
					settings: {
						version: 1,
						providers: [],
						defaults: {},
					},
					providers: [],
					catalog: [],
				},
			}),
		};
		const currentSelection = {
			selection: {
				kind: "model" as const,
				model: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
			},
			resolved: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
			source: "session" as const,
		};
		const renderAppCalls: Array<{
			knownModels: string[];
			initialSelection?: unknown;
			settingsControlPlane?: unknown;
		}> = [];

		await runInteractiveMode(
			{
				command: { genomePath: "/tmp/genome" },
				sessionId: "01TUICTX",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: {
						sessionId: "01TUICTX",
						isRunning: false,
						currentModel: "claude-sonnet-4-6",
						currentSelection,
					},
					logger: { info: () => {} },
					availableModels: ["best", "claude-sonnet-4-6", "qwen2.5-coder"],
					settingsControlPlane: settingsControlPlane as any,
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
				}),
				runWebOnlyMode: async () => {},
				createInputHistory: async () => ({
					load: async () => {},
					save: async () => {},
					add: () => {},
					all: () => [],
				}),
				renderApp: async (renderOpts) => {
					renderAppCalls.push({
						knownModels: renderOpts.knownModels,
						initialSelection: renderOpts.initialSelection,
						settingsControlPlane: renderOpts.settingsControlPlane,
					});
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
				loadPricingSnapshot: async () => null,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: () => {},
			},
		);

		expect(renderAppCalls).toHaveLength(1);
		expect(renderAppCalls[0]!.knownModels).toEqual(["best", "claude-sonnet-4-6", "qwen2.5-coder"]);
		expect(renderAppCalls[0]!.initialSelection).toEqual(currentSelection);
		expect(renderAppCalls[0]!.settingsControlPlane).toBe(settingsControlPlane);
	});

	test("starting /web in a resumed TUI seeds WebServer with initialEvents", async () => {
		const bus = new FakeBus();
		let assetPrepareCount = 0;
		const createWebServerCalls: Array<{
			initialEvents?: unknown[];
			settingsControlPlane?: unknown;
			getSessionSelection?: (() => unknown) | undefined;
		}> = [];
		const resumedEvents = [
			{
				kind: "perceive",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: { goal: "resumed goal" },
			},
		];
		const currentSelection = {
			selection: { kind: "tier", tier: "fast" },
			source: "session",
		} as const;
		const settingsControlPlane = {
			execute: async () => {
				throw new Error("unused");
			},
		};

		await runInteractiveMode(
			{
				command: { genomePath: "/tmp/genome" },
				sessionId: "01RESUMEWEB",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: {
						sessionId: "01RESUMEWEB",
						isRunning: false,
						currentModel: "fast",
						currentSelection,
					},
					logger: { info: () => {} },
					availableModels: ["fast"],
					settingsControlPlane: settingsControlPlane as any,
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
					createWebServerCalls.push({
						initialEvents: opts.initialEvents as unknown[] | undefined,
						settingsControlPlane: opts.settingsControlPlane,
						getSessionSelection: opts.getSessionSelection,
					});
					return {
						start: async () => {},
						stop: async () => {},
					};
				},
				ensureWebBuildFreshness: async () => {
					assetPrepareCount++;
					return undefined;
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
				loadPricingSnapshot: async () => null,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: () => {},
			},
		);

		expect(assetPrepareCount).toBe(1);
		expect(createWebServerCalls).toHaveLength(1);
		expect(createWebServerCalls[0]!.initialEvents).toEqual(resumedEvents);
		expect(createWebServerCalls[0]!.settingsControlPlane).toBe(settingsControlPlane);
		expect(createWebServerCalls[0]!.getSessionSelection?.()).toEqual(currentSelection);
	});

	test("resumed TUI caps initialEvents passed to renderApp but not WebServer", async () => {
		const bus = new FakeBus();
		const resumedEvents = Array.from({ length: EVENT_CAP + 2 }, (_, index) => ({
			kind: "warning" as const,
			timestamp: index + 1,
			agent_id: "cli",
			depth: 0,
			data: { message: `event-${index + 1}` },
		}));
		const createWebServerCalls: Array<{ initialEvents?: unknown[] }> = [];
		const renderAppCalls: Array<{ initialEvents?: unknown[] }> = [];

		await runInteractiveMode(
			{
				command: { genomePath: "/tmp/genome", web: true },
				sessionId: "01CAPTUI",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01CAPTUI", isRunning: false, currentModel: "fast" },
					logger: { info: () => {} },
					availableModels: ["fast"],
				},
				initialEvents: resumedEvents as any,
				cleanupInfra: async () => {},
				onResumeHint: () => {},
				inputHistoryPath: () => "/tmp/history",
				handleSlashCommand: async () => ({ action: "none" }),
			},
			{
				createWebServer: async (opts) => {
					createWebServerCalls.push({ initialEvents: opts.initialEvents as unknown[] | undefined });
					return {
						start: async () => {},
						stop: async () => {},
					};
				},
				ensureWebBuildFreshness: async () => undefined,
				runWebOnlyMode: async () => {},
				createInputHistory: async () => ({
					load: async () => {},
					save: async () => {},
					add: () => {},
					all: () => [],
				}),
				renderApp: async (renderOpts) => {
					renderAppCalls.push({ initialEvents: renderOpts.initialEvents as unknown[] | undefined });
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
				loadPricingSnapshot: async () => null,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: () => {},
			},
		);

		expect(createWebServerCalls).toHaveLength(1);
		expect((createWebServerCalls[0]!.initialEvents as unknown[]).length).toBe(EVENT_CAP + 2);
		expect(renderAppCalls).toHaveLength(1);
		expect((renderAppCalls[0]!.initialEvents as unknown[]).length).toBe(TUI_INITIAL_EVENT_CAP);
		expect(renderAppCalls[0]!.initialEvents).toEqual(resumedEvents.slice(-TUI_INITIAL_EVENT_CAP));
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
				ensureWebBuildFreshness: async () => undefined,
				loadPricingSnapshot: async () => null,
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

	test("web asset build failure logs error and skips web startup", async () => {
		const bus = new FakeBus();
		let cleanupCount = 0;
		const errors: string[] = [];
		let createdHistory = false;

		await runInteractiveMode(
			{
				command: { genomePath: "/tmp/genome", web: true },
				sessionId: "01FAILASSETS",
				projectDataDir: "/tmp/project-data",
				runtime: {
					bus: bus as any,
					controller: { sessionId: "01FAILASSETS", isRunning: false, currentModel: undefined },
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
				createWebServer: async () => {
					throw new Error("createWebServer should not run when asset build fails");
				},
				ensureWebBuildFreshness: async () => {
					throw new Error("vite failed");
				},
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
					throw new Error("renderApp should not run when web asset build fails");
				},
				registerInteractiveSigint: () =>
					({
						onSignal: () => {},
						clearPending: () => {},
						dispose: () => {},
					}) as any,
				loadPricingSnapshot: async () => null,
				buildWebOpenUrl: () => "http://localhost:7777",
				openUrl: () => {},
				logError: (line) => {
					errors.push(line);
				},
			},
		);

		expect(cleanupCount).toBe(1);
		expect(createdHistory).toBe(false);
		expect(errors[0]).toContain("Failed to prepare web UI assets: vite failed");
	});
});
