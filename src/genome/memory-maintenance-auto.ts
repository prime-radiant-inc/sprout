import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type ResolvedModel,
	type ResolverSettings,
	resolveMemoryModel,
	resolveModel,
} from "../agents/model-resolver.ts";
import type { Memory } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import type { ProviderModel } from "../llm/types.ts";
import { buildConsolidatedMemory, requestConsolidationDecision } from "./consolidation.ts";
import { requestEntityGcDecision } from "./entity-gc.ts";
import type { Genome } from "./genome.ts";
import {
	applyMemoryMaintenanceDecisions,
	discoverMemoryMaintenancePlan,
	type MaintenanceConsolidationDecision,
	type MaintenanceEntityGcDecision,
	type MemoryMaintenanceDecisionFile,
} from "./maintenance.ts";
import { attachReadyMemoryEmbedding } from "./memory-embedding.ts";
import { isProtectedManualMemory } from "./memory-write-policy.ts";

export interface MemoryMaintenanceRunCounts {
	merged: number;
	rejected: number;
	skipped: number;
	entityGcMerged: number;
	entityGcRejected: number;
	entityGcSkipped: number;
}

export type MemoryMaintenanceRunResult =
	| { due: false }
	| { failed: string }
	| MemoryMaintenanceRunCounts;

export interface MemoryMaintenanceLogger {
	warn(message: string): void;
}

export interface RunMemoryMaintenanceOptions {
	client: Client;
	resolverSettings: ResolverSettings;
	modelsByProvider: Map<string, ProviderModel[]>;
	now?: number;
	/** Top-N cap applied to consolidation clusters AND entity-GC groups. */
	limit?: number;
	statePath?: string;
	logger?: MemoryMaintenanceLogger;
	/** Skip the 24h throttle window. Used by `sprout --genome maintain --auto`,
	 *  which is a deliberate one-off invocation, not a background trigger. */
	ignoreThrottle?: boolean;
}

interface MemoryMaintenanceState {
	lastCheckedAt?: number;
	zeroMergeStreak?: number;
	lastRun?: MemoryMaintenanceRunCounts | { failed: string };
}

const MEMORY_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_ITEM_LIMIT = 8;
const ZERO_MERGE_STREAK_WARNING_THRESHOLD = 3;
/**
 * Source stamped on machine-consolidated memories; excluding it from the
 * discovery pool caps consolidation at one generation (no merges of merges).
 */
const CONSOLIDATED_MEMORY_SOURCE = "memory-consolidation";

/**
 * Unattended memory maintenance: throttled to once per 24h, LLM decisions
 * replace the human decision file, protected and consolidation-generated
 * memories are pre-filtered out of discovery, and per-item failures degrade
 * to skips. Never throws — failures warn through the logger and report
 * `{ failed }`.
 */
export async function runMemoryMaintenanceIfDue(
	genome: Genome,
	options: RunMemoryMaintenanceOptions,
): Promise<MemoryMaintenanceRunResult> {
	try {
		const now = options.now ?? Date.now();
		const statePath =
			options.statePath ?? join(genome.path, ".cache", "memory-maintenance-state.json");
		const state = await readMaintenanceState(statePath);
		if (
			!options.ignoreThrottle &&
			state.lastCheckedAt !== undefined &&
			now - state.lastCheckedAt < MEMORY_MAINTENANCE_INTERVAL_MS
		) {
			return { due: false };
		}
		// Stamp BEFORE deciding: a failed run waits out the throttle window
		// instead of retrying every shutdown (cost bounding beats retry
		// eagerness).
		state.lastCheckedAt = now;
		await writeMaintenanceState(statePath, state);
		return await runMaintenance(genome, options, state, statePath, now);
	} catch (error) {
		const failed = errorMessage(error);
		options.logger?.warn(`memory maintenance failed: ${failed}`);
		return { failed };
	}
}

async function runMaintenance(
	genome: Genome,
	options: RunMemoryMaintenanceOptions,
	state: MemoryMaintenanceState,
	statePath: string,
	now: number,
): Promise<MemoryMaintenanceRunResult> {
	const logger = options.logger;
	const models = preflightMaintenanceModels(options);
	if (!models) {
		logger?.warn("memory maintenance skipped: no models resolvable for consolidation or entity GC");
		state.lastRun = { failed: "no models" };
		await writeMaintenanceState(statePath, state);
		return { failed: "no models" };
	}

	const memoryPool = genome.memories
		.all()
		.filter(
			(memory) => !isProtectedManualMemory(memory) && memory.source !== CONSOLIDATED_MEMORY_SOURCE,
		);
	const plan = discoverMemoryMaintenancePlan(genome, {
		limit: options.limit ?? DEFAULT_MAINTENANCE_ITEM_LIMIT,
		memoryPool,
	});

	// Three-way semantics: merge and reject decisions are recorded; a thrown
	// or unparseable decision is SKIPPED — absent from the decision file, so
	// nothing is mutated and the item stays discoverable next run.
	const consolidations: MaintenanceConsolidationDecision[] = [];
	let skipped = 0;
	if (plan.consolidationClusters.length > 0) {
		const prompt = await genome.loadMemoryConsolidationPrompt();
		for (const cluster of plan.consolidationClusters) {
			try {
				const decision = await requestConsolidationDecision({
					cluster,
					prompt,
					client: options.client,
					model: models.consolidation.model,
					provider: models.consolidation.provider,
				});
				consolidations.push({ cluster_id: cluster.id, ...decision });
			} catch (error) {
				skipped++;
				logger?.warn(
					`memory maintenance: consolidation decision for '${cluster.id}' skipped: ${errorMessage(error)}`,
				);
			}
		}
	}

	const entityGcDecisions: MaintenanceEntityGcDecision[] = [];
	let entityGcSkipped = 0;
	if (plan.entityGcGroups.length > 0) {
		const prompt = await genome.loadMemoryEntityGcPrompt();
		for (const group of plan.entityGcGroups) {
			try {
				const decision = await requestEntityGcDecision({
					group,
					prompt,
					client: options.client,
					model: models.entityGc.model,
					provider: models.entityGc.provider,
				});
				entityGcDecisions.push({ group_id: group.id, ...decision });
			} catch (error) {
				entityGcSkipped++;
				logger?.warn(
					`memory maintenance: entity GC decision for '${group.id}' skipped: ${errorMessage(error)}`,
				);
			}
		}
	}

	// Pre-embed every accepted merge OUTSIDE the write lock (A-F3): apply must
	// not make network embedding calls while holding the memory write lock.
	// A failed pre-embed degrades that merge to a skip.
	const clusterById = new Map(plan.consolidationClusters.map((cluster) => [cluster.id, cluster]));
	const preEmbeddedConsolidations = new Map<string, Memory>();
	const decidedConsolidations: MaintenanceConsolidationDecision[] = [];
	for (const decision of consolidations) {
		if (decision.action !== "merge" || !decision.memory) {
			decidedConsolidations.push(decision);
			continue;
		}
		const cluster = clusterById.get(decision.cluster_id)!;
		try {
			const built = buildConsolidatedMemory(cluster.memories, decision.memory, {
				now,
				reasoning: decision.reasoning,
			});
			const embedded = await attachReadyMemoryEmbedding(
				built,
				await genome.memoryEmbeddingProvider(),
				{ now },
			);
			preEmbeddedConsolidations.set(decision.cluster_id, embedded);
			decidedConsolidations.push(decision);
		} catch (error) {
			skipped++;
			logger?.warn(
				`memory maintenance: pre-embedding for '${decision.cluster_id}' skipped: ${errorMessage(error)}`,
			);
		}
	}

	const counts: MemoryMaintenanceRunCounts = {
		merged: 0,
		rejected: 0,
		skipped,
		entityGcMerged: 0,
		entityGcRejected: 0,
		entityGcSkipped,
	};
	if (decidedConsolidations.length > 0 || entityGcDecisions.length > 0) {
		const decisions: MemoryMaintenanceDecisionFile = {
			...(decidedConsolidations.length > 0 ? { consolidations: decidedConsolidations } : {}),
			...(entityGcDecisions.length > 0 ? { entity_gc: entityGcDecisions } : {}),
		};
		const applied = await applyMemoryMaintenanceDecisions(genome, plan, decisions, {
			preEmbeddedConsolidations,
		});
		counts.merged = applied.consolidation.merged;
		counts.rejected = applied.consolidation.rejected;
		counts.entityGcMerged = applied.entity_gc.merged;
		counts.entityGcRejected = applied.entity_gc.rejected;
	}

	if (counts.merged > 0) {
		state.zeroMergeStreak = 0;
	} else if (decidedConsolidations.length > 0) {
		state.zeroMergeStreak = (state.zeroMergeStreak ?? 0) + 1;
		if (state.zeroMergeStreak >= ZERO_MERGE_STREAK_WARNING_THRESHOLD) {
			logger?.warn(
				`memory maintenance: ${state.zeroMergeStreak} consecutive runs decided consolidation clusters without a single merge`,
			);
		}
	}
	state.lastRun = counts;
	await writeMaintenanceState(statePath, state);
	return counts;
}

function preflightMaintenanceModels(
	options: RunMemoryMaintenanceOptions,
): { consolidation: ResolvedModel; entityGc: ResolvedModel } | undefined {
	const consolidation = resolveMaintenanceModel("consolidation", options);
	const entityGc = resolveMaintenanceModel("entityGc", options);
	if (!consolidation || !entityGc) return undefined;
	return { consolidation, entityGc };
}

function resolveMaintenanceModel(
	purpose: "consolidation" | "entityGc",
	options: RunMemoryMaintenanceOptions,
): ResolvedModel | undefined {
	try {
		return resolveMemoryModel(purpose, options.resolverSettings, options.modelsByProvider);
	} catch {
		// C8 fallback: a settings gap degrades to the global best model below.
	}
	try {
		return resolveModel("best", options.resolverSettings, options.modelsByProvider);
	} catch {
		return undefined;
	}
}

async function readMaintenanceState(statePath: string): Promise<MemoryMaintenanceState> {
	try {
		const raw = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
		return {
			...(typeof raw.lastCheckedAt === "number" && Number.isFinite(raw.lastCheckedAt)
				? { lastCheckedAt: raw.lastCheckedAt }
				: {}),
			...(typeof raw.zeroMergeStreak === "number" && Number.isFinite(raw.zeroMergeStreak)
				? { zeroMergeStreak: raw.zeroMergeStreak }
				: {}),
		};
	} catch {
		// A missing or corrupt state file must not brick maintenance; the run
		// proceeds and rewrites it.
		return {};
	}
}

async function writeMaintenanceState(
	statePath: string,
	state: MemoryMaintenanceState,
): Promise<void> {
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
