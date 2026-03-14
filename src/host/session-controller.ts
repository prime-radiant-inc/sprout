import { join } from "node:path";
import { AgentEventEmitter } from "../agents/events.ts";
import { createAgent } from "../agents/factory.ts";
import type { ResolverSettings } from "../agents/model-resolver.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { Command, ModelRef, SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import { ulid } from "../util/ulid.ts";
import { compactHistory } from "./compaction.ts";
import type { SessionBus } from "./event-bus.ts";
import {
	createSessionCommandHandlers,
	type SessionCommandHandlers,
} from "./session-controller-commands.ts";
import { SessionMetadata } from "./session-metadata.ts";
import {
	persistPlanEndMetadataUpdate,
	persistRunningMetadata,
	persistTerminalMetadata,
} from "./session-metadata-updater.ts";
import {
	createDefaultSessionSelectionSnapshot,
	defaultResolveSessionSelectionRequest,
	type SessionSelectionSnapshot,
	selectionSnapshotToCurrentModel,
	selectionSnapshotToModelOverride,
	selectionSnapshotToProviderId,
} from "./session-selection.ts";
import {
	applyHistoryShadowUpdate,
	beginSubmitGoalTransition,
	clearSessionShadowState,
} from "./session-state.ts";

/** Minimal agent interface used by the SessionController. */
interface RunnableAgent {
	steer(text: string): void;
	requestCompaction(): void;
	run(
		goal: string,
		signal?: AbortSignal,
	): Promise<{
		output: string;
		success: boolean;
		stumbles: number;
		turns: number;
		timed_out: boolean;
	}>;
}

/** Options passed to the agent factory. */
export interface AgentFactoryOptions {
	genomePath: string;
	/** Per-project data directory (sessions, logs, memory). */
	projectDataDir?: string;
	rootDir?: string;
	workDir: string;
	rootAgent?: string;
	sessionId: string;
	/** SessionBus used as the event emitter. Compatible with AgentEventEmitter. */
	events: SessionBus;
	/** Prior conversation history for resume/continuation. */
	initialHistory?: Message[];
	/** Model override from /model command. */
	model?: string | ModelRef;
	/** Default provider context for exact-model resolution. */
	providerIdOverride?: string;
	/** Provider settings used for global tier and exact-model resolution. */
	resolverSettings?: ResolverSettings;
	/** Bus-based spawner for running subagents as separate processes. */
	spawner?: AgentSpawner;
	/** Pre-loaded Genome instance. If provided, skips loading from disk. */
	genome?: import("../genome/genome.ts").Genome;
	evalMode?: boolean;
	/** Completed child handles from a previous session, to pre-register in the spawner. */
	completedHandles?: Array<{
		handleId: string;
		result: import("../bus/types.ts").ResultMessage;
		ownerId: string;
	}>;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("./logger.ts").Logger;
	/** Pre-configured LLM client (e.g. with middleware). */
	client?: import("../llm/client.ts").Client;
}

/** Result returned by the agent factory. */
export interface AgentFactoryResult {
	agent: RunnableAgent;
	learnProcess: { startBackground(): void; stopBackground(): Promise<void> } | null;
	/** Compact conversation history via LLM summarization. Available after agent creation. */
	compact?: (
		history: Message[],
		logPath: string,
	) => Promise<{ summary: string; beforeCount: number; afterCount: number }>;
}

/** Factory function that creates an agent. Injectable for testing. */
export type AgentFactory = (options: AgentFactoryOptions) => Promise<AgentFactoryResult>;

export interface SessionControllerOptions {
	bus: SessionBus;
	genomePath: string;
	/** Per-project data directory (sessions, logs, memory). Defaults to genomePath. */
	projectDataDir?: string;
	rootDir?: string;
	rootAgent?: string;
	factory?: AgentFactory;
	sessionId?: string;
	initialHistory?: Message[];
	/** Bus-based spawner to forward to the agent factory. */
	spawner?: AgentSpawner;
	/** Pre-loaded Genome instance to forward to the agent factory. */
	genome?: import("../genome/genome.ts").Genome;
	evalMode?: boolean;
	/** Completed child handles from a previous session, to pre-register in the spawner. */
	completedHandles?: Array<{
		handleId: string;
		result: import("../bus/types.ts").ResultMessage;
		ownerId: string;
	}>;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("./logger.ts").Logger;
	/** Pre-configured LLM client (e.g. with middleware) to forward to the agent factory. */
	client?: import("../llm/client.ts").Client;
	initialSelection?: SessionSelectionSnapshot;
	resolveSelection?: (selection: SessionSelectionRequest) => SessionSelectionSnapshot;
	getResolverSettings?: () => ResolverSettings | undefined;
}

export interface SessionRunResult {
	sessionId: string;
	output: string;
	success: boolean;
	stumbles: number;
	turns: number;
	timedOut: boolean;
}

/**
 * Default factory that delegates to createAgent from the agents module.
 * Relays events from the agent's AgentEventEmitter to the SessionBus.
 */
async function defaultFactory(options: AgentFactoryOptions): Promise<AgentFactoryResult> {
	const agentEvents = new AgentEventEmitter();

	// Relay agent events to the bus
	agentEvents.on((event) => {
		options.events.emitEvent(event.kind, event.agent_id, event.depth, event.data);
	});

	if (options.spawner) {
		// Pre-register completed child handles from a previous session
		if (options.completedHandles) {
			for (const { handleId, result, ownerId } of options.completedHandles) {
				options.spawner.registerCompletedHandle(handleId, result, ownerId);
			}
		}
	}

	const result = await createAgent({
		genomePath: options.genomePath,
		projectDataDir: options.projectDataDir,
		rootDir: options.rootDir,
		workDir: options.workDir,
		rootAgent: options.rootAgent,
		events: agentEvents,
		sessionId: options.sessionId,
		initialHistory: options.initialHistory,
		model: options.model,
		providerIdOverride: options.providerIdOverride,
		resolverSettings: options.resolverSettings,
		spawner: options.spawner,
		genome: options.genome,
		evalMode: options.evalMode,
		logger: options.logger,
		client: options.client,
	});

	return {
		agent: result.agent,
		learnProcess: result.learnProcess,
		compact: (history, logPath) =>
			compactHistory({
				history,
				client: result.client,
				model: result.model,
				provider: result.provider,
				logPath,
			}),
	};
}

/**
 * Stateful core that owns the agent lifecycle.
 *
 * Subscribes to SessionBus commands (down), routes them to the agent,
 * and relays agent events back through the bus (up).
 */
export class SessionController {
	private _sessionId: string;
	private agent: RunnableAgent | null = null;
	private abortController = new AbortController();
	private metadata: SessionMetadata;
	private readonly bus: SessionBus;
	private readonly genomePath: string;
	private readonly projectDataDir: string;
	private readonly rootDir?: string;
	private readonly rootAgentName?: string;
	private readonly factory: AgentFactory;
	private readonly spawner?: AgentSpawner;
	private readonly genome?: import("../genome/genome.ts").Genome;
	private readonly evalMode: boolean;
	private readonly completedHandles?: SessionControllerOptions["completedHandles"];
	private readonly logger?: import("./logger.ts").Logger;
	private readonly client?: import("../llm/client.ts").Client;
	private readonly resolveSelectionFn: (
		selection: SessionSelectionRequest,
	) => SessionSelectionSnapshot;
	private readonly getResolverSettings?: () => ResolverSettings | undefined;
	private history: Message[] = [];
	private running = false;
	private selectionSnapshot: SessionSelectionSnapshot;
	private hasRun = false;
	/** Suppresses event accumulation after /clear until the next submitGoal. */
	private suppressEvents = false;
	/** Incremented on each submitGoal; the finally block only writes shared
	 *  state (running, agent) if the generation hasn't changed (i.e. no /clear
	 *  started a newer run in the meantime). */
	private runGeneration = 0;
	private compactFn?: AgentFactoryResult["compact"];
	private spawnerReady?: Promise<void>;
	private readonly commandHandlers: SessionCommandHandlers;

	get sessionId(): string {
		return this._sessionId;
	}

	constructor(options: SessionControllerOptions) {
		this._sessionId = options.sessionId ?? ulid();
		this.bus = options.bus;
		this.genomePath = options.genomePath;
		this.projectDataDir = options.projectDataDir ?? options.genomePath;
		this.rootDir = options.rootDir;
		this.rootAgentName = options.rootAgent;
		this.factory = options.factory ?? defaultFactory;
		this.spawner = options.spawner;
		this.genome = options.genome;
		this.evalMode = options.evalMode === true;
		this.completedHandles = options.completedHandles;
		this.logger = options.logger;
		this.client = options.client;
		this.resolveSelectionFn = options.resolveSelection ?? defaultResolveSessionSelectionRequest;
		this.getResolverSettings = options.getResolverSettings;
		this.selectionSnapshot = options.initialSelection ?? createDefaultSessionSelectionSnapshot();
		this.history = options.initialHistory ? [...options.initialHistory] : [];

		this.metadata = new SessionMetadata({
			sessionId: this._sessionId,
			agentSpec: options.rootAgent ?? "root",
			selection: this.selectionSnapshot.selection,
			resolvedModel: this.selectionSnapshot.resolved,
			sessionsDir: join(this.projectDataDir, "sessions"),
		});

		// Subscribe once to the session-wide events topic so the UI sees events
		// from ALL subprocess agents regardless of depth (O(1) delivery).
		// This must be in the constructor, not the factory, to avoid accumulating
		// subscriptions on each submitGoal call.
		if (this.spawner) {
			this.spawnerReady = this.spawner
				.subscribeSessionEvents((eventMsg) => {
					const ev = eventMsg.event;
					this.bus.emitEvent(ev.kind, ev.agent_id, ev.depth, ev.data);
				})
				.catch((err) => {
					console.error("[SessionController] Failed to subscribe to session events:", err);
				});
		}

		this.commandHandlers = createSessionCommandHandlers({
			submitGoal: (goal) => {
				this.submitGoal(goal).catch((err) => {
					console.error("[SessionController] submitGoal failed:", err);
					this.bus.emitEvent("error", "session", 0, { error: String(err) });
				});
			},
			steer: (text) => {
				this.agent?.steer(text);
			},
			interrupt: () => {
				this.interrupt();
			},
			compact: () => {
				this.handleCompactCommand();
			},
			clear: () => {
				this.clearSession();
			},
			switchModel: (selection) => {
				this.selectionSnapshot = this.resolveSelectionFn(selection ?? { kind: "inherit" });
			},
			quit: () => {
				this.interrupt();
			},
		});

		this.bus.onCommand((cmd) => this.handleCommand(cmd));
		this.bus.onEvent((event) => {
			this.handleEvent(event).catch((err) => {
				console.error("Error handling event:", err);
			});
		});
	}

	private handleCommand(cmd: Command): void {
		this.commandHandlers[cmd.kind](cmd.data);
	}

	private handleCompactCommand(): void {
		if (this.agent) {
			this.agent.requestCompaction();
			return;
		}
		if (this.compactFn && this.history.length > 0) {
			void this.compactWhileIdle();
			return;
		}
		this.bus.emitEvent("warning", "session", 0, {
			message: "Nothing to compact",
		});
	}

	private clearSession(): void {
		this.interrupt();
		const cleared = clearSessionShadowState(ulid());
		this.suppressEvents = cleared.suppressEvents;
		this.running = false;
		this.agent = null;
		this.history = cleared.history;
		this.hasRun = cleared.hasRun;
		this._sessionId = cleared.sessionId;
		this.metadata = new SessionMetadata({
			sessionId: this._sessionId,
			agentSpec: this.rootAgentName ?? "root",
			selection: this.selectionSnapshot.selection,
			resolvedModel: this.selectionSnapshot.resolved,
			sessionsDir: join(this.projectDataDir, "sessions"),
		});
		if (this.logger) {
			const newLogPath = join(this.projectDataDir, "logs", this._sessionId, "session.log.jsonl");
			this.logger.reconfigure({ sessionId: this._sessionId, logPath: newLogPath });
		}
		if (this.spawner) {
			this.spawnerReady = this.spawner
				.clearHandles()
				.then(() => this.spawner!.updateSessionId(this._sessionId))
				.catch((err) => {
					console.error("[SessionController] Failed spawner reset after clear:", err);
				});
		}
		this.bus.emitEvent("session_clear", "session", 0, {
			new_session_id: this._sessionId,
		});
	}

	private async handleEvent(event: SessionEvent): Promise<void> {
		// After /clear, suppress events from the dying agent run so they
		// don't contaminate the new session's history or metadata.
		if (this.suppressEvents) return;

		// Accumulate history synchronously before async operations.
		this.history = applyHistoryShadowUpdate(this.history, event);

		if (event.kind === "plan_end" && event.depth === 0) {
			const turn = (event.data.turn as number) ?? 0;
			const contextTokens = (event.data.context_tokens as number) ?? 0;
			const contextWindowSize = (event.data.context_window_size as number) ?? 0;
			// Safe to re-emit into the bus from within an event handler: the in-process
			// EventBus delivers events synchronously to all listeners in registration
			// order. context_update is informational only (no handlers modify controller
			// state in response), so re-entrancy cannot cause loops or corruption.
			await persistPlanEndMetadataUpdate({
				metadata: this.metadata,
				turn,
				contextTokens,
				contextWindowSize,
				emitContextUpdate: (data) => {
					this.bus.emitEvent("context_update", "session", 0, data);
				},
			});
		}
	}

	private interrupt(): void {
		this.abortController.abort();
	}

	async submitGoal(goal: string): Promise<void> {
		if (this.running) {
			this.logger?.info("session", "Steering running agent", { goal: goal.slice(0, 100) });
			this.agent?.steer(goal);
			return;
		}
		await this.executeGoal(goal);
	}

	async runGoal(goal: string): Promise<SessionRunResult> {
		if (this.running) {
			throw new Error("Cannot run a new goal while the session is already running");
		}
		return this.executeGoal(goal);
	}

	private async executeGoal(goal: string): Promise<SessionRunResult> {
		this.logger?.info("session", "Goal submitted", { goal: goal.slice(0, 100) });
		this.suppressEvents = false;
		// Cancellation is run-scoped. Set the active controller before any await
		// so an immediate /interrupt cannot miss this run.
		const runAbortController = new AbortController();
		this.abortController = runAbortController;
		const signal = runAbortController.signal;

		// Ensure the spawner's session-wide events subscription is active
		// before we create any agents. The subscription is fire-and-forget
		// in the constructor; awaiting here closes the race window.
		if (this.spawnerReady) {
			await this.spawnerReady;
		}

		// Emit session_resume on first run when prior history exists (including
		// compacted single-message history). The TUI uses history_length to show
		// how much context was carried forward.
		const submitTransition = beginSubmitGoalTransition({
			hasRun: this.hasRun,
			historyLength: this.history.length,
		});
		if (submitTransition.shouldEmitResume) {
			this.bus.emitEvent("session_resume", "session", 0, {
				history_length: this.history.length,
			});
		}
		this.hasRun = submitTransition.hasRun;

		// Task 19: If resuming a session with stuck "running" metadata, recover it
		if (this.history.length > 0) {
			const metaPath = join(this.projectDataDir, "sessions", `${this._sessionId}.meta.json`);
			await this.metadata.loadIfExists(metaPath);
		}

		this.selectionSnapshot = this.resolveSelectionFn(this.selectionSnapshot.selection);
		this.metadata.setSelection(this.selectionSnapshot.selection, this.selectionSnapshot.resolved);
		this.running = true;
		this.runGeneration++;
		const generation = this.runGeneration;
		await persistRunningMetadata(this.metadata);

		let learnProcess: AgentFactoryResult["learnProcess"] = null;
		// Capture metadata before the try block so the finally writes to the
		// correct session even if /clear replaces this.metadata mid-run.
		const metadata = this.metadata;

		try {
			const result = await this.factory({
				genomePath: this.genomePath,
				projectDataDir: this.projectDataDir,
				rootDir: this.rootDir,
				workDir: process.cwd(),
				rootAgent: this.rootAgentName,
				events: this.bus,
				sessionId: this._sessionId,
				initialHistory: this.history.length > 0 ? [...this.history] : undefined,
				model: selectionSnapshotToModelOverride(this.selectionSnapshot),
				providerIdOverride: selectionSnapshotToProviderId(this.selectionSnapshot),
				resolverSettings: this.getResolverSettings?.(),
				spawner: this.spawner,
				genome: this.genome,
				evalMode: this.evalMode,
				completedHandles: this.completedHandles,
				logger: this.logger,
				client: this.client,
			});

			this.agent = result.agent;
			learnProcess = result.learnProcess;
			this.logger?.info("session", "Agent created");
			if (result.compact) {
				this.compactFn = result.compact;
			}

			if (learnProcess) {
				learnProcess.startBackground();
			}

			const runResult = await result.agent.run(goal, signal);
			this.logger?.info("session", "Agent run completed");
			return {
				sessionId: this._sessionId,
				output: runResult.output,
				success: runResult.success,
				stumbles: runResult.stumbles,
				turns: runResult.turns,
				timedOut: runResult.timed_out,
			};
		} finally {
			if (learnProcess) {
				await learnProcess.stopBackground();
			}
			// Only update shared state if no /clear has started a newer run.
			// Without this guard, the old finally block would clobber the
			// new run's this.running and this.agent.
			if (this.runGeneration === generation) {
				this.running = false;
				this.agent = null;
			}
			await persistTerminalMetadata(metadata, signal.aborted);
		}
	}

	private async compactWhileIdle(): Promise<void> {
		if (!this.compactFn) return;
		const logPath = join(this.projectDataDir, "logs", `${this._sessionId}.jsonl`);
		try {
			const result = await this.compactFn(this.history, logPath);
			if (result.summary) {
				this.bus.emitEvent("warning", "session", 0, {
					message: `Compacted: ${result.beforeCount} → ${result.afterCount} messages\n${result.summary}`,
				});
			} else {
				this.bus.emitEvent("warning", "session", 0, {
					message: `History too short to compact (${result.beforeCount} messages)`,
				});
			}
		} catch (err) {
			this.bus.emitEvent("error", "session", 0, { error: String(err) });
		}
	}

	get isRunning(): boolean {
		return this.running;
	}

	get currentModel(): string | undefined {
		return selectionSnapshotToCurrentModel(this.selectionSnapshot);
	}

	get currentSelection(): SessionSelectionSnapshot {
		return this.selectionSnapshot;
	}
}
