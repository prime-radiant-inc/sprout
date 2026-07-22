import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { formatDelegationGoal, normalizeTaskPayload } from "../agents/delegation-payload.ts";
import type { ResolverSettings } from "../agents/model-resolver.ts";
import type { HandleRegistrar } from "../host/handle-registrar.ts";
import { hashToken, mintToken, type ObserverRemit } from "../host/handle-registry.ts";
import type { SessionEvent } from "../kernel/types.ts";
import { type Message, Msg } from "../llm/types.ts";
import type { LivenessProbe } from "../shared/liveness.ts";
import type { StoreAccess } from "../store/store-access.ts";
import { buildInternalSproutCommand } from "../util/self-command.ts";
import { ulid } from "../util/ulid.ts";
import type { BusClient } from "./client.ts";
import { prepareResultOutput } from "./result-gate.ts";
import { readHandleResult, replayHandleLog } from "./resume.ts";
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
	/** When false, exec is stripped in the child subprocess (and its descendants). Default true. */
	allowExec?: boolean;
	/** Data-plane session flag (spec §6): inherited by the child. Default true. */
	dataPlaneEnabled?: boolean;
	/**
	 * Per-spawn model override (spec §5): a tier ("fast") or a "provider:model"
	 * selection string. Travels on the StartMessage and resolves as the child's
	 * modelOverride; recorded on the handle so respawn re-applies it.
	 */
	model?: string;
	/** Selected provider context inherited from the caller. */
	providerIdOverride?: string;
	/** Provider tier defaults and enabled-provider state inherited from the caller. */
	resolverSettings?: ResolverSettings;
	/**
	 * Run this spawn in the owner's process instead of a subprocess (spec §5
	 * featherweight placement). The caller sets it only for featherweight-eligible
	 * specs; honored only when the spawner holds a featherweight executor.
	 */
	featherweight?: boolean;
	/** Original user instruction, trusted for deterministic runtime policy gates. */
	trustedUserInstruction?: string;
	/** Precomputed memory context inherited from the root session. Empty string suppresses it. */
	surfacedMemoryBlock?: string;
	/**
	 * Env grants for the child: alias → a value name or ulid in the CALLER's
	 * scope. The spawner registers each grant over the authenticated store
	 * before launch and sends alias → resolved ULID on the StartMessage.
	 */
	env?: Record<string, string>;
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
	/**
	 * How this process asks about a counterparty's liveness — used by the
	 * agent's inactivity-timer suspension as its net during blocking waits.
	 */
	probe?: LivenessProbe;
	/** Caller-scoped store surface (sap spec §1) for the value primitives. */
	store?: StoreAccess;
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
	allowExec?: boolean;
	dataPlaneEnabled?: boolean;
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
	/** When false, exec is stripped on the respawn StartMessage too. Default true. */
	allowExec?: boolean;
	/** Data-plane session flag (spec §6): re-applied on the respawn StartMessage. */
	dataPlaneEnabled?: boolean;
	/** Per-spawn model override, re-applied on the respawn StartMessage. */
	model?: string;
	providerIdOverride?: string;
	resolverSettings?: ResolverSettings;
	trustedUserInstruction?: string;
	surfacedMemoryBlock?: string;
	resultRecoveryLogOffset?: number | null;
	/** This handle ran in-process (spec §5 featherweight); respawn re-runs in-process. */
	featherweight?: boolean;
}

/**
 * Function that spawns an agent process. In production uses Bun.spawn();
 * in tests can use runAgentProcess() in-process.
 */
export type SpawnFn = (
	handleId: string,
	env: Record<string, string>,
) => { kill: (signal?: "SIGTERM" | "SIGKILL") => void; exited: Promise<number> };

/**
 * Input to a featherweight in-process execution (spec §5). Mirrors the subset
 * of a StartMessage a single-turn no-tool leaf needs, plus any prior history for
 * a follow-up message_agent re-run (respawn-with-history equivalent).
 */
export interface FeatherweightExecInput {
	agentName: string;
	/** The child goal, already formatted (hints/payload/env announcement included). */
	goal: string;
	self: AgentAddress;
	caller: AgentAddress;
	evalMode?: boolean;
	model?: string;
	providerIdOverride?: string;
	resolverSettings?: ResolverSettings;
	/** The caller-surfaced memory block, exactly as a subprocess child receives it. */
	surfacedMemoryBlock?: string;
	/** Prior conversation replayed from the handle log for a re-run. */
	history?: Message[];
}

/** One registered env grant, enough to synthesize the child's announcement line. */
interface EnvGrantAnnouncement {
	alias: string;
	preview: string;
}

/**
 * The announcement text a subprocess child derives by claiming its grants
 * (agent-process claimEnvGrants). A featherweight child cannot claim — the
 * store keys claims by recipient scope, and the child has none of its own —
 * so the owner synthesizes the identical text from the registrations.
 */
function renderEnvAnnouncement(granted: EnvGrantAnnouncement[] | undefined): string | undefined {
	if (!granted || granted.length === 0) return undefined;
	const lines = granted.map((grant) => `⟦${grant.alias}⟧ (${grant.preview.split("\n", 1)[0]})`);
	return `Values now in your scope:\n${lines.join("\n")}`;
}

/** Result of a featherweight execution — the run outcome the owner synthesizes into events/log. */
export interface FeatherweightExecResult {
	output: string;
	success: boolean;
	stumbles: number;
	turns: number;
	timed_out: boolean;
}

/**
 * Runs a featherweight-eligible agent in the owner's process (spec §5). Injected
 * by the owning Agent, which holds the LLM client. When absent, featherweight
 * spawns fall back to the ordinary subprocess path.
 */
export type FeatherweightFn = (input: FeatherweightExecInput) => Promise<FeatherweightExecResult>;

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

/** Build a SessionEvent record with the standard envelope. */
function logEvent(
	kind: SessionEvent["kind"],
	agentId: string,
	depth: number,
	data: Record<string, unknown>,
): SessionEvent {
	return { kind, timestamp: Date.now(), agent_id: agentId, depth, data };
}

/** Stable event identity for a handle (agentId, falling back to the handle id). */
function agentIdOf(handle: AgentHandle): string {
	return handle.agentId ?? handle.handleId;
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
	private featherweightFn?: FeatherweightFn;
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
		featherweightFn?: FeatherweightFn,
	) {
		this.bus = bus;
		this.busUrl = busUrl;
		this.sessionId = sessionId;
		this.spawnFn = spawnFn ?? defaultSpawnFn;
		this.featherweightFn = featherweightFn;
		this.authChannel = authChannel;
		this.waitTimeoutMs = waitTimeoutMs ?? 900_000;
		this.agentMessageAckTimeoutMs =
			agentMessageAckTimeoutMs ?? DEFAULT_AGENT_MESSAGE_ACK_TIMEOUT_MS;
	}

	/**
	 * Wire the featherweight in-process executor (spec §5). The owning Agent calls
	 * this after construction, since it holds the LLM client the executor needs.
	 * Without it, featherweight-flagged spawns fall back to the subprocess path.
	 */
	setFeatherweightExecutor(fn: FeatherweightFn): void {
		this.featherweightFn = fn;
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

	/** Liveness probe from the auth channel, if this spawner has one. */
	get livenessProbe(): LivenessProbe | undefined {
		return this.authChannel?.probe;
	}

	/** Caller-scoped store access from the auth channel, if this spawner has one. */
	get storeAccess(): StoreAccess | undefined {
		return this.authChannel?.store;
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
		// INVARIANT: every child of an auth-channel spawner gets its OWN token
		// here. defaultSpawnFn merges over process.env, so if a child were ever
		// spawned without this override while the parent's env held a token,
		// the child would inherit the parent's token and could authenticate as
		// the parent.
		return { SPROUT_AUTH_URL: this.authChannel.url, SPROUT_HANDLE_TOKEN: token };
	}

	/**
	 * Register env grants for a recipient over the authenticated store BEFORE
	 * the bus message that carries them (spec §3: registered, not asserted).
	 * Returns the wire env — alias → the granted value's resolved ULID — for
	 * the recipient's claim to verify. A rejected grant (alias collision,
	 * foreign value) throws, failing the spawn/message loudly so the sender can
	 * re-alias. Env without an authenticated store is a loud error too: an
	 * unregistered env could never bind.
	 */
	private async registerEnvGrants(
		recipientHandleId: string,
		env: Record<string, string> | undefined,
	): Promise<{ wire: Record<string, string>; granted: EnvGrantAnnouncement[] } | undefined> {
		if (env === undefined || Object.keys(env).length === 0) return undefined;
		const store = this.authChannel?.store;
		if (!store) {
			throw new Error("env grants require the authenticated store, but none is available");
		}
		const wire: Record<string, string> = {};
		const granted: EnvGrantAnnouncement[] = [];
		for (const [alias, ref] of Object.entries(env)) {
			const metadata = await store.registerEnvGrant(recipientHandleId, alias, ref);
			wire[alias] = metadata.ulid;
			granted.push({ alias, preview: metadata.preview });
		}
		return { wire, granted };
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

		// Featherweight placement (spec §5): a single-turn no-tool no-spawn leaf runs
		// in this process, producing a synthetic handle, session events, and log so
		// wait_agent/message_agent/resume behave identically to a subprocess child.
		if (opts.featherweight && this.featherweightFn) {
			return this.spawnFeatherweight(opts, handleId, agentId, self, visibility, keepAlive);
		}

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

		// Grants register before launch so the child's claims find them pending;
		// a rejection aborts the spawn before any process exists.
		const wireEnv = (await this.registerEnvGrants(handleId, opts.env))?.wire;

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
			allowExec: opts.allowExec,
			dataPlaneEnabled: opts.dataPlaneEnabled,
			model: opts.model,
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
			allow_exec: opts.allowExec,
			data_plane_enabled: opts.dataPlaneEnabled,
			model: opts.model,
			provider_id: opts.providerIdOverride,
			resolver_settings: opts.resolverSettings,
			trusted_user_instruction: opts.trustedUserInstruction,
			surfaced_memory_block: opts.surfacedMemoryBlock,
			env: wireEnv,
		};
		await this.bus.publish(inboxTopic, JSON.stringify(startMsg));

		if (opts.blocking) {
			return this.waitForBlockingSpawn(handleId);
		}

		return handleId;
	}

	/**
	 * Run a featherweight-eligible spawn in this process (spec §5). Registers a
	 * synthetic completed handle, publishes session_start/session_end on the
	 * session-wide topic, and writes a perceive/plan_end/session_end per-handle
	 * log — the minimal records resume registration and respawn-with-history need.
	 */
	private async spawnFeatherweight(
		opts: SpawnAgentOptions,
		handleId: string,
		agentId: string,
		self: AgentAddress,
		visibility: HandleVisibility,
		keepAlive: boolean,
	): Promise<ResultMessage | string> {
		const handle: AgentHandle = {
			handleId,
			agentId,
			address: self,
			process: { kill: () => {}, exited: Promise.resolve(0) },
			status: "running",
			keepAlive,
			visibility,
			isObserver: false,
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
			allowExec: opts.allowExec,
			dataPlaneEnabled: opts.dataPlaneEnabled,
			model: opts.model,
			providerIdOverride: opts.providerIdOverride,
			resolverSettings: opts.resolverSettings,
			trustedUserInstruction: opts.trustedUserInstruction,
			surfacedMemoryBlock: opts.surfacedMemoryBlock,
			featherweight: true,
		};
		this.handles.set(handleId, handle);

		// Parity with the subprocess path (spec §5): grants register before the
		// run — a rejection aborts the spawn — and hints/payload format into the
		// child goal exactly as the subprocess child formats its StartMessage.
		const registration = await this.registerEnvGrants(handleId, opts.env);
		const baseGoal = formatDelegationGoal({
			goal: opts.goal,
			hints: opts.hints,
			payload: opts.payload ? normalizeTaskPayload(opts.payload, "agent start message") : undefined,
		});
		const announcement = renderEnvAnnouncement(registration?.granted);
		const goal = announcement ? `${baseGoal}\n\n${announcement}` : baseGoal;

		const result = await this.runFeatherweight(handle, goal);
		this.settleHandleResult(handle, result, keepAlive ? "idle" : "completed");

		if (opts.blocking) {
			return result;
		}
		return handleId;
	}

	/**
	 * Execute one featherweight turn and produce the equivalent observable state
	 * (spec §5): the run outcome via the injected executor, session events on the
	 * session-wide topic, and the three-record per-handle log. Re-runs (a
	 * follow-up message_agent) replay the prior log so history is present.
	 */
	private async runFeatherweight(handle: AgentHandle, goal: string): Promise<ResultMessage> {
		const dataDir = handle.projectDataDir ?? handle.genomePath;
		const handleLogDir = join(dataDir, "logs", this.sessionId);
		const logPath = join(handleLogDir, `${handle.handleId}.jsonl`);
		const priorHistory = await replayHandleLog(logPath);

		const exec = await this.featherweightFn!({
			agentName: handle.agentName,
			goal,
			self: handle.address,
			caller: handle.caller,
			evalMode: handle.evalMode,
			model: handle.model,
			providerIdOverride: handle.providerIdOverride,
			resolverSettings: handle.resolverSettings,
			surfacedMemoryBlock: handle.surfacedMemoryBlock,
			history: priorHistory.length > 0 ? priorHistory : undefined,
		});

		const depth = handle.address.depth;
		const startData = {
			goal,
			session_id: this.sessionId,
			...(handle.model ? { model: handle.model } : {}),
		};
		const endData = {
			session_id: this.sessionId,
			success: exec.success,
			stumbles: exec.stumbles,
			turns: exec.turns,
			timed_out: exec.timed_out,
			output: exec.output,
		};

		// Session-wide topic: a subprocess child publishes session_start/session_end
		// itself; the owner synthesizes them so featherweight fan-out stays visible.
		this.publishSessionEvent(handle.handleId, "session_start", agentIdOf(handle), depth, startData);

		// Per-handle log: perceive + plan_end rebuild history on a follow-up
		// message_agent; session_end registers the completed handle on resume.
		await mkdir(handleLogDir, { recursive: true });
		const records: SessionEvent[] = [
			logEvent("perceive", agentIdOf(handle), depth, { goal }),
			logEvent("plan_end", agentIdOf(handle), depth, {
				assistant_message: Msg.assistant(exec.output),
			}),
			logEvent("session_end", agentIdOf(handle), depth, endData),
		];
		await appendFile(logPath, records.map((r) => `${JSON.stringify(r)}\n`).join(""));

		this.publishSessionEvent(handle.handleId, "session_end", agentIdOf(handle), depth, endData);

		// Featherweight capture (capture-all spec v10): the live result gates
		// through the shared boundary — parent-scope bind, NO publish (the value
		// is already in the parent's scope). PRIVATE handles only: a shared
		// handle's future waiter could not reach a parent-scope value, so shared
		// results keep the raw path. The durable log above stays full-fidelity
		// raw (child-facing replay must not lose its own prior answer).
		const gatedOutput =
			handle.visibility !== "shared" && this.storeAccess !== undefined
				? await prepareResultOutput(this.storeAccess, handle.handleId, goal, exec.output, {
						publish: false,
					})
				: exec.output;

		return {
			kind: "result",
			handle_id: handle.handleId,
			output: gatedOutput,
			success: exec.success,
			stumbles: exec.stumbles,
			turns: exec.turns,
			timed_out: exec.timed_out,
		};
	}

	private publishSessionEvent(
		handleId: string,
		kind: SessionEvent["kind"],
		agentId: string,
		depth: number,
		data: Record<string, unknown>,
	): void {
		if (!this.bus.connected) return;
		const eventMsg: EventMessage = {
			kind: "event",
			handle_id: handleId,
			event: logEvent(kind, agentId, depth, data),
		};
		void this.bus.publish(sessionEvents(this.sessionId), JSON.stringify(eventMsg));
	}

	private waitForBlockingSpawn(handleId: string): Promise<ResultMessage> {
		// The spec's timer-less blocking-wait path: exactly waitAgent with no
		// caller (internal waits skip access checks) and no timeout.
		return this.waitAgent(handleId, undefined, { untimed: true });
	}

	/**
	 * Wait for an agent to produce a result.
	 * Returns immediately if a result is already cached.
	 * Throws if the handle ID is unknown.
	 *
	 * When caller is provided, access control is enforced:
	 * non-shared handles reject callers other than the owner.
	 * Internal calls (e.g. the blocking path in spawnAgent) omit caller to skip the check.
	 *
	 * `untimed` drops the waiter cap (sap spec §4): the ambient handle.wait()
	 * path uses the timer-less blocking wait; the wait_agent TOOL keeps its cap.
	 */
	waitAgent(
		handleId: string,
		caller?: AgentAddress,
		opts: { untimed?: boolean } = {},
	): Promise<ResultMessage> {
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
				resolve,
				reject,
				...(opts.untimed
					? {}
					: {
							timer: setTimeout(() => {
								const idx = handle.pendingWaiters.indexOf(waiter);
								if (idx !== -1) handle.pendingWaiters.splice(idx, 1);
								reject(new Error(`waitAgent timed out for handle ${handleId}`));
							}, this.waitTimeoutMs),
						}),
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
		options: {
			/** Original user instruction, trusted for deterministic policy gates. */
			trustedUserInstruction?: string;
			/** Runtime caller address, required for the "caller" alias. */
			callerTarget?: AgentAddress;
			/** Env grants: alias → a value name or ulid in the CALLER's scope. */
			envGrants?: Record<string, string>;
		} = {},
	): Promise<ResultMessage | undefined> {
		const { trustedUserInstruction, callerTarget, envGrants } = options;
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
				env: (await this.registerEnvGrants("root", envGrants))?.wire,
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
				env: (await this.registerEnvGrants(callerTarget.handleId, envGrants))?.wire,
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

		// A completed/idle featherweight handle re-runs in-process with its prior
		// history replayed (spec §5 respawn-with-history equivalent).
		if (handle.featherweight && this.featherweightFn && handle.status !== "running") {
			handle.trustedUserInstruction = trustedUserInstruction;
			handle.result = undefined;
			handle.status = "running";
			const registration = await this.registerEnvGrants(handleId, envGrants);
			const announcement = renderEnvAnnouncement(registration?.granted);
			const result = await this.runFeatherweight(
				handle,
				announcement ? `${message}\n\n${announcement}` : message,
			);
			this.settleHandleResult(handle, result, handle.keepAlive ? "idle" : "completed");
			return blocking ? result : undefined;
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
				env: (await this.registerEnvGrants(handleId, envGrants))?.wire,
			};

			await this.bus.publish(inboxTopic, JSON.stringify(agentMsg));
			return Promise.resolve(undefined);
		}

		if (handle.status === "idle") {
			// Grants register before the continue publishes (spec §3).
			const wireEnv = (await this.registerEnvGrants(handleId, envGrants))?.wire;
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
				env: wireEnv,
			};
			await this.bus.publish(inboxTopic, JSON.stringify(continueMsg));

			if (blocking) {
				return this.waitAgent(handleId);
			}
			return Promise.resolve(undefined);
		}

		// Agent process has exited — re-spawn with the message as the new goal.
		// The agent process auto-resumes from its prior event log.
		// Grants register before the fresh StartMessage carries them.
		const respawnWireEnv = (await this.registerEnvGrants(handleId, envGrants))?.wire;
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
			allow_exec: handle.allowExec,
			data_plane_enabled: handle.dataPlaneEnabled,
			model: handle.model,
			provider_id: handle.providerIdOverride,
			resolver_settings: handle.resolverSettings,
			trusted_user_instruction: handle.trustedUserInstruction,
			surfaced_memory_block: handle.surfacedMemoryBlock,
			env: respawnWireEnv,
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
				allowExec: opts.allowExec,
				dataPlaneEnabled: opts.dataPlaneEnabled,
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
			allowExec?: boolean;
			dataPlaneEnabled?: boolean;
			rootDir?: string;
			projectDataDir?: string;
			model?: string;
			providerIdOverride?: string;
			resolverSettings?: ResolverSettings;
			trustedUserInstruction?: string;
			surfacedMemoryBlock?: string;
			featherweight?: boolean;
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
			allowExec: spawnInfo?.allowExec,
			dataPlaneEnabled: spawnInfo?.dataPlaneEnabled,
			model: spawnInfo?.model,
			providerIdOverride: spawnInfo?.providerIdOverride,
			resolverSettings: spawnInfo?.resolverSettings,
			trustedUserInstruction: spawnInfo?.trustedUserInstruction,
			surfacedMemoryBlock: spawnInfo?.surfacedMemoryBlock,
			featherweight: spawnInfo?.featherweight,
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
