import { join } from "node:path";
import { TUI_INITIAL_EVENT_CAP } from "../kernel/constants.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { SlashCommand } from "../tui/slash-commands.ts";
import type { PricingTable } from "../kernel/pricing.ts";
import { registerInteractiveSigint } from "./cli-sigint.ts";
import { buildWebOpenUrl, runWebOnlyMode } from "./cli-web.ts";
import { loadPricingTable } from "./pricing-cache.ts";

type SlashAction = "none" | "show_model_picker" | "start_web" | "stop_web" | "exit";

interface BusLike {
	emitCommand(cmd: { kind: string; data: Record<string, unknown> }): void;
	emitEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown>): void;
	onCommand?(listener: (cmd: { kind: string; data: Record<string, unknown> }) => void): void;
}

interface ControllerLike {
	sessionId: string;
	isRunning: boolean;
	currentModel: string | undefined;
}

interface LoggerLike {
	info(category: string, message: string, data?: Record<string, unknown>): void;
}

interface InputHistoryLike {
	load(): Promise<void>;
	save(): Promise<void>;
	add(text: string): void;
	all(): string[];
}

interface WebServerLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	getWebToken?(): string | undefined;
}

export interface InteractiveCommandFlags {
	genomePath: string;
	web?: boolean;
	webOnly?: boolean;
	port?: number;
	host?: string;
	webToken?: string;
}

export interface InteractiveModeOptions {
	command: InteractiveCommandFlags;
	sessionId: string;
	projectDataDir: string;
	runtime: {
		bus: BusLike;
		controller: ControllerLike;
		logger: LoggerLike;
		availableModels: string[];
	};
	initialEvents?: SessionEvent[];
	cleanupInfra: () => Promise<void>;
	onResumeHint: (sessionId: string) => void;
	inputHistoryPath: (genomePath: string) => string;
	handleSlashCommand: (
		cmd: SlashCommand,
		bus: BusLike,
		controller: ControllerLike,
	) => Promise<{ action: SlashAction }>;
}

interface RenderAppOptions {
	bus: BusLike;
	sessionId: string;
	initialHistory: string[];
	initialEvents?: SessionEvent[];
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => Promise<void>;
	onSteer: (text: string) => void;
	onExit: () => void;
}

interface InteractiveModeDeps {
	createWebServer: (opts: {
		bus: BusLike;
		port: number;
		staticDir: string;
		sessionId: string;
		hostname?: string;
		webToken?: string;
		initialEvents?: SessionEvent[];
		availableModels: string[];
		logger: LoggerLike;
		projectDataDir?: string;
		pricingTable?: PricingTable | null;
	}) => Promise<WebServerLike>;
	runWebOnlyMode: typeof runWebOnlyMode;
	createInputHistory: (historyPath: string) => Promise<InputHistoryLike>;
	renderApp: (opts: RenderAppOptions) => Promise<{
		waitUntilExit: () => Promise<unknown>;
		unmount: () => void;
	}>;
	registerInteractiveSigint: typeof registerInteractiveSigint;
	buildWebOpenUrl: typeof buildWebOpenUrl;
	openUrl: (url: string) => void;
	logOut: (line: string) => void;
	logError: (line: string) => void;
}

function isLoopbackHost(hostname: string | undefined): boolean {
	const host = hostname ?? "localhost";
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export async function runInteractiveMode(
	opts: InteractiveModeOptions,
	deps: Partial<InteractiveModeDeps> = {},
): Promise<void> {
	const d: InteractiveModeDeps = {
		createWebServer:
			deps.createWebServer ??
			(async (serverOpts) => {
				const { WebServer } = await import("../web/server.ts");
				return new WebServer({
					bus: serverOpts.bus as any,
					port: serverOpts.port,
					staticDir: serverOpts.staticDir,
					sessionId: serverOpts.sessionId,
					hostname: serverOpts.hostname,
					webToken: serverOpts.webToken,
					initialEvents: serverOpts.initialEvents,
					availableModels: serverOpts.availableModels,
					logger: serverOpts.logger as any,
					projectDataDir: serverOpts.projectDataDir,
					pricingTable: serverOpts.pricingTable,
				});
			}),
		runWebOnlyMode: deps.runWebOnlyMode ?? runWebOnlyMode,
		createInputHistory:
			deps.createInputHistory ??
			(async (historyPath) => {
				const { InputHistory } = await import("../tui/history.ts");
				return new InputHistory(historyPath);
			}),
		renderApp:
			deps.renderApp ??
			(async (renderOpts) => {
				const { render } = await import("ink");
				const React = await import("react");
				const { App } = await import("../tui/app.tsx");
				return render(
					React.createElement(App as any, {
						bus: renderOpts.bus,
						sessionId: renderOpts.sessionId,
						initialHistory: renderOpts.initialHistory,
						initialEvents: renderOpts.initialEvents,
						onSubmit: renderOpts.onSubmit,
						onSlashCommand: renderOpts.onSlashCommand,
						onSteer: renderOpts.onSteer,
						onExit: renderOpts.onExit,
					}),
					{ exitOnCtrlC: false, kittyKeyboard: { mode: "enabled" as const } },
				);
			}),
		registerInteractiveSigint: deps.registerInteractiveSigint ?? registerInteractiveSigint,
		buildWebOpenUrl: deps.buildWebOpenUrl ?? buildWebOpenUrl,
		openUrl: deps.openUrl ?? ((url) => void Bun.spawn(["open", url])),
		logOut: deps.logOut ?? ((line) => console.log(line)),
		logError: deps.logError ?? ((line) => console.error(line)),
	};

	const webPort = opts.command.port ?? 7777;
	const webHost = opts.command.host;
	const displayHost = webHost ?? "localhost";
	const webToken = opts.command.webToken ?? process.env.SPROUT_WEB_TOKEN;
	const staticDir = join(import.meta.dir, "../../web/dist");
	let webServer: WebServerLike | null = null;
	const projectDataDir =
		opts.projectDataDir ?? process.env.SPROUT_PROJECT_DATA_DIR ?? process.env.SPROUT_GENOME_PATH;
	const shouldExposeTokenInUi = !isLoopbackHost(displayHost);
	const currentWebToken = () => webServer?.getWebToken?.() ?? webToken;
	const buildUiWebUrl = () =>
		d.buildWebOpenUrl(webPort, shouldExposeTokenInUi ? currentWebToken() : undefined, displayHost);
	const buildLocalWebOpenUrl = () => d.buildWebOpenUrl(webPort, currentWebToken());
	const emitWebUiHint = () => {
		if (!webServer) return;
		opts.runtime.bus.emitEvent("warning", "cli", 0, {
			message: `Web UI URL: ${buildUiWebUrl()}`,
		});
	};

	const pricingTable = await loadPricingTable(opts.command.genomePath);

	if (opts.command.web || opts.command.webOnly) {
		webServer = await d.createWebServer({
			bus: opts.runtime.bus,
			port: webPort,
			staticDir,
			sessionId: opts.sessionId,
			hostname: webHost,
			webToken,
			initialEvents: opts.initialEvents,
			availableModels: opts.runtime.availableModels,
			logger: opts.runtime.logger,
			projectDataDir,
			pricingTable,
		});
		try {
			await webServer.start();
		} catch (err) {
			await opts.cleanupInfra();
			d.logError(`Failed to start web server: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const effectiveWebToken = currentWebToken();
		opts.runtime.logger.info("session", "Web server started", { host: displayHost, port: webPort });
		d.logError(`Web UI: http://${displayHost}:${webPort}`);
		if (!isLoopbackHost(displayHost) && effectiveWebToken) {
			d.logOut(`Web nonce: ${effectiveWebToken}`);
			d.logOut(`Web UI URL: ${d.buildWebOpenUrl(webPort, effectiveWebToken, displayHost)}`);
		} else if (effectiveWebToken) {
			d.logError("Web auth enabled. Open with ?token=<your-token>.");
		}
	}

	if (opts.command.webOnly) {
		await d.runWebOnlyMode({
			bus: opts.runtime.bus as any,
			stopWebServer: async () => {
				await webServer!.stop();
			},
			cleanupInfra: opts.cleanupInfra,
			onResumeHint: opts.onResumeHint,
			sessionId: opts.runtime.controller.sessionId,
		});
		return;
	}

	const historyPath = opts.inputHistoryPath(opts.command.genomePath);
	const inputHistory = await d.createInputHistory(historyPath);
	await inputHistory.load();
	const initialTuiEvents =
		opts.initialEvents && opts.initialEvents.length > TUI_INITIAL_EVENT_CAP
			? opts.initialEvents.slice(-TUI_INITIAL_EVENT_CAP)
			: opts.initialEvents;

	let unmountFn: (() => void) | undefined;
	const sigintRegistration = d.registerInteractiveSigint({
		bus: opts.runtime.bus as any,
		controller: opts.runtime.controller,
		onExitNow: () => {
			unmountFn?.();
		},
	});

	try {
		const { waitUntilExit, unmount } = await d.renderApp({
			bus: opts.runtime.bus,
			sessionId: opts.runtime.controller.sessionId,
			initialHistory: inputHistory.all(),
			initialEvents: initialTuiEvents,
			onSubmit: (text: string) => {
				inputHistory.add(text);
				opts.runtime.bus.emitCommand({ kind: "submit_goal", data: { goal: text } });
			},
			onSlashCommand: async (cmd: SlashCommand) => {
				const result = await opts.handleSlashCommand(
					cmd,
					opts.runtime.bus,
					opts.runtime.controller,
				);
				if (result.action === "exit") unmountFn?.();
				else if (result.action === "start_web") {
					if (webServer) {
						emitWebUiHint();
					} else {
						(async () => {
							try {
								webServer = await d.createWebServer({
									bus: opts.runtime.bus,
									port: webPort,
									staticDir,
									sessionId: opts.sessionId,
									hostname: webHost,
									webToken,
									initialEvents: opts.initialEvents,
									availableModels: opts.runtime.availableModels,
									logger: opts.runtime.logger,
									projectDataDir,
									pricingTable,
								});
								await webServer.start();
								emitWebUiHint();
								// TODO: macOS-only. On Linux use xdg-open, on Windows use start.
								d.openUrl(buildLocalWebOpenUrl());
							} catch (err) {
								opts.runtime.bus.emitEvent("error", "cli", 0, { error: String(err) });
							}
						})();
					}
				} else if (result.action === "stop_web") {
					if (webServer) {
						const server = webServer;
						webServer = null;
						(async () => {
							try {
								await server.stop();
								opts.runtime.bus.emitEvent("warning", "cli", 0, { message: "Web server stopped." });
							} catch (err) {
								opts.runtime.bus.emitEvent("error", "cli", 0, { error: String(err) });
							}
						})();
					} else {
						opts.runtime.bus.emitEvent("warning", "cli", 0, {
							message: "Web server is not running.",
						});
					}
				}
			},
			onSteer: (text: string) => {
				inputHistory.add(text);
			},
			onExit: () => {
				opts.runtime.bus.emitCommand({ kind: "quit", data: {} });
				unmountFn?.();
			},
		});
		unmountFn = unmount;
		emitWebUiHint();

		await waitUntilExit();
	} finally {
		sigintRegistration.dispose();
		if (webServer) await webServer.stop();
		await opts.cleanupInfra();
		await inputHistory.save();
	}

	opts.onResumeHint(opts.runtime.controller.sessionId);
}
