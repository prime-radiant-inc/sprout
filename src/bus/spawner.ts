import { resolve } from "node:path";
import { ulid } from "../util/ulid.ts";
import type { BusClient } from "./client.ts";
import { agentInbox, agentReady, agentResult, sessionEvents } from "./topics.ts";
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
	/** Per-project data directory (sessions, logs, memory). */
	projectDataDir?: string;
	caller: CallerIdentity;
	goal: string;
	hints?: string[];
	blocking: boolean;
	shared: boolean;
	workDir: string;
	/** Pre-assigned handle ID. If omitted, a new ULID is generated. */
	handleId?: string;
	/** Stable agent_id for events emitted by the child. Defaults to handleId. */
	agentId?: string;
	/** Path to root agent directory (for overlay resolution in subprocesses). */
	rootDir?: string;
	/** Mnemonic codename for this agent (historical figure surname). */
	mnemonicName?: string;
}

/** A pending waitAgent() promise that can be resolved or rejected. */
interface PendingWaiter {
	resolve: (result: ResultMessage) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Internal tracking record for a spawned agent */
export interface AgentHandle {
	handleId: string;
	/** Stable event identity for this handle across respawns. */
	agentId: string;
	process: { kill: () => void; exited: Promise<number> };
	status: "running" | "idle" | "completed";
	result?: ResultMessage;
	shared: boolean;
	pendingWaiters: PendingWaiter[];
	/** agent_name of the parent who spawned this handle */
	ownerId: string;
	/** Original spawn options needed for re-spawning completed agents */
	agentName: string;
	genomePath: string;
	caller: CallerIdentity;
	workDir: string;
	rootDir?: string;
	projectDataDir?: string;
	/** Bus topic for result messages, used for cleanup. */
	resultTopic?: string;
	/** Mnemonic codename assigned at delegation time. */
	mnemonicName?: string;
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
	private sessionId: string;
	private readonly spawnFn: SpawnFn;
	private readonly waitTimeoutMs: number;
	private readonly handles = new Map<string, AgentHandle>();
	private sessionEventsCallback?: (event: EventMessage) => void;
	private currentSessionEventsTopic?: string;

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
		this.waitTimeoutMs = waitTimeoutMs ?? 900_000;
	}

	/**
	 * Subscribe to the session-wide events topic.
	 * Every agent subprocess publishes here regardless of depth,
	 * so this provides O(1) event delivery without relay chains.
	 *
	 * Can only be called once. Use updateSessionId() to resubscribe
	 * after a session reset (e.g. /clear).
	 */
	async subscribeSessionEvents(callback: (event: EventMessage) => void): Promise<void> {
		if (this.sessionEventsCallback) return;
		this.sessionEventsCallback = callback;
		await this.subscribeToSessionTopic();
	}

	/**
	 * Update the session ID (e.g. after /clear).
	 * Resubscribes to the new session-wide events topic if a callback
	 * was previously registered. The old subscription becomes a no-op
	 * since no agents will publish to the old topic after the reset.
	 */
	async updateSessionId(newSessionId: string): Promise<void> {
		this.sessionId = newSessionId;
		if (this.sessionEventsCallback) {
			await this.subscribeToSessionTopic();
		}
	}

	/**
	 * Clear all tracked handles, unsubscribe from their result topics,
	 * and kill any running processes. Called on session reset (/clear).
	 */
	async clearHandles(): Promise<void> {
		for (const handle of this.handles.values()) {
			// Reject pending waiters so they don't hang for the timeout duration
			for (const waiter of handle.pendingWaiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("Session cleared"));
			}
			handle.pendingWaiters = [];

			if (handle.status === "running" || handle.status === "idle") {
				handle.process.kill();
			}
			if (handle.resultTopic && this.bus.connected) {
				this.bus.unsubscribe(handle.resultTopic).catch(() => {});
			}
		}
		this.handles.clear();
	}

	private async subscribeToSessionTopic(): Promise<void> {
		// Unsubscribe from the previous session events topic to avoid leaking
		if (this.currentSessionEventsTopic && this.bus.connected) {
			await this.bus.unsubscribe(this.currentSessionEventsTopic);
		}

		const callback = this.sessionEventsCallback!;
		const topic = sessionEvents(this.sessionId);
		this.currentSessionEventsTopic = topic;
		await this.bus.subscribe(topic, (payload) => {
			try {
				const msg = parseBusMessage(payload);
				if (msg.kind === "event") {
					callback(msg);
				}
			} catch {
				// Ignore malformed messages
			}
		});
	}

	/**
	 * Spawn a new agent process.
	 *
	 * If blocking: waits for the agent to produce a result and returns it.
	 * If non-blocking: returns the handle ID string immediately.
	 */
	async spawnAgent(opts: SpawnAgentOptions): Promise<ResultMessage | string> {
		const handleId = opts.handleId ?? ulid();
		const agentId = opts.agentId ?? handleId;

		const env: Record<string, string> = {
			SPROUT_BUS_URL: this.busUrl,
			SPROUT_HANDLE_ID: handleId,
			SPROUT_SESSION_ID: this.sessionId,
			SPROUT_GENOME_PATH: opts.genomePath,
			SPROUT_WORK_DIR: opts.workDir,
			...(opts.rootDir ? { SPROUT_ROOT_DIR: opts.rootDir } : {}),
			...(opts.projectDataDir ? { SPROUT_PROJECT_DATA_DIR: opts.projectDataDir } : {}),
		};

		// Spawn the process
		const proc = this.spawnFn(handleId, env);

		const handle: AgentHandle = {
			handleId,
			agentId,
			process: proc,
			status: "running",
			shared: opts.shared,
			pendingWaiters: [],
			ownerId: opts.caller.agent_name,
			agentName: opts.agentName,
			genomePath: opts.genomePath,
			caller: opts.caller,
			workDir: opts.workDir,
			rootDir: opts.rootDir,
			projectDataDir: opts.projectDataDir,
			mnemonicName: opts.mnemonicName,
		};
		this.handles.set(handleId, handle);

		// Subscribe to result topic to track status
		const resultTopic = agentResult(this.sessionId, handleId);
		handle.resultTopic = resultTopic;
		await this.bus.subscribe(resultTopic, (payload) => {
			try {
				const msg = parseBusMessage(payload);
				if (msg.kind === "result") {
					handle.result = msg;
					handle.status = opts.shared ? "idle" : "completed";
					for (const waiter of handle.pendingWaiters) {
						clearTimeout(waiter.timer);
						waiter.resolve(msg);
					}
					handle.pendingWaiters = [];
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
			agent_id: agentId,
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
			const waiter: PendingWaiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					const idx = handle.pendingWaiters.indexOf(waiter);
					if (idx !== -1) handle.pendingWaiters.splice(idx, 1);
					reject(new Error(`waitAgent timed out for handle ${handleId}`));
				}, this.waitTimeoutMs),
			};
			handle.pendingWaiters.push(waiter);
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

			if (blocking) {
				// Clear cached result BEFORE publishing so a result arriving
				// between publish and waitAgent doesn't get overwritten.
				handle.result = undefined;
			}
			await this.bus.publish(inboxTopic, JSON.stringify(steerMsg));

			if (blocking) {
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
			await this.bus.publish(inboxTopic, JSON.stringify(continueMsg));

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
			...(handle.rootDir ? { SPROUT_ROOT_DIR: handle.rootDir } : {}),
			...(handle.projectDataDir ? { SPROUT_PROJECT_DATA_DIR: handle.projectDataDir } : {}),
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
			agent_id: handle.agentId,
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
		spawnInfo?: {
			agentName: string;
			genomePath: string;
			caller: CallerIdentity;
			workDir: string;
			agentId?: string;
		},
	): void {
		// Skip if the handle already exists (e.g. re-spawned since the
		// original completed state was recorded). Avoids overwriting a
		// live handle with stale completed data.
		if (this.handles.has(handleId)) return;

		const handle: AgentHandle = {
			handleId,
			agentId: spawnInfo?.agentId ?? handleId,
			process: { kill: () => {}, exited: Promise.resolve(0) },
			status: "completed",
			result,
			shared: false,
			pendingWaiters: [],
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

	/** Kill all running agent processes and clean up bus subscriptions. */
	shutdown(): void {
		for (const handle of this.handles.values()) {
			for (const waiter of handle.pendingWaiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("Spawner shutting down"));
			}
			handle.pendingWaiters = [];

			if (handle.status === "running" || handle.status === "idle") {
				handle.process.kill();
			}
			if (handle.resultTopic && this.bus.connected) {
				this.bus.unsubscribe(handle.resultTopic).catch(() => {});
			}
		}
		if (this.currentSessionEventsTopic && this.bus.connected) {
			this.bus.unsubscribe(this.currentSessionEventsTopic).catch(() => {});
		}
	}
}
