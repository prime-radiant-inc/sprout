import { join } from "node:path";
import { getAvailableModels } from "../agents/model-resolver.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { ResultMessage } from "../bus/types.ts";
import type { Genome } from "../genome/genome.ts";
import { Client } from "../llm/client.ts";
import { loggingMiddleware } from "../llm/logging-middleware.ts";
import type { Message } from "../llm/types.ts";
import { EventBus } from "./event-bus.ts";
import { SessionLogger } from "./logger.ts";
import { SessionController } from "./session-controller.ts";

export type StderrLevel = "debug" | "info" | undefined;

export function resolveStderrLevel(opts: { logStderr?: boolean; debug?: boolean }): StderrLevel {
	if (!opts.logStderr) return undefined;
	return opts.debug ? "debug" : "info";
}

export interface InteractiveBootstrapOptions {
	genomePath: string;
	projectDataDir: string;
	rootDir: string;
	sessionId: string;
	initialHistory?: Message[];
	completedHandles?: Array<{ handleId: string; result: ResultMessage; ownerId: string }>;
	infra: { spawner: AgentSpawner; genome: Genome };
	logStderr?: boolean;
	debug?: boolean;
}

interface InteractiveBootstrapDeps {
	createBus: () => unknown;
	createLogger: (opts: {
		logPath: string;
		component: string;
		sessionId: string;
		bus: unknown;
		stderrLevel?: "debug" | "info";
	}) => unknown;
	createClient: (logger: unknown) => Promise<unknown>;
	createController: (opts: {
		bus: unknown;
		genomePath: string;
		projectDataDir: string;
		rootDir: string;
		sessionId: string;
		initialHistory?: Message[];
		spawner: AgentSpawner;
		genome: Genome;
		completedHandles?: Array<{ handleId: string; result: ResultMessage; ownerId: string }>;
		logger: unknown;
		client: unknown;
	}) => unknown;
	loadAvailableModels: (client: unknown) => Promise<string[]>;
	onLoggingEnabled: (logger: unknown, level: "debug" | "info", sessionId: string) => void;
}

export async function bootstrapInteractiveRuntime(
	opts: InteractiveBootstrapOptions,
	deps: Partial<InteractiveBootstrapDeps> = {},
): Promise<{
	bus: unknown;
	logger: unknown;
	llmClient: unknown;
	controller: unknown;
	availableModels: string[];
}> {
	const d: InteractiveBootstrapDeps = {
		createBus: deps.createBus ?? (() => new EventBus()),
		createLogger:
			deps.createLogger ??
			((loggerOpts) => {
				return new SessionLogger({
					logPath: loggerOpts.logPath,
					component: loggerOpts.component,
					sessionId: loggerOpts.sessionId,
					bus: loggerOpts.bus as EventBus,
					stderrLevel: loggerOpts.stderrLevel,
				});
			}),
		createClient:
			deps.createClient ??
			(async (logger) => {
				return Client.fromEnv({
					middleware: [loggingMiddleware(logger as SessionLogger)],
				});
			}),
		createController:
			deps.createController ??
			((controllerOpts) => {
				return new SessionController({
					bus: controllerOpts.bus as EventBus,
					genomePath: controllerOpts.genomePath,
					projectDataDir: controllerOpts.projectDataDir,
					rootDir: controllerOpts.rootDir,
					sessionId: controllerOpts.sessionId,
					initialHistory: controllerOpts.initialHistory,
					spawner: controllerOpts.spawner,
					genome: controllerOpts.genome,
					completedHandles: controllerOpts.completedHandles,
					logger: controllerOpts.logger as SessionLogger,
					client: controllerOpts.client as Client,
				});
			}),
		loadAvailableModels:
			deps.loadAvailableModels ??
			(async (client) => {
				const modelsByProvider = await (client as Client).listModelsByProvider();
				return getAvailableModels(modelsByProvider);
			}),
		onLoggingEnabled:
			deps.onLoggingEnabled ??
			((logger, level, sessionId) => {
				(logger as SessionLogger).info("session", "Logging to stderr enabled", {
					level,
					sessionId,
				});
			}),
	};

	const bus = d.createBus();
	const logPath = join(opts.projectDataDir, "logs", opts.sessionId, "session.log.jsonl");
	const stderrLevel = resolveStderrLevel({
		logStderr: opts.logStderr,
		debug: opts.debug,
	});
	const logger = d.createLogger({
		logPath,
		component: "cli",
		sessionId: opts.sessionId,
		bus,
		stderrLevel,
	});
	if (stderrLevel) {
		d.onLoggingEnabled(logger, stderrLevel, opts.sessionId);
	}

	const llmClient = await d.createClient(logger);
	const controller = d.createController({
		bus,
		genomePath: opts.genomePath,
		projectDataDir: opts.projectDataDir,
		rootDir: opts.rootDir,
		sessionId: opts.sessionId,
		initialHistory: opts.initialHistory,
		spawner: opts.infra.spawner,
		genome: opts.infra.genome,
		completedHandles: opts.completedHandles,
		logger,
		client: llmClient,
	});
	const availableModels = await d.loadAvailableModels(llmClient);

	return { bus, logger, llmClient, controller, availableModels };
}
