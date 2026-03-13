import type { AgentSpawner } from "../bus/spawner.ts";
import type { ResultMessage } from "../bus/types.ts";
import type { Genome } from "../genome/genome.ts";
import type { Message } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import { ulid } from "../util/ulid.ts";
import { bootstrapSessionRuntime, type SessionBootstrapOptions } from "./cli-bootstrap.ts";
import type { SessionRunResult } from "./session-controller.ts";

export interface HeadlessInfrastructure {
	spawner: AgentSpawner;
	genome: Genome;
	cleanup: () => Promise<void>;
}

export interface RunHeadlessOptions {
	goal: string;
	genomePath: string;
	projectDataDir: string;
	rootDir: string;
	sessionId?: string;
	initialHistory?: Message[];
	initialSelectionRequest?: SessionSelectionRequest;
	completedHandles?: Array<{
		handleId: string;
		result: ResultMessage;
		ownerId: string;
	}>;
	startBusInfrastructure: (options: {
		genomePath: string;
		sessionId: string;
		rootDir?: string;
	}) => Promise<HeadlessInfrastructure>;
}

interface HeadlessRuntime {
	controller: {
		runGoal(goal: string): Promise<SessionRunResult>;
	};
}

interface HeadlessDeps {
	createSessionId: () => string;
	bootstrapRuntime: (options: SessionBootstrapOptions) => Promise<HeadlessRuntime>;
	writeStdout: (line: string) => void;
	writeStderr: (line: string) => void;
}

export async function runHeadlessMode(
	opts: RunHeadlessOptions,
	deps: Partial<HeadlessDeps> = {},
): Promise<SessionRunResult> {
	const d: HeadlessDeps = {
		createSessionId: deps.createSessionId ?? ulid,
		bootstrapRuntime:
			deps.bootstrapRuntime ??
			(async (options) => {
				const runtime = await bootstrapSessionRuntime(options);
				return {
					controller: runtime.controller as {
						runGoal(goal: string): Promise<SessionRunResult>;
					},
				};
			}),
		writeStdout: deps.writeStdout ?? ((line) => console.log(line)),
		writeStderr: deps.writeStderr ?? ((line) => console.error(line)),
	};

	const sessionId = opts.sessionId ?? d.createSessionId();
	const infra = await opts.startBusInfrastructure({
		genomePath: opts.genomePath,
		sessionId,
		rootDir: opts.rootDir,
	});

	try {
		const runtime = await d.bootstrapRuntime({
			genomePath: opts.genomePath,
			projectDataDir: opts.projectDataDir,
			rootDir: opts.rootDir,
			sessionId,
			initialHistory: opts.initialHistory,
			initialSelectionRequest: opts.initialSelectionRequest,
			completedHandles: opts.completedHandles,
			infra,
		});
		const result = await runtime.controller.runGoal(opts.goal);
		if (result.output) {
			d.writeStdout(result.output);
		}
		d.writeStderr(`Session: ${result.sessionId}`);
		return result;
	} finally {
		await infra.cleanup();
	}
}
