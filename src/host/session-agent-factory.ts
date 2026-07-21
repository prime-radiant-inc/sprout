import { join } from "node:path";
import { AgentEventEmitter } from "../agents/events.ts";
import { createAgent } from "../agents/factory.ts";
import {
	createResolverSettings,
	type ResolvedModel,
	type ResolverSettings,
	resolveMemoryModel,
} from "../agents/model-resolver.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { AgentAddress } from "../bus/types.ts";
import { collapseSessionToMemory } from "../core/session-collapse.ts";
import type { Genome } from "../genome/genome.ts";
import { detectProjectFromCwd } from "../genome/projects.ts";
import type { ModelRef } from "../kernel/types.ts";
import { createLiveCanaryHarness } from "../learn/canary-live-harness.ts";
import type { SnapshotMutationGateBuilders } from "../learn/live-mutation-gate.ts";
import { LiveTaskExecutor } from "../learn/live-task-executor.ts";
import type { Client } from "../llm/client.ts";
import type { Message, ProviderModel } from "../llm/types.ts";
import { startBusInfrastructure } from "./cli-shared.ts";
import { compactHistory } from "./compaction.ts";
import type { SessionBus } from "./event-bus.ts";
import type { SessionMemorySurfaceSnapshot } from "./session-metadata.ts";
import { loadAllEventLogs } from "./session-state.ts";

/** Minimal agent interface used by the SessionController. */
export interface RunnableAgent {
	steer(text: string): void;
	receiveAgentMessage?(text: string, from: AgentAddress): void;
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
	resolverSettings: ResolverSettings;
	modelsByProvider: Map<string, ProviderModel[]>;
}

function createLiveMutationGateBuilders(rootDir: string): SnapshotMutationGateBuilders {
	return {
		buildExecutor: (_snapshotPath, workDir) =>
			new LiveTaskExecutor({ rootDir, workDir, startBusInfrastructure }),
		buildCanaryHarness: (executor, snapshot, workDir) =>
			createLiveCanaryHarness({ executor, snapshot, workDir }),
	};
}

export async function defaultFactory(options: AgentFactoryOptions): Promise<AgentFactoryResult> {
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
					caller: {
						agentName: ownerId,
						depth: 0,
						handleId: ownerId,
						agentId: ownerId,
					},
					workDir: options.workDir,
					agentId,
					evalMode: options.evalMode,
					allowExec: options.allowExec,
					dataPlaneEnabled: options.dataPlaneEnabled,
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
		allowExec: options.allowExec,
		dataPlaneEnabled: options.dataPlaneEnabled,
		nonInteractive: options.nonInteractive,
		logger: options.logger,
		client: options.client,
		mutationGateBuilders:
			process.env.SPROUT_MUTATION_GATE === "1" && options.rootDir
				? createLiveMutationGateBuilders(options.rootDir)
				: undefined,
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
						resolverSettings: collapseModels.resolverSettings,
						modelsByProvider: collapseModels.modelsByProvider,
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
	// Fail-fast preflight only: the relationship model re-resolves lazily
	// downstream (memory-incorporation) from resolverSettings, but a missing
	// config must still fail here, before the session runs.
	resolveRequiredCollapseModel("relationship", effectiveResolverSettings, modelMap);
	return {
		summaryModel: resolveRequiredCollapseModel("summary", effectiveResolverSettings, modelMap),
		extractionModel: resolveRequiredCollapseModel(
			"extraction",
			effectiveResolverSettings,
			modelMap,
		),
		resolverSettings: effectiveResolverSettings,
		modelsByProvider: modelMap,
	};
}

function resolveRequiredCollapseModel(
	purpose: "summary" | "extraction" | "relationship",
	resolverSettings: ResolverSettings,
	modelMap: Map<string, ProviderModel[]>,
): ResolvedModel {
	try {
		return resolveMemoryModel(purpose, resolverSettings, modelMap);
	} catch (error) {
		const envVar = collapseMemoryModelEnvVar(purpose);
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Memory collapse requires a configured memory '${purpose}' model before the session can run. ` +
				`Configure Settings > Models > Memory system models, set ${envVar}, or configure the fallback tier. ${detail}`,
		);
	}
}

function collapseMemoryModelEnvVar(purpose: "summary" | "extraction" | "relationship"): string {
	switch (purpose) {
		case "summary":
			return "SPROUT_MEMORY_SUMMARY_MODEL";
		case "extraction":
			return "SPROUT_MEMORY_EXTRACTION_MODEL";
		case "relationship":
			return "SPROUT_MEMORY_RELATIONSHIP_MODEL";
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
