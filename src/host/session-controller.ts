import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolverSettings } from "../agents/model-resolver.ts";
import type { ObserverAttachmentConfig } from "../agents/observers.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { Genome } from "../genome/genome.ts";
import type { Command, EventKind, SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import { ulid } from "../util/ulid.ts";
import type { SessionBus } from "./event-bus.ts";
import { ObserverRegistry } from "./observer-registry.ts";
import {
	type AgentFactory,
	type AgentFactoryResult,
	defaultFactory,
	type RunnableAgent,
} from "./session-agent-factory.ts";
import {
	createSessionCommandHandlers,
	type SessionCommandHandlers,
} from "./session-controller-commands.ts";
import { type SessionMemorySurfaceSnapshot, SessionMetadata } from "./session-metadata.ts";
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

export {
	type AgentFactory,
	type AgentFactoryOptions,
	type AgentFactoryResult,
	resolveCollapseMemoryModels,
} from "./session-agent-factory.ts";

type AgentRunResult = Awaited<ReturnType<RunnableAgent["run"]>>;

function shouldCollapseRun(_result: AgentRunResult, signal: AbortSignal): boolean {
	return !signal.aborted;
}

function shouldCollapseThrownRun(signal: AbortSignal, terminalSessionEndSeen: boolean): boolean {
	return !signal.aborted && terminalSessionEndSeen;
}

function normalizeMemorySurfaceGoal(goal: string): string {
	return goal.trim().replace(/\s+/g, " ");
}

const DEFAULT_OBSERVER_MAX_EVENTS = 24;
const DEFAULT_OBSERVER_MAX_CHARS = 6000;

function staticObserverHandleId(
	scope: "root" | "session",
	index: number,
	agentName: string,
): string {
	return `observer-${scope}-${index + 1}-${agentName}`;
}

function buildStaticObserverConfigs(
	genome: Genome | undefined,
	rootAgentName: string,
): ObserverAttachmentConfig[] {
	const rootSpec = genome?.getAgent(rootAgentName);
	if (!rootSpec) return [];

	const observerConfigs = (rootSpec.observers ?? []).map((config, index) => {
		const observerSpec = genome?.getAgent(config.agent);
		if (!observerSpec) {
			throw new Error(
				`Observer agent '${config.agent}' configured by '${rootAgentName}' was not found`,
			);
		}
		const handleId = staticObserverHandleId(config.target, index, config.agent);
		return {
			agentName: config.agent,
			target: config.target,
			events: config.events,
			trigger: config.trigger,
			maxEvents: config.delivery?.max_events ?? DEFAULT_OBSERVER_MAX_EVENTS,
			maxChars: config.delivery?.max_chars ?? DEFAULT_OBSERVER_MAX_CHARS,
			handleId,
			agentId: handleId,
			description:
				config.target === "root" ? `observes ${rootAgentName} turns` : "observes session events",
		};
	});

	return observerConfigs;
}

/** Options passed to the agent factory. */
export interface SessionControllerOptions {
	bus: SessionBus;
	genomePath: string;
	/** Per-project data directory (sessions, logs, memory). Defaults to genomePath. */
	projectDataDir?: string;
	/** Working directory for project detection and agent execution. Defaults to process.cwd(). */
	workDir?: string;
	rootDir?: string;
	rootAgent?: string;
	factory?: AgentFactory;
	sessionId?: string;
	initialHistory?: Message[];
	initialMemorySurface?: SessionMemorySurfaceSnapshot;
	/** Bus-based spawner to forward to the agent factory. */
	spawner?: AgentSpawner;
	/** Pre-loaded Genome instance to forward to the agent factory. */
	genome?: import("../genome/genome.ts").Genome;
	evalMode?: boolean;
	/** When false, the exec primitive is stripped tree-wide (root + delegates). Defaults true. */
	allowExec?: boolean;
	/** Data-plane session flag (spec §6); default true. Off = the A/B off arm. */
	dataPlaneEnabled?: boolean;
	nonInteractive?: boolean;
	/** Completed child handles from a previous session, to pre-register in the spawner. */
	completedHandles?: Array<{
		handleId: string;
		result: import("../bus/types.ts").ResultMessage;
		ownerId: string;
		agentName: string;
		agentId?: string;
	}>;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("./logger.ts").Logger;
	/** Pre-configured LLM client (e.g. with middleware) to forward to the agent factory. */
	client?: import("../llm/client.ts").Client;
	initialSelection?: SessionSelectionSnapshot;
	resolveSelection?: (selection: SessionSelectionRequest) => SessionSelectionSnapshot;
	getResolverSettings?: () => ResolverSettings | undefined;
	/** "manual" | "auto" memory-maintenance setting getter (default "auto"),
	 *  read once per run start (spec: a mid-run flip does not abort). */
	getMemoryMaintenanceSetting?: () => "manual" | "auto" | undefined;
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
/**
 * Compose the host-side builders the live mutation gate needs — the factory
 * (agents layer) constructs the gate itself when `SPROUT_MUTATION_GATE=1`, but
 * the LiveTaskExecutor requires host bus infrastructure the agents layer must
 * not import, so the builders are composed here and injected.
 */
export class SessionController {
	private _sessionId: string;
	private agent: RunnableAgent | null = null;
	private abortController = new AbortController();
	private metadata: SessionMetadata;
	private readonly bus: SessionBus;
	private readonly genomePath: string;
	private readonly projectDataDir: string;
	private readonly workDir: string;
	private readonly rootDir?: string;
	private readonly rootAgentName?: string;
	private readonly factory: AgentFactory;
	private readonly spawner?: AgentSpawner;
	private readonly genome?: import("../genome/genome.ts").Genome;
	private readonly evalMode: boolean;
	private readonly allowExec: boolean;
	private readonly dataPlaneEnabled: boolean;
	private readonly nonInteractive: boolean;
	private readonly completedHandles?: SessionControllerOptions["completedHandles"];
	private readonly logger?: import("./logger.ts").Logger;
	private readonly client?: import("../llm/client.ts").Client;
	private readonly resolveSelectionFn: (
		selection: SessionSelectionRequest,
	) => SessionSelectionSnapshot;
	private readonly getResolverSettings?: () => ResolverSettings | undefined;
	private readonly getMemoryMaintenanceSetting?: () => "manual" | "auto" | undefined;
	private history: Message[] = [];
	private memorySurface?: SessionMemorySurfaceSnapshot;
	private running = false;
	private selectionSnapshot: SessionSelectionSnapshot;
	private hasRun = false;
	private terminalSessionEndSeen = false;
	/** Suppresses event accumulation after /clear until the next submitGoal. */
	private suppressEvents = false;
	/** Incremented on each submitGoal; the finally block only writes shared
	 *  state (running, agent) if the generation hasn't changed (i.e. no /clear
	 *  started a newer run in the meantime). */
	private runGeneration = 0;
	private compactFn?: AgentFactoryResult["compact"];
	private spawnerReady?: Promise<void>;
	private observerRegistry?: ObserverRegistry;
	private observerRegistryConfigured = false;
	private controllerEventLogWriteChain: Promise<void> = Promise.resolve();
	private readonly commandHandlers: SessionCommandHandlers;

	get sessionId(): string {
		return this._sessionId;
	}

	constructor(options: SessionControllerOptions) {
		this._sessionId = options.sessionId ?? ulid();
		this.bus = options.bus;
		this.genomePath = options.genomePath;
		this.projectDataDir = options.projectDataDir ?? options.genomePath;
		this.workDir = options.workDir ?? process.cwd();
		this.rootDir = options.rootDir;
		this.rootAgentName = options.rootAgent;
		this.factory = options.factory ?? defaultFactory;
		this.spawner = options.spawner;
		this.genome = options.genome;
		this.evalMode = options.evalMode === true;
		this.allowExec = options.allowExec !== false;
		this.dataPlaneEnabled = options.dataPlaneEnabled !== false;
		this.nonInteractive = options.nonInteractive === true;
		this.completedHandles = options.completedHandles;
		this.logger = options.logger;
		this.client = options.client;
		this.resolveSelectionFn = options.resolveSelection ?? defaultResolveSessionSelectionRequest;
		this.getResolverSettings = options.getResolverSettings;
		this.getMemoryMaintenanceSetting = options.getMemoryMaintenanceSetting;
		this.selectionSnapshot = options.initialSelection ?? createDefaultSessionSelectionSnapshot();
		this.history = options.initialHistory ? [...options.initialHistory] : [];
		this.memorySurface = options.initialMemorySurface;

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
			const observerConfigs = buildStaticObserverConfigs(this.genome, this.rootAgentName ?? "root");
			this.observerRegistryConfigured = observerConfigs.length > 0;
			this.observerRegistry = new ObserverRegistry({
				sessionId: this._sessionId,
				rootAgentName: this.rootAgentName ?? "root",
				spawner: this.spawner,
				genomePath: this.genomePath,
				workDir: this.workDir,
				projectDataDir: this.projectDataDir,
				rootDir: this.rootDir,
				evalMode: this.evalMode,
				configs: observerConfigs,
				getResolverSettings: this.getResolverSettings,
				emitEvent: (kind, agentId, depth, data) => {
					this.emitAndPersistControllerEvent(kind, agentId, depth, data);
				},
			});
			const sessionEventsReady = this.spawner
				.subscribeSessionEvents((eventMsg) => {
					const ev = eventMsg.event;
					this.bus.emitEvent(ev.kind, ev.agent_id, ev.depth, ev.data);
				})
				.catch((err) => {
					console.error("[SessionController] Failed to subscribe to session events:", err);
				});
			const rootMessagesReady = this.spawner
				.subscribeRootMessages((message) => {
					const agent = this.agent;
					if (!agent?.receiveAgentMessage) return false;
					agent.receiveAgentMessage(message.message, message.from);
					return true;
				})
				.catch((err) => {
					console.error("[SessionController] Failed to subscribe to root messages:", err);
				});
			this.spawnerReady = Promise.all([sessionEventsReady, rootMessagesReady]).then(
				() => undefined,
			);
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

	private emitAndPersistControllerEvent(
		kind: EventKind,
		agentId: string,
		depth: number,
		data: Record<string, unknown>,
		logSessionId = this._sessionId,
	): void {
		this.bus.emitEvent(kind, agentId, depth, data);

		const event: SessionEvent = {
			kind,
			timestamp: Date.now(),
			agent_id: agentId,
			depth,
			data,
		};
		const logPath = join(this.projectDataDir, "logs", `${logSessionId}.jsonl`);
		const line = `${JSON.stringify(event)}\n`;
		this.controllerEventLogWriteChain = this.controllerEventLogWriteChain
			.then(async () => {
				await mkdir(dirname(logPath), { recursive: true });
				await appendFile(logPath, line);
			})
			.catch(() => {});
	}

	private clearSession(): void {
		this.interrupt();
		const cleared = clearSessionShadowState(ulid());
		this.suppressEvents = cleared.suppressEvents;
		this.running = false;
		this.agent = null;
		this.history = cleared.history;
		this.memorySurface = undefined;
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
		this.observerRegistry?.reset(this._sessionId);
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
		this.observerRegistry?.handleEvent(event);

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
					this.bus.emitEvent("context_update", "session", 0, {
						...data,
						session_id: event.data.session_id ?? this._sessionId,
					});
				},
			});
		}
		if (event.kind === "recall" && event.depth === 0 && event.data.cached !== true) {
			await this.persistFreshMemorySurface(event);
		}
		if (
			event.kind === "session_end" &&
			event.depth === 0 &&
			(event.data.session_id === undefined || event.data.session_id === this._sessionId)
		) {
			this.terminalSessionEndSeen = true;
		}
	}

	private async persistFreshMemorySurface(event: SessionEvent): Promise<void> {
		const goal = typeof event.data.goal === "string" ? event.data.goal : undefined;
		const memoryBlock =
			typeof event.data.memory_block === "string" ? event.data.memory_block : undefined;
		if (!goal || memoryBlock === undefined) return;
		const surfacedIds = Array.isArray(event.data.surfaced_memory_ids)
			? event.data.surfaced_memory_ids.filter((id): id is string => typeof id === "string")
			: [];
		this.memorySurface = {
			goal,
			normalizedGoal: normalizeMemorySurfaceGoal(goal),
			generatedAt: new Date().toISOString(),
			memoryBlock,
			memoryIds: surfacedIds,
		};
		this.metadata.setMemorySurface(this.memorySurface);
		await this.metadata.save();
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
		const runSessionId = this._sessionId;
		// Capture metadata before awaits so terminal writes stay on the run
		// that started them even if /clear replaces this.metadata mid-run.
		const metadata = this.metadata;

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
		this.terminalSessionEndSeen = false;
		await persistRunningMetadata(this.metadata);
		const reusableMemorySurface = this.reusableMemorySurfaceForGoal(goal);

		let learnProcess: AgentFactoryResult["learnProcess"] = null;
		const stopLearnProcess = async (): Promise<void> => {
			const process = learnProcess;
			if (!process) return;
			learnProcess = null;
			await process.stopBackground();
		};
		try {
			const result = await this.factory({
				genomePath: this.genomePath,
				projectDataDir: this.projectDataDir,
				rootDir: this.rootDir,
				workDir: this.workDir,
				rootAgent: this.rootAgentName,
				events: this.bus,
				sessionId: runSessionId,
				initialHistory: this.history.length > 0 ? [...this.history] : undefined,
				initialMemorySurface: reusableMemorySurface,
				model: selectionSnapshotToModelOverride(this.selectionSnapshot),
				providerIdOverride: selectionSnapshotToProviderId(this.selectionSnapshot),
				resolverSettings: this.getResolverSettings?.(),
				memoryMaintenance: this.getMemoryMaintenanceSetting?.() ?? "auto",
				spawner: this.spawner,
				genome: this.genome,
				evalMode: this.evalMode,
				allowExec: this.allowExec,
				dataPlaneEnabled: this.dataPlaneEnabled,
				nonInteractive: this.nonInteractive,
				completedHandles: this.completedHandles,
				logger: this.logger,
				client: this.client,
			});

			this.configureObserverRegistry(result.genome ?? this.genome);
			this.agent = result.agent;
			learnProcess = result.learnProcess;
			this.logger?.info("session", "Agent created");
			if (result.compact) {
				this.compactFn = result.compact;
			}

			if (learnProcess) {
				learnProcess.startBackground();
			}

			let runResult: AgentRunResult;
			try {
				runResult = await result.agent.run(goal, signal);
			} catch (error) {
				await this.drainObserversAfterRun(signal);
				const agentEmittedTerminalSessionEnd = this.terminalSessionEndSeen;
				if (!signal.aborted && !agentEmittedTerminalSessionEnd) {
					await this.emitFailedSessionEndIfMissing();
				}
				if (shouldCollapseThrownRun(signal, agentEmittedTerminalSessionEnd)) {
					await stopLearnProcess();
					await this.collapseMemoryAfterRun(result, runSessionId);
				}
				throw error;
			}
			await this.drainObserversAfterRun(signal);
			if (shouldCollapseRun(runResult, signal)) {
				await stopLearnProcess();
				await this.collapseMemoryAfterRun(result, runSessionId);
			}
			this.logger?.info("session", "Agent run completed");
			return {
				sessionId: runSessionId,
				output: runResult.output,
				success: runResult.success,
				stumbles: runResult.stumbles,
				turns: runResult.turns,
				timedOut: runResult.timed_out,
			};
		} finally {
			await stopLearnProcess();
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

	private async drainObserversAfterRun(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		await this.observerRegistry?.drain();
		await this.controllerEventLogWriteChain;
	}

	private async emitFailedSessionEndIfMissing(): Promise<void> {
		if (this.terminalSessionEndSeen) return;
		this.emitAndPersistControllerEvent("session_end", this.rootAgentName ?? "root", 0, {
			session_id: this._sessionId,
			success: false,
			stumbles: 0,
			turns: 0,
			timed_out: false,
			output: "",
		});
		await this.controllerEventLogWriteChain;
	}

	private configureObserverRegistry(genome: Genome | undefined): void {
		if (!this.observerRegistry || this.observerRegistryConfigured) return;
		const observerConfigs = buildStaticObserverConfigs(genome, this.rootAgentName ?? "root");
		if (observerConfigs.length === 0) return;
		this.observerRegistry.configure(observerConfigs);
		this.observerRegistryConfigured = true;
	}

	private reusableMemorySurfaceForGoal(goal: string): SessionMemorySurfaceSnapshot | undefined {
		if (this.history.length === 0 || !this.memorySurface) return undefined;
		if (this.memorySurface.normalizedGoal !== normalizeMemorySurfaceGoal(goal)) return undefined;
		const generatedAt = Date.parse(this.memorySurface.generatedAt);
		if (!Number.isFinite(generatedAt)) return undefined;
		const ageMs = Date.now() - generatedAt;
		if (ageMs < 0 || ageMs > 60 * 60 * 1000) return undefined;
		return this.memorySurface;
	}

	private async collapseMemoryAfterRun(
		result: AgentFactoryResult,
		sessionId: string,
	): Promise<void> {
		if (!result.collapseMemory || this.evalMode) {
			this.bus.emitEvent("context_update", "session", 0, {
				memory_collapse: "skipped",
				session_id: sessionId,
			});
			return;
		}
		this.bus.emitEvent("context_update", "session", 0, {
			memory_collapse: "started",
			session_id: sessionId,
		});
		try {
			const collapse = await result.collapseMemory({
				sessionId,
				cwd: this.workDir,
			});
			const terminalState = collapse === "skipped" ? "skipped" : "completed";
			const compaction = await result.compactMemoryLogIfDue?.();
			if (compaction?.result && compaction.result.removedIds.length > 0) {
				this.bus.emitEvent("context_update", "session", 0, {
					memory_log_compaction: "completed",
					removed_memory_count: compaction.result.removedIds.length,
					session_id: sessionId,
				});
			}
			// After compaction (spec: ordering gives merge-sources a ~week review
			// window before the next compaction can delete them). The driver never
			// throws; this stays inside the surrounding try/catch anyway so a
			// future change here can't take down shutdown.
			await result.runMemoryMaintenance?.();
			this.bus.emitEvent("context_update", "session", 0, {
				memory_collapse: terminalState,
				session_id: sessionId,
			});
		} catch (err) {
			this.bus.emitEvent("context_update", "session", 0, {
				memory_collapse: "failed",
				session_id: sessionId,
			});
			this.emitAndPersistControllerEvent(
				"warning",
				"session",
				0,
				{
					message: `Memory collapse failed: ${err instanceof Error ? err.message : String(err)}`,
					session_id: sessionId,
				},
				sessionId,
			);
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
