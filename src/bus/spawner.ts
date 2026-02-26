import { resolve } from "node:path";
import { ulid } from "../util/ulid.ts";
import type { BusClient } from "./client.ts";
import { agentInbox, agentReady, agentResult } from "./topics.ts";
import type {
	CallerIdentity,
	ContinueMessage,
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
}

/** Internal tracking record for a spawned agent */
export interface AgentHandle {
	handleId: string;
	process: { kill: () => void; exited: Promise<number> };
	status: "running" | "idle" | "completed";
	result?: ResultMessage;
	shared: boolean;
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
	private readonly handles = new Map<string, AgentHandle>();

	constructor(bus: BusClient, busUrl: string, sessionId: string, spawnFn?: SpawnFn) {
		this.bus = bus;
		this.busUrl = busUrl;
		this.sessionId = sessionId;
		this.spawnFn = spawnFn ?? defaultSpawnFn;
	}

	/**
	 * Spawn a new agent process.
	 *
	 * If blocking: waits for the agent to produce a result and returns it.
	 * If non-blocking: returns the handle ID string immediately.
	 */
	async spawnAgent(opts: SpawnAgentOptions): Promise<ResultMessage | string> {
		const handleId = ulid();

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
	 */
	waitAgent(handleId: string): Promise<ResultMessage> {
		const handle = this.handles.get(handleId);
		if (!handle) {
			throw new Error(`Unknown handle: ${handleId}`);
		}

		if (handle.result) {
			return Promise.resolve(handle.result);
		}

		// Poll for the result to arrive via the subscription
		return new Promise<ResultMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`waitAgent timed out for handle ${handleId}`));
			}, 30_000);

			const check = () => {
				if (handle.result) {
					clearTimeout(timeout);
					resolve(handle.result);
					return;
				}
				setTimeout(check, 20);
			};
			check();
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
	messageAgent(
		handleId: string,
		message: string,
		caller: CallerIdentity,
		blocking: boolean,
	): Promise<ResultMessage | undefined> {
		const handle = this.handles.get(handleId);
		if (!handle) {
			throw new Error(`Unknown handle: ${handleId}`);
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

		// Agent is idle or completed — send continue message
		// Clear cached result so waitAgent waits for the new one
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
