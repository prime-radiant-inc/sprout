import { resolve } from "node:path";
import { ulid } from "../util/ulid.ts";
import type { BusClient } from "./client.ts";
import { agentEvents, agentInbox, agentReady, agentResult } from "./topics.ts";
import type {
	CallerIdentity,
	ContinueMessage,
	EventMessage,
	ResultMessage,
	StartMessage,
	SteerMessage,
} from "./types.ts";
import { parseBusMessage } from "./types.ts";

/** Options for spawning a new agent */
export interface SpawnAgentOptions {
	agentName: string;
	genomePath: string;
	caller: CallerIdentity;
	goal: string;
	hints?: string[];
	blocking: boolean;
	shared: boolean;
	workDir: string;
	/** Pre-assigned handle ID. If omitted, a new ULID is generated. */
	handleId?: string;
	/** Override agent_id for events emitted by the child. */
	agentId?: string;
}

/** Internal tracking record for a spawned agent */
export interface AgentHandle {
	handleId: string;
	process: { kill: () => void; exited: Promise<number> };
	status: "running" | "idle" | "completed";
	result?: ResultMessage;
	shared: boolean;
	resultResolvers: Array<(result: ResultMessage) => void>;
	/** agent_name of the parent who spawned this handle */
	ownerId: string;
	/** Original spawn options needed for re-spawning completed agents */
	agentName: string;
	genomePath: string;
	caller: CallerIdentity;
	workDir: string;
}

/**
 * Function that spawns an agent process. In production uses Bun.spawn();
 * in tests can use runAgentProcess() in-process.
 */
export type SpawnFn = (
	handleId: string,
	env: Record<string, string>,
) => { kill: () => void; exited: Promise<number> };

/** Default spawn function using Bun.spawn() */
function defaultSpawnFn(
	_handleId: string,
	env: Record<string, string>,
): {
	kill: () => void;
	exited: Promise<number>;
} {
	const agentProcessPath = resolve(import.meta.dir, "agent-process.ts");
	const proc = Bun.spawn(["bun", "run", agentProcessPath], {
		env: { ...process.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		kill: () => proc.kill(),
		exited: proc.exited,
	};
}

/**
 * Manages the lifecycle of agent subprocesses.
 *
 * Spawns agent processes, publishes start messages, tracks status,
 * and provides methods to wait for results or send follow-up messages.
 */
export class AgentSpawner {
	private readonly bus: BusClient;
	private readonly busUrl: string;
	private readonly sessionId: string;
	private readonly spawnFn: SpawnFn;
	private readonly waitTimeoutMs: number;
	private readonly handles = new Map<string, AgentHandle>();
	private eventCallback?: (event: EventMessage) => void;

	constructor(
		bus: BusClient,
		busUrl: string,
		sessionId: string,
		spawnFn?: SpawnFn,
		waitTimeoutMs?: number,
	) {
		this.bus = bus;
		this.busUrl = busUrl;
		this.sessionId = sessionId;
		this.spawnFn = spawnFn ?? defaultSpawnFn;
		this.waitTimeoutMs = waitTimeoutMs ?? 120_000;
	}

	/** Register a callback to receive events from all spawned sub-agents. */
	onEvent(callback: (event: EventMessage) => void): void {
		this.eventCallback = callback;
	}

	/**
	 * Spawn a new agent process.
	 *
	 * If blocking: waits for the agent to produce a result and returns it.
	 * If non-blocking: returns the handle ID string immediately.
	 */
	async spawnAgent(opts: SpawnAgentOptions): Promise<ResultMessage | string> {
		const handleId = opts.handleId ?? ulid();

		const env: Record<string, string> = {
			SPROUT_BUS_URL: this.busUrl,
			SPROUT_HANDLE_ID: handleId,
			SPROUT_SESSION_ID: this.sessionId,
			SPROUT_GENOME_PATH: opts.genomePath,
			SPROUT_WORK_DIR: opts.workDir,
		};

		// Spawn the process
		const proc = this.spawnFn(handleId, env);

		const handle: AgentHandle = {
			handleId,
			process: proc,
			status: "running",
			shared: opts.shared,
			resultResolvers: [],
			ownerId: opts.caller.agent_name,
			agentName: opts.agentName,
			genomePath: opts.genomePath,
			caller: opts.caller,
			workDir: opts.workDir,
		};
		this.handles.set(handleId, handle);

		// Subscribe to result topic to track status
		const resultTopic = agentResult(this.sessionId, handleId);
		await this.bus.subscribe(resultTopic, (payload) => {
			try {
				const msg = parseBusMessage(payload);
				if (msg.kind === "result") {
					handle.result = msg;
					handle.status = opts.shared ? "idle" : "completed";
					for (const resolve of handle.resultResolvers) {
						resolve(msg);
					}
					handle.resultResolvers = [];
				}
			} catch {
				// Ignore malformed messages
			}
		});

		// Subscribe to events topic and relay to the onEvent callback
		const eventsTopic = agentEvents(this.sessionId, handleId);
		await this.bus.subscribe(eventsTopic, (payload) => {
			if (!this.eventCallback) return;
			try {
				const parsed = JSON.parse(payload);
				if (parsed.kind === "event") {
					this.eventCallback(parsed as EventMessage);
				}
			} catch {
				// Ignore malformed messages
			}
		});

		// Wait for the agent process to signal it's ready (subscribed to inbox)
		const readyTopic = agentReady(this.sessionId, handleId);
		await this.bus.waitForMessage(readyTopic, 10_000);

		// Publish start message to the agent's inbox
		const inboxTopic = agentInbox(this.sessionId, handleId);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: handleId,
			agent_name: opts.agentName,
			genome_path: opts.genomePath,
			session_id: this.sessionId,
			caller: opts.caller,
			goal: opts.goal,
			hints: opts.hints,
			shared: opts.shared,
			agent_id: opts.agentId,
		};
		await this.bus.publish(inboxTopic, JSON.stringify(startMsg));

		if (opts.blocking) {
			return this.waitAgent(handleId);
		}

		return handleId;
	}

	/**
	 * Wait for an agent to produce a result.
	 * Returns immediately if a result is already cached.
	 * Throws if the handle ID is unknown.
	 *
	 * When caller is provided, access control is enforced:
	 * non-shared handles reject callers other than the owner.
	 * Internal calls (e.g. the blocking path in spawnAgent) omit caller to skip the check.
	 */
	waitAgent(handleId: string, caller?: CallerIdentity): Promise<ResultMessage> {
		const handle = this.handles.get(handleId);
		if (!handle) {
			throw new Error(`Unknown handle: ${handleId}`);
		}

		if (caller && !handle.shared && caller.agent_name !== handle.ownerId) {
			throw new Error(`Handle ${handleId} is not shared — only '${handle.ownerId}' can access it`);
		}

		if (handle.result) {
			return Promise.resolve(handle.result);
		}

		return new Promise<ResultMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				const idx = handle.resultResolvers.indexOf(resolver);
				if (idx !== -1) handle.resultResolvers.splice(idx, 1);
				reject(new Error(`waitAgent timed out for handle ${handleId}`));
			}, this.waitTimeoutMs);

			const resolver = (result: ResultMessage) => {
				clearTimeout(timeout);
				resolve(result);
			};
			handle.resultResolvers.push(resolver);
		});
	}

	/**
	 * Send a message to an existing agent.
	 *
	 * If the agent is running, sends a SteerMessage.
	 * If the agent is idle or completed, sends a ContinueMessage.
	 *
	 * If blocking: waits for the next result.
	 * If not blocking: returns immediately (undefined).
	 */
	async messageAgent(
		handleId: string,
		message: string,
		caller: CallerIdentity,
		blocking: boolean,
	): Promise<ResultMessage | undefined> {
		const handle = this.handles.get(handleId);
		if (!handle) {
			throw new Error(`Unknown handle: ${handleId}`);
		}

		if (!handle.shared && caller.agent_name !== handle.ownerId) {
			throw new Error(`Handle ${handleId} is not shared — only '${handle.ownerId}' can access it`);
		}

		const inboxTopic = agentInbox(this.sessionId, handleId);

		if (handle.status === "running") {
			// Agent is actively processing — send a steer message
			const steerMsg: SteerMessage = {
				kind: "steer",
				message,
			};
			this.bus.publish(inboxTopic, JSON.stringify(steerMsg));

			if (blocking) {
				// Clear cached result so waitAgent waits for the new one
				handle.result = undefined;
				return this.waitAgent(handleId);
			}
			return Promise.resolve(undefined);
		}

		if (handle.status === "idle") {
			// Agent process is alive — send continue message
			handle.result = undefined;
			handle.status = "running";

			const continueMsg: ContinueMessage = {
				kind: "continue",
				message,
				caller,
			};
			this.bus.publish(inboxTopic, JSON.stringify(continueMsg));

			if (blocking) {
				return this.waitAgent(handleId);
			}
			return Promise.resolve(undefined);
		}

		// Agent process has exited — re-spawn with the message as the new goal.
		// The agent process auto-resumes from its prior event log.
		const env: Record<string, string> = {
			SPROUT_BUS_URL: this.busUrl,
			SPROUT_HANDLE_ID: handleId,
			SPROUT_SESSION_ID: this.sessionId,
			SPROUT_GENOME_PATH: handle.genomePath,
			SPROUT_WORK_DIR: handle.workDir,
		};

		const proc = this.spawnFn(handleId, env);
		handle.process = proc;
		handle.result = undefined;
		handle.status = "running";

		const readyTopic = agentReady(this.sessionId, handleId);
		await this.bus.waitForMessage(readyTopic, 10_000);

		const startMsg: StartMessage = {
			kind: "start",
			handle_id: handleId,
			agent_name: handle.agentName,
			genome_path: handle.genomePath,
			session_id: this.sessionId,
			caller: handle.caller,
			goal: message,
			shared: handle.shared,
		};
		await this.bus.publish(inboxTopic, JSON.stringify(startMsg));

		if (blocking) {
			return this.waitAgent(handleId);
		}
		return Promise.resolve(undefined);
	}

	/**
	 * Register a handle that completed in a previous session.
	 * Creates a handle entry with status "completed" and the cached result,
	 * so that waitAgent returns the result immediately on resume.
	 */
	registerCompletedHandle(
		handleId: string,
		result: ResultMessage,
		ownerId: string,
		spawnInfo?: { agentName: string; genomePath: string; caller: CallerIdentity; workDir: string },
	): void {
		const handle: AgentHandle = {
			handleId,
			process: { kill: () => {}, exited: Promise.resolve(0) },
			status: "completed",
			result,
			shared: false,
			resultResolvers: [],
			ownerId,
			agentName: spawnInfo?.agentName ?? "",
			genomePath: spawnInfo?.genomePath ?? "",
			caller: spawnInfo?.caller ?? { agent_name: ownerId, depth: 0 },
			workDir: spawnInfo?.workDir ?? "",
		};
		this.handles.set(handleId, handle);
	}

	/** Get all tracked handle IDs */
	getHandles(): string[] {
		return [...this.handles.keys()];
	}

	/** Get a specific handle by ID */
	getHandle(handleId: string): AgentHandle | undefined {
		return this.handles.get(handleId);
	}

	/** Kill all running agent processes */
	shutdown(): void {
		for (const handle of this.handles.values()) {
			if (handle.status === "running" || handle.status === "idle") {
				handle.process.kill();
			}
		}
	}
}
