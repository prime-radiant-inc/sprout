import { join } from "node:path";
import { AgentEventEmitter } from "../agents/events.ts";
import { createAgent } from "../agents/factory.ts";
import {
	createResolverSettings,
	type ResolvedModel,
	type ResolverSettings,
	resolveMemoryModel,
} from "../agents/model-resolver.ts";
import type { ObserverAttachmentConfig } from "../agents/observers.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import { collapseSessionToMemory } from "../core/session-collapse.ts";
import type { Genome } from "../genome/genome.ts";
import { detectProjectFromCwd } from "../genome/projects.ts";
import type { AgentModelPurpose, AgentSpec, Command, ModelRef, SessionEvent } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import type { Message, ProviderModel } from "../llm/types.ts";
import { parseAgentModelInput, type SessionSelectionRequest } from "../shared/session-selection.ts";
import { ulid } from "../util/ulid.ts";
import { compactHistory } from "./compaction.ts";
import type { SessionBus } from "./event-bus.ts";
import { ObserverRegistry } from "./observer-registry.ts";
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
	loadAllEventLogs,
} from "./session-state.ts";

/** Minimal agent interface used by the SessionController. */
interface RunnableAgent {
	steer(text: string): void;
	receiveAgentMessage?(text: string, from: { agent_name: string; depth: number }): void;
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
const DEFAULT_DELEGATE_OBSERVER_MAX_EVENTS = 12;
const DEFAULT_DELEGATE_OBSERVER_MAX_CHARS = 3000;

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
		const handleId = index === 0 ? `observer-${config.agent}` : `observer-${config.agent}-${index + 1}`;
		return {
			agentName: config.agent,
			target: config.target,
			events: config.events,
			trigger: config.trigger,
			maxEvents: config.delivery?.max_events ?? DEFAULT_OBSERVER_MAX_EVENTS,
			maxChars: config.delivery?.max_chars ?? DEFAULT_OBSERVER_MAX_CHARS,
			handleId,
			agentId: handleId,
			modelPurpose: observerModelPurpose(observerSpec),
			description:
				config.target === "root"
					? `observes ${rootAgentName} turns`
					: "observes session events",
		};
	});

	const delegateObserverConfigs = (rootSpec.observe_delegates ?? []).map((config, index) => {
		const observerSpec = genome?.getAgent(config.agent);
		if (!observerSpec) {
			throw new Error(
				`Delegate observer agent '${config.agent}' configured by '${rootAgentName}' was not found`,
			);
		}
		const handleId =
			index === 0
				? `observer-${config.agent}-delegates`
				: `observer-${config.agent}-delegates-${index + 1}`;
		return {
			agentName: config.agent,
			target: "caller_delegates" as const,
			events: config.events,
			trigger: { every: 1, event: "act_end" as const },
			maxEvents: config.delivery?.max_events ?? DEFAULT_DELEGATE_OBSERVER_MAX_EVENTS,
			maxChars: config.delivery?.max_chars ?? DEFAULT_DELEGATE_OBSERVER_MAX_CHARS,
			handleId,
			agentId: handleId,
			modelPurpose: observerModelPurpose(observerSpec),
			description: `observes ${rootAgentName} delegate completions`,
			callerDepth: 0,
		};
	});

	return [...observerConfigs, ...delegateObserverConfigs];
}

function observerModelPurpose(spec: AgentSpec): AgentModelPurpose | undefined {
	const parsed = parseAgentModelInput(spec.model);
	return parsed.kind === "agent_purpose" ? parsed.purpose : undefined;
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
	/** Cached root memory surface for resume when the goal is unchanged. */
	initialMemorySurface?: SessionMemorySurfaceSnapshot;
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
	/** Pre-configured LLM client (e.g. with middleware). */
	client?: import("../llm/client.ts").Client;
}

/** Result returned by the agent factory. */
export interface AgentFactoryResult {
	agent: RunnableAgent;
	learnProcess: { startBackground(): void; stopBackground(): Promise<void> } | null;
	/** Runtime genome after factory initialization/loading. */
	genome?: Genome;
	/** Compact conversation history via LLM summarization. Available after agent creation. */
	compact?: (
		history: Message[],
		logPath: string,
	) => Promise<{ summary: string; beforeCount: number; afterCount: number }>;
	/** Collapse the completed root session into long-term memory. */
	collapseMemory?: (input: { sessionId: string; cwd: string }) => Promise<unknown>;
	/** Opportunistically compact the memory JSONL source if the maintenance cadence is due. */
	compactMemoryLogIfDue?: () => Promise<{
		due: boolean;
		result?: { removedIds: string[] };
	}>;
}

/** Factory function that creates an agent. Injectable for testing. */
export type AgentFactory = (options: AgentFactoryOptions) => Promise<AgentFactoryResult>;

interface CollapseMemoryModels {
	summaryModel: ResolvedModel;
	extractionModel: ResolvedModel;
}

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
			for (const { handleId, result, ownerId, agentName, agentId } of options.completedHandles) {
				options.spawner.registerCompletedHandle(handleId, result, ownerId, {
					agentName,
					genomePath: options.genomePath,
					caller: { agent_name: ownerId, depth: 0 },
					workDir: options.workDir,
					agentId,
					evalMode: options.evalMode,
					rootDir: options.rootDir,
					projectDataDir: options.projectDataDir,
					providerIdOverride: options.providerIdOverride,
					resolverSettings: options.resolverSettings,
				});
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
		initialMemorySurface: options.initialMemorySurface,
		model: options.model,
		providerIdOverride: options.providerIdOverride,
		resolverSettings: options.resolverSettings,
		spawner: options.spawner,
		genome: options.genome,
		evalMode: options.evalMode,
		nonInteractive: options.nonInteractive,
		logger: options.logger,
		client: options.client,
	});
	const collapseModels =
		options.evalMode || isVcrReplayClient(result.client)
			? undefined
			: await resolveCollapseMemoryModels(result.client, options.resolverSettings);

	return {
		agent: result.agent,
		learnProcess: result.learnProcess,
		genome: result.genome,
		compact: (history, logPath) =>
			compactHistory({
				history,
				client: result.client,
				model: result.model,
				provider: result.provider,
				logPath,
			}),
		collapseMemory: collapseModels
			? async ({ sessionId, cwd }) => {
					const project = await detectProjectFromCwd({ cwd });
					const projectActivityChanged = await result.genome.recordProjectActivity(project);
					if (projectActivityChanged) {
						await result.genome.saveProjectActivityMutation(
							`genome: record project activity '${project.id}'`,
						);
					}
					const logBasePath = join(options.projectDataDir ?? options.genomePath, "logs", sessionId);
					const events = await loadAllEventLogs(`${logBasePath}.jsonl`, logBasePath);
					const collapse = await collapseSessionToMemory({
						events,
						genome: result.genome,
						client: result.client,
						summaryModel: collapseModels.summaryModel,
						extractionModel: collapseModels.extractionModel,
						sessionId,
						cwd,
						project,
					});
					if (collapse !== "skipped" || projectActivityChanged) {
						await result.genome.recomputeMemoryScores();
					}
					return collapse;
				}
			: undefined,
		compactMemoryLogIfDue: () => result.genome.compactMemoryLogIfDue(),
	};
}

export async function resolveCollapseMemoryModels(
	client: Pick<Client, "listModelsByProvider">,
	resolverSettings?: ResolverSettings,
): Promise<CollapseMemoryModels> {
	const modelMap = await client.listModelsByProvider();
	const effectiveResolverSettings =
		resolverSettings ??
		createResolverSettings(
			[...modelMap.keys()].map((providerId) => ({
				id: providerId,
				enabled: true,
			})),
		);
	return {
		summaryModel: resolveRequiredCollapseModel("summary", effectiveResolverSettings, modelMap),
		extractionModel: resolveRequiredCollapseModel(
			"extraction",
			effectiveResolverSettings,
			modelMap,
		),
	};
}

function resolveRequiredCollapseModel(
	purpose: "summary" | "extraction",
	resolverSettings: ResolverSettings,
	modelMap: Map<string, ProviderModel[]>,
): ResolvedModel {
	try {
		return resolveMemoryModel(purpose, resolverSettings, modelMap);
	} catch (error) {
		const envVar =
			purpose === "summary" ? "SPROUT_MEMORY_SUMMARY_MODEL" : "SPROUT_MEMORY_EXTRACTION_MODEL";
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Memory collapse requires a configured memory '${purpose}' model before the session can run. ` +
				`Configure Settings > Memory models or set ${envVar}. ${detail}`,
		);
	}
}

function isVcrReplayClient(client: unknown): boolean {
	return (
		typeof client === "object" &&
		client !== null &&
		"__sproutVcrMode" in client &&
		(client as { __sproutVcrMode?: unknown }).__sproutVcrMode === "replay"
	);
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
	private readonly workDir: string;
	private readonly rootDir?: string;
	private readonly rootAgentName?: string;
	private readonly factory: AgentFactory;
	private readonly spawner?: AgentSpawner;
	private readonly genome?: import("../genome/genome.ts").Genome;
	private readonly evalMode: boolean;
	private readonly nonInteractive: boolean;
	private readonly completedHandles?: SessionControllerOptions["completedHandles"];
	private readonly logger?: import("./logger.ts").Logger;
	private readonly client?: import("../llm/client.ts").Client;
	private readonly resolveSelectionFn: (
		selection: SessionSelectionRequest,
	) => SessionSelectionSnapshot;
	private readonly getResolverSettings?: () => ResolverSettings | undefined;
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
		this.nonInteractive = options.nonInteractive === true;
		this.completedHandles = options.completedHandles;
		this.logger = options.logger;
		this.client = options.client;
		this.resolveSelectionFn = options.resolveSelection ?? defaultResolveSessionSelectionRequest;
		this.getResolverSettings = options.getResolverSettings;
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
				spawner: this.spawner,
				genomePath: this.genomePath,
				workDir: this.workDir,
				projectDataDir: this.projectDataDir,
				rootDir: this.rootDir,
				evalMode: this.evalMode,
				configs: observerConfigs,
				getResolverSettings: this.getResolverSettings,
				emitEvent: (kind, agentId, depth, data) => {
					this.bus.emitEvent(kind, agentId, depth, data);
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
					this.agent?.receiveAgentMessage?.(message.message, message.caller);
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
					this.bus.emitEvent("context_update", "session", 0, data);
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
		// Capture metadata before the try block so the finally writes to the
		// correct session even if /clear replaces this.metadata mid-run.
		const metadata = this.metadata;

		try {
			const result = await this.factory({
				genomePath: this.genomePath,
				projectDataDir: this.projectDataDir,
				rootDir: this.rootDir,
				workDir: this.workDir,
				rootAgent: this.rootAgentName,
				events: this.bus,
				sessionId: this._sessionId,
				initialHistory: this.history.length > 0 ? [...this.history] : undefined,
				initialMemorySurface: reusableMemorySurface,
				model: selectionSnapshotToModelOverride(this.selectionSnapshot),
				providerIdOverride: selectionSnapshotToProviderId(this.selectionSnapshot),
				resolverSettings: this.getResolverSettings?.(),
				spawner: this.spawner,
				genome: this.genome,
				evalMode: this.evalMode,
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
				if (shouldCollapseThrownRun(signal, this.terminalSessionEndSeen)) {
					await stopLearnProcess();
					await this.collapseMemoryAfterRun(result);
				}
				throw error;
			}
			if (shouldCollapseRun(runResult, signal)) {
				await stopLearnProcess();
				await this.collapseMemoryAfterRun(result);
			}
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

	private async collapseMemoryAfterRun(result: AgentFactoryResult): Promise<void> {
		if (!result.collapseMemory || this.evalMode) return;
		try {
			const collapse = await result.collapseMemory({
				sessionId: this._sessionId,
				cwd: this.workDir,
			});
			if (collapse !== "skipped") {
				this.bus.emitEvent("context_update", "session", 0, {
					memory_collapse: "completed",
				});
			}
			const compaction = await result.compactMemoryLogIfDue?.();
			if (compaction?.result && compaction.result.removedIds.length > 0) {
				this.bus.emitEvent("context_update", "session", 0, {
					memory_log_compaction: "completed",
					removed_memory_count: compaction.result.removedIds.length,
				});
			}
		} catch (err) {
			this.bus.emitEvent("warning", "session", 0, {
				message: `Memory collapse failed: ${err instanceof Error ? err.message : String(err)}`,
			});
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
