import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverSettings } from "../agents/model-resolver.ts";
import type { HandleRegistrar } from "../host/handle-registrar.ts";
import { hashToken, mintToken, type ObserverRemit } from "../host/handle-registry.ts";
import { buildInternalSproutCommand } from "../util/self-command.ts";
import { ulid } from "../util/ulid.ts";
import type { BusClient } from "./client.ts";
import { readHandleResult } from "./resume.ts";
import { agentInbox, agentMessageAck, agentReady, agentResult, sessionEvents } from "./topics.ts";
import type {
	AgentAddress,
	AgentMessageMessage,
	ContinueMessage,
	EventMessage,
	ResultMessage,
	StartMessage,
} from "./types.ts";
import { parseBusMessage } from "./types.ts";

/** Options for spawning a new agent */
export interface SpawnAgentOptions {
	agentName: string;
	genomePath: string;
	/** Per-project data directory (sessions, logs, memory). */
	projectDataDir?: string;
	caller: AgentAddress;
	goal: string;
	hints?: string[];
	payload?: Record<string, unknown>;
	blocking: boolean;
	shared: boolean;
	/** Keep the process alive after a result so it can receive follow-up continues. */
	keepAlive?: boolean;
	/** Whether ordinary non-owner agents may address this handle. */
	visibility?: HandleVisibility;
	/** Observer handles are ordinary agents but cannot use raw handle messaging. */
	isObserver?: boolean;
	workDir: string;
	/** Pre-assigned handle ID. If omitted, a new ULID is generated. */
	handleId?: string;
	/** Stable agent_id for events emitted by the child. Defaults to handleId. */
	agentId?: string;
	/** Path to root agent directory (for overlay resolution in subprocesses). */
	rootDir?: string;
	/** Mnemonic codename for this agent (historical figure surname). */
	mnemonicName?: string;
	evalMode?: boolean;
	/** Selected provider context inherited from the caller. */
	providerIdOverride?: string;
	/** Provider tier defaults and enabled-provider state inherited from the caller. */
	resolverSettings?: ResolverSettings;
	/** Original user instruction, trusted for deterministic runtime policy gates. */
	trustedUserInstruction?: string;
	/** Precomputed memory context inherited from the root session. Empty string suppresses it. */
	surfacedMemoryBlock?: string;
}

export type HandleVisibility = "private" | "shared";

/**
 * Authenticated-channel context for a spawner (sap spec §1 Transport, §3
 * Identity). When present, every child handle is registered with the host
 * before its process launches and receives per-handle credentials in its
 * environment. When absent (tests, spawnerless runs), spawning is unchanged.
 */
export interface SpawnerAuthChannel {
	/** ws:// URL of the host's authenticated channel, passed to children. */
	url: string;
	/** Registration authority: trusted-direct on the host, over-channel in children. */
	registrar: HandleRegistrar;
}

export interface DeliverObserverFrameOptions {
	agentName: string;
	genomePath: string;
	projectDataDir?: string;
	caller: AgentAddress;
	message: string;
	handleId: string;
	agentId: string;
	workDir: string;
	rootDir?: string;
	evalMode?: boolean;
	resolverSettings?: ResolverSettings;
	surfacedMemoryBlock?: string;
}

/** A pending waitAgent() promise that can be resolved or rejected. */
interface PendingWaiter {
	resolve: (result: ResultMessage) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const PROCESS_EXIT_RESULT_GRACE_MS = 25;
const DEFAULT_AGENT_MESSAGE_ACK_TIMEOUT_MS = 5_000;
const PROCESS_SHUTDOWN_GRACE_MS = 1_000;

/** Internal tracking record for a spawned agent */
export interface AgentHandle {
	handleId: string;
	/** Stable event identity for this handle across respawns. */
	agentId: string;
	address: AgentAddress;
	process: { kill: (signal?: "SIGTERM" | "SIGKILL") => void; exited: Promise<number> };
	status: "running" | "idle" | "completed";
	result?: ResultMessage;
	keepAlive: boolean;
	visibility: HandleVisibility;
	isObserver: boolean;
	pendingWaiters: PendingWaiter[];
	owner: AgentAddress;
	/** Original spawn options needed for re-spawning completed agents */
	agentName: string;
	genomePath: string;
	caller: AgentAddress;
	workDir: string;
	rootDir?: string;
	projectDataDir?: string;
	/** Bus topic for result messages, used for cleanup. */
	resultTopic?: string;
	/** Mnemonic codename assigned at delegation time. */
	mnemonicName?: string;
	evalMode?: boolean;
	providerIdOverride?: string;
	resolverSettings?: ResolverSettings;
	trustedUserInstruction?: string;
	surfacedMemoryBlock?: string;
	resultRecoveryLogOffset?: number | null;
}

/**
 * Function that spawns an agent process. In production uses Bun.spawn();
 * in tests can use runAgentProcess() in-process.
 */
export type SpawnFn = (
	handleId: string,
	env: Record<string, string>,
) => { kill: (signal?: "SIGTERM" | "SIGKILL") => void; exited: Promise<number> };

/** Default spawn function using Bun.spawn() */
function defaultSpawnFn(
	_handleId: string,
	env: Record<string, string>,
): {
	kill: (signal?: "SIGTERM" | "SIGKILL") => void;
	exited: Promise<number>;
} {
	const proc = Bun.spawn(buildInternalSproutCommand("agent-process"), {
		env: { ...process.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		kill: (signal = "SIGTERM") => proc.kill(signal),
		exited: proc.exited,
	};
}

async function waitForAllOrTimeout(
	promises: Array<Promise<unknown>>,
	timeoutMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(promises),
			new Promise((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function forceKillAfterGrace(
	processes: Array<{
		process: { kill: (signal?: "SIGTERM" | "SIGKILL") => void };
		exited: Promise<number>;
	}>,
	graceMs: number,
): Promise<void> {
	if (processes.length === 0) return;

	const tracked = processes.map((entry) => ({ ...entry, settled: false }));
	for (const entry of tracked) {
		void entry.exited.then(
			() => {
				entry.settled = true;
			},
			() => {
				entry.settled = true;
			},
		);
	}

	await waitForAllOrTimeout(
		tracked.map((entry) => entry.exited),
		graceMs,
	);

	await Promise.allSettled(
		tracked.map(async (entry) => {
			if (entry.settled) return;
			entry.process.kill("SIGKILL");
			await waitForAllOrTimeout([entry.exited.catch(() => 1)], 250);
		}),
	);
}

function isFileNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
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
	private readonly agentMessageAckTimeoutMs: number;
	private readonly authChannel?: SpawnerAuthChannel;
	private readonly handles = new Map<string, AgentHandle>();
	private readonly observerDeliveryChains = new Map<string, Promise<void>>();
	private readonly sessionEventsCallbacks = new Set<(event: EventMessage) => void>();
	private rootMessageCallback?: (message: AgentMessageMessage) => unknown;
	private currentSessionEventsTopic?: string;
	private currentRootInboxTopic?: string;

	private monitorProcessExit(
		handleId: string,
		process: { kill: (signal?: "SIGTERM" | "SIGKILL") => void; exited: Promise<number> },
	): void {
		void process.exited.then(
			(code) => {
				setTimeout(
					() => void this.handleProcessExit(handleId, process, code),
					PROCESS_EXIT_RESULT_GRACE_MS,
				);
			},
			(error) => {
				setTimeout(
					() => void this.handleProcessExit(handleId, process, undefined, error),
					PROCESS_EXIT_RESULT_GRACE_MS,
				);
			},
		);
	}

	private async handleProcessExit(
		handleId: string,
		process: { kill: (signal?: "SIGTERM" | "SIGKILL") => void; exited: Promise<number> },
		code?: number,
		error?: unknown,
	): Promise<void> {
		const handle = this.handles.get(handleId);
		if (!handle || handle.process !== process) {
			return;
		}

		if (handle.result) {
			handle.status = "completed";
			return;
		}

		let persistedResult: ResultMessage | null = null;
		try {
			persistedResult = await this.readPersistedHandleResult(handle);
		} catch {
			// Durable-log recovery is best-effort; process exit must still settle the handle.
		}
		const current = this.handles.get(handleId);
		if (!current || current.process !== process) {
			return;
		}
		if (current.result) {
			current.status = "completed";
			return;
		}
		if (persistedResult) {
			this.settleHandleResult(current, persistedResult, "completed");
			return;
		}

		const reason =
			error !== undefined
				? `exited with error: ${String(error)}`
				: `exited with code ${code ?? "unknown"}`;
		const result: ResultMessage = {
			kind: "result",
			handle_id: handleId,
			output: `Agent process ${handleId} ${reason}`,
			success: false,
			stumbles: 1,
			turns: 0,
			timed_out: false,
		};
		this.settleHandleResult(current, result, "completed");
	}

	private async readPersistedHandleResult(handle: AgentHandle): Promise<ResultMessage | null> {
		if (handle.resultRecoveryLogOffset == null) {
			return null;
		}
		const handleLogDir = join(handle.projectDataDir ?? handle.genomePath, "logs", this.sessionId);
		return readHandleResult(handleLogDir, handle.handleId, {
			afterByteOffset: handle.resultRecoveryLogOffset,
		});
	}

	private async captureResultRecoveryLogOffset(
		dataDir: string,
		handleId: string,
	): Promise<number | null> {
		const logPath = join(dataDir, "logs", this.sessionId, `${handleId}.jsonl`);
		try {
			return (await stat(logPath)).size;
		} catch (error) {
			if (isFileNotFound(error)) {
				return 0;
			}
			return null;
		}
	}

	private settleHandleResult(
		handle: AgentHandle,
		result: ResultMessage,
		status: AgentHandle["status"] = handle.keepAlive ? "idle" : "completed",
	): void {
		handle.result = result;
		handle.status = status;
		for (const waiter of handle.pendingWaiters) {
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(result);
		}
		handle.pendingWaiters = [];
	}

	private async waitForReadyOrExit(
		handleId: string,
		process: { kill: () => void; exited: Promise<number> },
	): Promise<void> {
		const readyTopic = agentReady(this.sessionId, handleId);
		await Promise.race([
			this.bus.waitForMessage(readyTopic, 10_000).then(() => undefined),
			process.exited.then(
				(code) => {
					throw new Error(`Agent process ${handleId} exited before ready with code ${code}`);
				},
				(error) => {
					throw new Error(
						`Agent process ${handleId} exited before ready with error: ${String(error)}`,
					);
				},
			),
		]);
	}

	constructor(
		bus: BusClient,
		busUrl: string,
		sessionId: string,
		spawnFn?: SpawnFn,
		waitTimeoutMs?: number,
		agentMessageAckTimeoutMs?: number,
		authChannel?: SpawnerAuthChannel,
	) {
		this.bus = bus;
		this.busUrl = busUrl;
		this.sessionId = sessionId;
		this.spawnFn = spawnFn ?? defaultSpawnFn;
		this.authChannel = authChannel;
		this.waitTimeoutMs = waitTimeoutMs ?? 900_000;
		this.agentMessageAckTimeoutMs =
			agentMessageAckTimeoutMs ?? DEFAULT_AGENT_MESSAGE_ACK_TIMEOUT_MS;
	}

	/**
	 * Subscribe to the session-wide events topic.
	 * Every agent subprocess publishes here regardless of depth,
	 * so this provides O(1) event delivery without relay chains.
	 *
	 * Multiple independent runtime facilities can subscribe. Use updateSessionId()
	 * to resubscribe after a session reset (e.g. /clear).
	 */
	async subscribeSessionEvents(callback: (event: EventMessage) => void): Promise<() => void> {
		const hadCallbacks = this.sessionEventsCallbacks.size > 0;
		this.sessionEventsCallbacks.add(callback);
		if (!hadCallbacks) {
			await this.subscribeToSessionTopic();
		}
		return () => {
			this.sessionEventsCallbacks.delete(callback);
			if (this.sessionEventsCallbacks.size === 0 && this.currentSessionEventsTopic) {
				const topic = this.currentSessionEventsTopic;
				this.currentSessionEventsTopic = undefined;
				if (this.bus.connected) {
					this.bus.unsubscribe(topic).catch(() => {});
				}
			}
		};
	}

	/**
	 * Subscribe to canonical root messages from subprocess agents.
	 * The root agent is in-process, so this bridges bus-delivered agent messages
	 * back into SessionController instead of pretending root is a spawned handle.
	 */
	async subscribeRootMessages(callback: (message: AgentMessageMessage) => unknown): Promise<void> {
		if (this.rootMessageCallback) return;
		this.rootMessageCallback = callback;
		await this.subscribeToRootInboxTopic();
	}

	/**
	 * Update the session ID (e.g. after /clear).
	 * Resubscribes to the new session-wide events topic if a callback
	 * was previously registered. The old subscription becomes a no-op
	 * since no agents will publish to the old topic after the reset.
	 */
	async updateSessionId(newSessionId: string): Promise<void> {
		this.sessionId = newSessionId;
		if (this.sessionEventsCallbacks.size > 0) {
			await this.subscribeToSessionTopic();
		}
		if (this.rootMessageCallback) {
			await this.subscribeToRootInboxTopic();
		}
	}

	/**
	 * Clear all tracked handles, unsubscribe from their result topics,
	 * and kill any running processes. Called on session reset (/clear).
	 */
	async clearHandles(): Promise<void> {
		const processesToStop: Array<{
			process: AgentHandle["process"];
			exited: Promise<number>;
		}> = [];
		for (const handle of this.handles.values()) {
			// Reject pending waiters so they don't hang for the timeout duration
			for (const waiter of handle.pendingWaiters) {
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.reject(new Error("Session cleared"));
			}
			handle.pendingWaiters = [];

			if (handle.status === "running" || handle.status === "idle") {
				handle.process.kill("SIGTERM");
				processesToStop.push({ process: handle.process, exited: handle.process.exited });
			}
			if (handle.resultTopic && this.bus.connected) {
				this.bus.unsubscribe(handle.resultTopic).catch(() => {});
			}
		}
		await forceKillAfterGrace(processesToStop, PROCESS_SHUTDOWN_GRACE_MS);
		this.handles.clear();
	}

	private async subscribeToSessionTopic(): Promise<void> {
		// Unsubscribe from the previous session events topic to avoid leaking
		if (this.currentSessionEventsTopic && this.bus.connected) {
			await this.bus.unsubscribe(this.currentSessionEventsTopic);
		}

		const topic = sessionEvents(this.sessionId);
		this.currentSessionEventsTopic = topic;
		await this.bus.subscribe(topic, (payload) => {
			try {
				const msg = parseBusMessage(payload);
				if (msg.kind === "event") {
					for (const callback of this.sessionEventsCallbacks) {
						callback(msg);
					}
				}
			} catch {
				// Ignore malformed messages
			}
		});
	}

	private async subscribeToRootInboxTopic(): Promise<void> {
		if (this.currentRootInboxTopic && this.bus.connected) {
			await this.bus.unsubscribe(this.currentRootInboxTopic);
		}

		const callback = this.rootMessageCallback!;
		const topic = agentInbox(this.sessionId, "root");
		this.currentRootInboxTopic = topic;
		await this.bus.subscribe(topic, (payload) => {
			try {
				const msg = parseBusMessage(payload);
				if (msg.kind === "agent_message") {
					const delivered = callback(msg) !== false;
					if (delivered) {
						void this.ackAgentMessage(msg);
					}
				}
			} catch {
				// Ignore malformed messages
			}
		});
	}

	private async subscribeToResultTopic(handle: AgentHandle): Promise<void> {
		if (handle.resultTopic) {
			return;
		}

		const resultTopic = agentResult(this.sessionId, handle.handleId);
		handle.resultTopic = resultTopic;
		await this.bus.subscribe(resultTopic, (payload) => {
			try {
				const msg = parseBusMessage(payload);
				if (msg.kind === "result") {
					this.settleHandleResult(handle, msg);
				}
			} catch {
				// Ignore malformed messages
			}
		});
	}

	/**
	 * Register a handle with the host ahead of its process launch and return
	 * the env vars carrying its credentials. Registration must precede launch
	 * so the child's very first connection can authenticate. Without an auth
	 * channel this is a no-op returning no env. A rejected registration aborts
	 * the launch — an unregistered child could never authenticate anyway.
	 */
	private async registerHandleForLaunch(input: {
		handleId: string;
		ownerId: string;
		depth: number;
		isObserver: boolean;
	}): Promise<Record<string, string>> {
		if (!this.authChannel) return {};
		const token = mintToken();
		// An observer's read scope is fixed at spawn: session-wide when root
		// spawns it, otherwise limited to the spawning owner's delegations.
		const observerRemit: ObserverRemit | undefined = input.isObserver
			? input.ownerId === "root"
				? { kind: "session" }
				: { kind: "delegate", ownerId: input.ownerId }
			: undefined;
		await this.authChannel.registrar.registerChild({
			handleId: input.handleId,
			tokenHash: hashToken(token),
			ownerId: input.ownerId,
			depth: input.depth,
			...(observerRemit ? { observerRemit } : {}),
		});
		return { SPROUT_AUTH_URL: this.authChannel.url, SPROUT_HANDLE_TOKEN: token };
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
		const visibility = opts.visibility ?? (opts.shared ? "shared" : "private");
		const keepAlive = opts.keepAlive ?? opts.shared;
		const self: AgentAddress = {
			agentName: opts.agentName,
			depth: opts.caller.depth + 1,
			handleId,
			agentId,
			...(opts.isObserver ? { role: "observer" as const } : {}),
		};

		const env: Record<string, string> = {
			SPROUT_BUS_URL: this.busUrl,
			SPROUT_HANDLE_ID: handleId,
			SPROUT_SESSION_ID: this.sessionId,
			SPROUT_GENOME_PATH: opts.genomePath,
			SPROUT_WORK_DIR: opts.workDir,
			SPROUT_PARENT_PID: String(process.pid),
			...(opts.rootDir ? { SPROUT_ROOT_DIR: opts.rootDir } : {}),
			...(opts.projectDataDir ? { SPROUT_PROJECT_DATA_DIR: opts.projectDataDir } : {}),
			...(await this.registerHandleForLaunch({
				handleId,
				ownerId: opts.caller.handleId,
				depth: self.depth,
				isObserver: opts.isObserver === true,
			})),
		};

		const resultRecoveryLogOffset = await this.captureResultRecoveryLogOffset(
			opts.projectDataDir ?? opts.genomePath,
			handleId,
		);

		// Spawn the process
		const proc = this.spawnFn(handleId, env);

		const handle: AgentHandle = {
			handleId,
			agentId,
			address: self,
			process: proc,
			status: "running",
			keepAlive,
			visibility,
			isObserver: opts.isObserver === true,
			pendingWaiters: [],
			owner: opts.caller,
			agentName: opts.agentName,
			genomePath: opts.genomePath,
			caller: opts.caller,
			workDir: opts.workDir,
			rootDir: opts.rootDir,
			projectDataDir: opts.projectDataDir,
			mnemonicName: opts.mnemonicName,
			evalMode: opts.evalMode,
			providerIdOverride: opts.providerIdOverride,
			resolverSettings: opts.resolverSettings,
			trustedUserInstruction: opts.trustedUserInstruction,
			surfacedMemoryBlock: opts.surfacedMemoryBlock,
			resultRecoveryLogOffset,
		};
		this.handles.set(handleId, handle);
		this.monitorProcessExit(handleId, proc);

		// Subscribe to result topic to track status
		await this.subscribeToResultTopic(handle);

		// Wait for the agent process to signal it's ready (subscribed to inbox)
		await this.waitForReadyOrExit(handleId, proc);

		// Publish start message to the agent's inbox
		const inboxTopic = agentInbox(this.sessionId, handleId);
		const startMsg: StartMessage = {
			kind: "start",
			handle_id: handleId,
			genome_path: opts.genomePath,
			session_id: this.sessionId,
			self,
			caller: opts.caller,
			goal: opts.goal,
			hints: opts.hints,
			payload: opts.payload,
			shared: keepAlive,
			eval_mode: opts.evalMode,
			provider_id: opts.providerIdOverride,
			resolver_settings: opts.resolverSettings,
			trusted_user_instruction: opts.trustedUserInstruction,
			surfaced_memory_block: opts.surfacedMemoryBlock,
		};
		await this.bus.publish(inboxTopic, JSON.stringify(startMsg));

		if (opts.blocking) {
			return this.waitForBlockingSpawn(handleId);
		}

		return handleId;
	}

	private waitForBlockingSpawn(handleId: string): Promise<ResultMessage> {
		const handle = this.handles.get(handleId);
		if (!handle) {
			throw new Error(`Unknown handle: ${handleId}`);
		}

		if (handle.result) {
			return Promise.resolve(handle.result);
		}

		return new Promise<ResultMessage>((resolve, reject) => {
			const waiter: PendingWaiter = {
				resolve,
				reject,
			};
			handle.pendingWaiters.push(waiter);
		});
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
	waitAgent(handleId: string, caller?: AgentAddress): Promise<ResultMessage> {
		const handle = this.handles.get(handleId);
		if (!handle) {
			throw new Error(`Unknown handle: ${handleId}`);
		}
		if (caller?.role === "observer") {
			throw new Error("observer agents cannot wait on raw handles");
		}

		if (
			caller &&
			handle.visibility !== "shared" &&
			(caller.handleId !== handle.owner.handleId || caller.agentId !== handle.owner.agentId)
		) {
			throw new Error(
				`Handle ${handleId} is not shared — only '${handle.owner.agentName}' can access it`,
			);
		}

		if (handle.result) {
			return Promise.resolve(handle.result);
		}

		return new Promise<ResultMessage>((resolve, reject) => {
			const waiter: PendingWaiter = {
				resolve: (result) => resolve(result as ResultMessage),
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
	 * If the agent is running, sends an agent-originated message.
	 * If the agent is idle or completed, sends a ContinueMessage.
	 *
	 * If blocking: waits for the next result.
	 * If not blocking: returns immediately (undefined).
	 */
	async messageAgent(
		handleId: string,
		message: string,
		caller: AgentAddress,
		blocking: boolean,
		trustedUserInstruction?: string,
		callerTarget?: AgentAddress,
	): Promise<ResultMessage | undefined> {
		if (handleId === "root") {
			if (caller.handleId !== "root") {
				throw new Error('raw message_agent to root is only valid from root; use handle "caller"');
			}
			if (blocking) {
				throw new Error("message_agent to root requires blocking=false");
			}
			const rootMsg: AgentMessageMessage = {
				kind: "agent_message",
				message,
				from: caller,
				to: caller,
			};
			await this.bus.publish(agentInbox(this.sessionId, "root"), JSON.stringify(rootMsg));
			return undefined;
		}

		if (handleId === "caller") {
			if (blocking) {
				throw new Error("message_agent to caller requires blocking=false");
			}
			if (!callerTarget) {
				throw new Error('message_agent handle "caller" requires a runtime caller address');
			}
			const callerMsg: AgentMessageMessage = {
				kind: "agent_message",
				message,
				from: caller,
				to: callerTarget,
			};
			await this.publishAgentMessageWithAck(
				agentInbox(this.sessionId, callerTarget.handleId),
				callerMsg,
				`message_agent to caller '${callerTarget.agentName}' could not be delivered`,
			);
			return undefined;
		}
		if (caller.role === "observer") {
			throw new Error('observer agents can only use message_agent with handle "caller"');
		}

		const handle = this.handles.get(handleId);
		if (!handle) {
			throw new Error(`Unknown handle: ${handleId}`);
		}

		if (
			handle.visibility !== "shared" &&
			(caller.handleId !== handle.owner.handleId || caller.agentId !== handle.owner.agentId)
		) {
			throw new Error(
				`Handle ${handleId} is not shared — only '${handle.owner.agentName}' can access it`,
			);
		}

		const inboxTopic = agentInbox(this.sessionId, handleId);

		if (handle.status === "running") {
			if (blocking) {
				throw new Error("message_agent to a running agent requires blocking=false");
			}
			const agentMsg: AgentMessageMessage = {
				kind: "agent_message",
				message,
				from: caller,
				to: handle.address,
			};

			await this.bus.publish(inboxTopic, JSON.stringify(agentMsg));
			return Promise.resolve(undefined);
		}

		if (handle.status === "idle") {
			handle.trustedUserInstruction = trustedUserInstruction;
			// Agent process is alive — send continue message
			handle.resultRecoveryLogOffset = await this.captureResultRecoveryLogOffset(
				handle.projectDataDir ?? handle.genomePath,
				handleId,
			);
			handle.result = undefined;
			handle.status = "running";

			const continueMsg: ContinueMessage = {
				kind: "continue",
				message,
				caller,
				trusted_user_instruction: trustedUserInstruction,
			};
			await this.bus.publish(inboxTopic, JSON.stringify(continueMsg));

			if (blocking) {
				return this.waitAgent(handleId);
			}
			return Promise.resolve(undefined);
		}

		// Agent process has exited — re-spawn with the message as the new goal.
		// The agent process auto-resumes from its prior event log.
		const resultRecoveryLogOffset = await this.captureResultRecoveryLogOffset(
			handle.projectDataDir ?? handle.genomePath,
			handleId,
		);
		const env: Record<string, string> = {
			SPROUT_BUS_URL: this.busUrl,
			SPROUT_HANDLE_ID: handleId,
			SPROUT_SESSION_ID: this.sessionId,
			SPROUT_GENOME_PATH: handle.genomePath,
			SPROUT_WORK_DIR: handle.workDir,
			SPROUT_PARENT_PID: String(process.pid),
			...(handle.rootDir ? { SPROUT_ROOT_DIR: handle.rootDir } : {}),
			...(handle.projectDataDir ? { SPROUT_PROJECT_DATA_DIR: handle.projectDataDir } : {}),
			// Tokens are never journaled, so a re-spawn mints and registers anew.
			...(await this.registerHandleForLaunch({
				handleId,
				ownerId: handle.owner.handleId,
				depth: handle.address.depth,
				isObserver: handle.isObserver,
			})),
		};

		const proc = this.spawnFn(handleId, env);
		handle.process = proc;
		handle.result = undefined;
		handle.status = "running";
		handle.resultRecoveryLogOffset = resultRecoveryLogOffset;
		this.monitorProcessExit(handleId, proc);
		await this.subscribeToResultTopic(handle);

		await this.waitForReadyOrExit(handleId, proc);

		const startMsg: StartMessage = {
			kind: "start",
			handle_id: handleId,
			genome_path: handle.genomePath,
			session_id: this.sessionId,
			self: handle.address,
			caller: handle.caller,
			goal: message,
			shared: handle.keepAlive,
			eval_mode: handle.evalMode,
			provider_id: handle.providerIdOverride,
			resolver_settings: handle.resolverSettings,
			trusted_user_instruction: handle.trustedUserInstruction,
			surfaced_memory_block: handle.surfacedMemoryBlock,
		};
		await this.bus.publish(inboxTopic, JSON.stringify(startMsg));

		if (blocking) {
			return this.waitAgent(handleId);
		}
		return Promise.resolve(undefined);
	}

	async deliverObserverFrame(opts: DeliverObserverFrameOptions): Promise<void> {
		const previous = this.observerDeliveryChains.get(opts.handleId) ?? Promise.resolve();
		const next = previous
			.catch(() => {
				// A failed frame must not permanently poison later observer delivery.
			})
			.then(() => this.deliverObserverFrameNow(opts));
		this.observerDeliveryChains.set(opts.handleId, next);
		try {
			await next;
		} finally {
			if (this.observerDeliveryChains.get(opts.handleId) === next) {
				this.observerDeliveryChains.delete(opts.handleId);
			}
		}
	}

	private async deliverObserverFrameNow(opts: DeliverObserverFrameOptions): Promise<void> {
		const existing = this.handles.get(opts.handleId);
		if (!existing) {
			const result = await this.spawnAgent({
				agentName: opts.agentName,
				genomePath: opts.genomePath,
				projectDataDir: opts.projectDataDir,
				caller: opts.caller,
				goal: opts.message,
				blocking: true,
				shared: false,
				keepAlive: true,
				visibility: "private",
				isObserver: true,
				workDir: opts.workDir,
				handleId: opts.handleId,
				agentId: opts.agentId,
				rootDir: opts.rootDir,
				evalMode: opts.evalMode,
				resolverSettings: opts.resolverSettings,
				surfacedMemoryBlock: opts.surfacedMemoryBlock,
			});
			if (typeof result === "string") {
				throw new Error(`Observer '${opts.agentName}' did not finish its frame turn`);
			}
			if (!result.success) {
				throw new Error(result.output);
			}
			return;
		}

		if (!existing.isObserver) {
			throw new Error(`Handle ${opts.handleId} is not an observer handle`);
		}
		if (
			existing.owner.handleId !== opts.caller.handleId ||
			existing.owner.agentId !== opts.caller.agentId
		) {
			throw new Error(
				`Observer handle ${opts.handleId} is owned by '${existing.owner.agentName}', not '${opts.caller.agentName}'`,
			);
		}

		const result = await this.messageAgent(opts.handleId, opts.message, opts.caller, true);
		if (!result) {
			throw new Error(`Observer '${opts.agentName}' did not return a frame result`);
		}
		if (!result.success) {
			throw new Error(result.output);
		}
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
			caller: AgentAddress;
			workDir: string;
			agentId?: string;
			evalMode?: boolean;
			rootDir?: string;
			projectDataDir?: string;
			providerIdOverride?: string;
			resolverSettings?: ResolverSettings;
			trustedUserInstruction?: string;
			surfacedMemoryBlock?: string;
		},
	): void {
		// Skip if the handle already exists (e.g. re-spawned since the
		// original completed state was recorded). Avoids overwriting a
		// live handle with stale completed data.
		if (this.handles.has(handleId)) return;

		const handle: AgentHandle = {
			handleId,
			agentId: spawnInfo?.agentId ?? handleId,
			address: {
				agentName: spawnInfo?.agentName ?? "",
				depth: (spawnInfo?.caller.depth ?? 0) + 1,
				handleId,
				agentId: spawnInfo?.agentId ?? handleId,
			},
			process: { kill: () => {}, exited: Promise.resolve(0) },
			status: "completed",
			result,
			keepAlive: false,
			visibility: "private",
			isObserver: false,
			pendingWaiters: [],
			owner: spawnInfo?.caller ?? {
				agentName: ownerId,
				depth: 0,
				handleId: ownerId,
				agentId: ownerId,
			},
			agentName: spawnInfo?.agentName ?? "",
			genomePath: spawnInfo?.genomePath ?? "",
			caller:
				spawnInfo?.caller ??
				({
					agentName: ownerId,
					depth: 0,
					handleId: ownerId,
					agentId: ownerId,
				} satisfies AgentAddress),
			workDir: spawnInfo?.workDir ?? "",
			rootDir: spawnInfo?.rootDir,
			projectDataDir: spawnInfo?.projectDataDir,
			evalMode: spawnInfo?.evalMode,
			providerIdOverride: spawnInfo?.providerIdOverride,
			resolverSettings: spawnInfo?.resolverSettings,
			trustedUserInstruction: spawnInfo?.trustedUserInstruction,
			surfacedMemoryBlock: spawnInfo?.surfacedMemoryBlock,
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
	async shutdown(): Promise<void> {
		const processesToStop: Array<{
			process: AgentHandle["process"];
			exited: Promise<number>;
		}> = [];
		for (const handle of this.handles.values()) {
			for (const waiter of handle.pendingWaiters) {
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.reject(new Error("Spawner shutting down"));
			}
			handle.pendingWaiters = [];

			if (handle.status === "running" || handle.status === "idle") {
				handle.process.kill("SIGTERM");
				processesToStop.push({ process: handle.process, exited: handle.process.exited });
			}
			if (handle.resultTopic && this.bus.connected) {
				this.bus.unsubscribe(handle.resultTopic).catch(() => {});
			}
		}
		await forceKillAfterGrace(processesToStop, PROCESS_SHUTDOWN_GRACE_MS);
		if (this.currentSessionEventsTopic && this.bus.connected) {
			this.bus.unsubscribe(this.currentSessionEventsTopic).catch(() => {});
		}
		if (this.currentRootInboxTopic && this.bus.connected) {
			this.bus.unsubscribe(this.currentRootInboxTopic).catch(() => {});
		}
	}

	private async publishAgentMessageWithAck(
		inboxTopic: string,
		message: AgentMessageMessage,
		timeoutMessage: string,
	): Promise<void> {
		const ackTopic = agentMessageAck(this.sessionId, ulid());
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		let resolveAck: (() => void) | undefined;
		let rejectAck: ((error: Error) => void) | undefined;
		const ackPromise = new Promise<void>((resolve, reject) => {
			resolveAck = resolve;
			rejectAck = reject;
		});
		const onAck = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolveAck?.();
		};

		await this.bus.subscribe(ackTopic, onAck);
		try {
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				rejectAck?.(new Error(`${timeoutMessage} within ${this.agentMessageAckTimeoutMs}ms`));
			}, this.agentMessageAckTimeoutMs);
			await this.bus.publish(inboxTopic, JSON.stringify({ ...message, ack_topic: ackTopic }));
			await ackPromise;
		} finally {
			if (timer) clearTimeout(timer);
			if (this.bus.connected) {
				await this.bus.unsubscribe(ackTopic).catch(() => {});
			}
		}
	}

	private async ackAgentMessage(message: AgentMessageMessage): Promise<void> {
		if (!message.ack_topic || !this.bus.connected) return;
		await this.bus.publish(message.ack_topic, "delivered").catch(() => {});
	}
}
