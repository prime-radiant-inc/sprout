import type { AgentSpawner } from "../bus/spawner.ts";
import type { ResultMessage } from "../bus/types.ts";
import type { Genome } from "../genome/genome.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import { ulid } from "../util/ulid.ts";
import { VERSION } from "../version.ts";
import { createAtifRecorder } from "./atif/recorder.ts";
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
	atifPath?: string;
	evalMode?: boolean;
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
	bus?: {
		onEvent(listener: (event: SessionEvent) => void): () => void;
	};
	controller: {
		runGoal(goal: string): Promise<SessionRunResult>;
	};
}

function requireHeadlessRuntimeController(controller: unknown): HeadlessRuntime["controller"] {
	const candidate =
		controller && typeof controller === "object"
			? (controller as { runGoal?: unknown })
			: undefined;
	if (typeof candidate?.runGoal === "function") {
		return controller as HeadlessRuntime["controller"];
	}
	throw new Error("Shared session runtime does not expose runGoal()");
}

function requireHeadlessRuntimeBus(bus: unknown): NonNullable<HeadlessRuntime["bus"]> {
	const candidate = bus && typeof bus === "object" ? (bus as { onEvent?: unknown }) : undefined;
	if (typeof candidate?.onEvent === "function") {
		return bus as NonNullable<HeadlessRuntime["bus"]>;
	}
	throw new Error("Shared session runtime does not expose an event bus for ATIF logging");
}

interface HeadlessAtifRecorder {
	recordEvent(event: SessionEvent): void;
	close(): Promise<void>;
}

interface HeadlessDeps {
	createSessionId: () => string;
	bootstrapRuntime: (options: SessionBootstrapOptions) => Promise<HeadlessRuntime>;
	createAtifRecorder: (options: {
		outputPath: string;
		sessionId: string;
		agentName: string;
		agentVersion: string;
	}) => Promise<HeadlessAtifRecorder>;
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
					bus: runtime.bus as HeadlessRuntime["bus"],
					controller: runtime.controller as {
						runGoal(goal: string): Promise<SessionRunResult>;
					},
				};
			}),
		createAtifRecorder: deps.createAtifRecorder ?? createAtifRecorder,
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
			atifPath: opts.atifPath,
			evalMode: opts.evalMode,
			initialHistory: opts.initialHistory,
			initialSelectionRequest: opts.initialSelectionRequest,
			completedHandles: opts.completedHandles,
			infra,
		});
		const recorder = opts.atifPath
			? await d.createAtifRecorder({
					outputPath: opts.atifPath,
					sessionId,
					agentName: "sprout",
					agentVersion: VERSION,
				})
			: null;
		const unsubscribeAtif = recorder
			? requireHeadlessRuntimeBus(runtime.bus).onEvent((event) => {
					recorder.recordEvent(event);
				})
			: null;
		const controller = requireHeadlessRuntimeController(runtime.controller);
		try {
			const result = await controller.runGoal(opts.goal);
			if (result.output) {
				d.writeStdout(result.output);
			}
			d.writeStderr(`Session: ${result.sessionId}`);
			return result;
		} finally {
			unsubscribeAtif?.();
			await recorder?.close();
		}
	} finally {
		await infra.cleanup();
	}
}
