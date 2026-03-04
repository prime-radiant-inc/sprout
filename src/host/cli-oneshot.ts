import { join } from "node:path";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { Genome } from "../genome/genome.ts";
import { Client } from "../llm/client.ts";
import { loggingMiddleware } from "../llm/logging-middleware.ts";
import { renderEvent } from "../tui/render-event.ts";
import { ulid } from "../util/ulid.ts";
import { EventBus } from "./event-bus.ts";
import { SessionLogger } from "./logger.ts";
import { SessionController } from "./session-controller.ts";

export interface OneshotInfrastructure {
	spawner: AgentSpawner;
	genome: Genome;
	cleanup: () => Promise<void>;
}

interface OneshotDeps {
	createSessionId: () => string;
	createBus: () => unknown;
	createLogger: (opts: {
		logPath: string;
		component: string;
		sessionId: string;
		bus: unknown;
	}) => unknown;
	createClient: (logger: unknown) => Promise<unknown>;
	createController: (opts: {
		bus: unknown;
		genomePath: string;
		projectDataDir: string;
		rootDir: string;
		sessionId: string;
		spawner: AgentSpawner;
		genome: Genome;
		logger: unknown;
		client: unknown;
	}) => { sessionId: string; submitGoal(goal: string): Promise<void> };
	subscribeBusEvents: (bus: unknown, listener: (event: unknown) => void) => void;
	renderEventLine: (event: unknown) => string | null;
	writeLine: (line: string) => void;
}

export async function runOneshotMode(
	opts: {
		goal: string;
		genomePath: string;
		projectDataDir: string;
		rootDir: string;
		startBusInfrastructure: (options: {
			genomePath: string;
			sessionId: string;
			rootDir?: string;
		}) => Promise<OneshotInfrastructure>;
		onResumeHint: (sessionId: string) => void;
	},
	deps: Partial<OneshotDeps> = {},
): Promise<void> {
	const d: OneshotDeps = {
		createSessionId: deps.createSessionId ?? ulid,
		createBus: deps.createBus ?? (() => new EventBus()),
		createLogger:
			deps.createLogger ??
			((loggerOpts) => {
				return new SessionLogger({
					logPath: loggerOpts.logPath,
					component: loggerOpts.component,
					sessionId: loggerOpts.sessionId,
					bus: loggerOpts.bus as EventBus,
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
					spawner: controllerOpts.spawner,
					genome: controllerOpts.genome,
					logger: controllerOpts.logger as SessionLogger,
					client: controllerOpts.client as Client,
				});
			}),
		subscribeBusEvents:
			deps.subscribeBusEvents ??
			((bus, listener) => {
				(bus as EventBus).onEvent(listener as (event: any) => void);
			}),
		renderEventLine: deps.renderEventLine ?? ((event) => renderEvent(event as any)),
		writeLine: deps.writeLine ?? ((line) => console.log(line)),
	};

	const sessionId = d.createSessionId();
	const infra = await opts.startBusInfrastructure({
		genomePath: opts.genomePath,
		sessionId,
		rootDir: opts.rootDir,
	});

	const bus = d.createBus();
	const logPath = join(opts.projectDataDir, "logs", sessionId, "session.log.jsonl");
	const logger = d.createLogger({ logPath, component: "cli", sessionId, bus });
	const llmClient = await d.createClient(logger);
	const controller = d.createController({
		bus,
		genomePath: opts.genomePath,
		projectDataDir: opts.projectDataDir,
		rootDir: opts.rootDir,
		sessionId,
		spawner: infra.spawner,
		genome: infra.genome,
		logger,
		client: llmClient,
	});

	d.subscribeBusEvents(bus, (event) => {
		const line = d.renderEventLine(event);
		if (line !== null) d.writeLine(line);
	});

	try {
		await controller.submitGoal(opts.goal);
		opts.onResumeHint(controller.sessionId);
	} finally {
		await infra.cleanup();
	}
}
