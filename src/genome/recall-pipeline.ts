import type { Memory } from "../kernel/types.ts";
import type { Genome } from "./genome.ts";
import { discoverEntityHubMemories } from "./hub-discovery.ts";
import { isActiveMemoryForRecall } from "./memory-lifecycle.ts";
import { renderMemoryBlock } from "./render-memory-block.ts";
import { expandedRecallQuery, type SubcorticalRecallExpansion } from "./subcortical.ts";

export interface SurfacedMemoryBlock {
	memories: Memory[];
	rendered: string;
	stats: {
		similarityCount: number;
		hubCount: number;
		pinnedCount: number;
		finalCount: number;
	};
}

interface RankedMemory {
	memory: Memory;
	score: number;
}

export async function surfaceMemories(
	genome: Genome,
	query: string,
	options: {
		limit?: number;
		subcorticalExpansion?: SubcorticalRecallExpansion;
		pinnedMemoryIds?: readonly string[];
	} = {},
): Promise<SurfacedMemoryBlock> {
	const limit = Math.max(options.limit ?? 5, 0);
	if (limit === 0) {
		return {
			memories: [],
			rendered: renderMemoryBlock([]),
			stats: {
				similarityCount: 0,
				hubCount: 0,
				pinnedCount: 0,
				finalCount: 0,
			},
		};
	}
	const allMemories = allGenomeMemories(genome);
	const activeMemories = allMemories.filter(isActiveMemoryForRecall);
	const recallQuery = options.subcorticalExpansion
		? expandedRecallQuery(query, options.subcorticalExpansion)
		: query;
	const entityHints = options.subcorticalExpansion?.entities.map((entity) => entity.name) ?? [];
	const pinnedPool = pinnedMemories(activeMemories, [
		...(options.pinnedMemoryIds ?? []),
		...(options.subcorticalExpansion?.pinned_memory_ids ?? []),
	]);
	const similarityPool = await genome.searchMemories(recallQuery, limit * 2, 0.3);
	const hubPool = discoverEntityHubMemories(
		activeMemories,
		recallQuery,
		limit * 2,
		entityHints,
	).map((result) => result.memory);
	const memories = mergeAndRankMemories(similarityPool, hubPool, limit, { pinnedPool });
	return {
		memories,
		rendered: renderMemoryBlock(memories),
		stats: {
			similarityCount: similarityPool.length,
			hubCount: hubPool.length,
			pinnedCount: pinnedPool.length,
			finalCount: memories.length,
		},
	};
}

export function mergeAndRankMemories(
	similarityPool: readonly Memory[],
	hubPool: readonly Memory[],
	limit: number,
	options: { pinnedPool?: readonly Memory[] } = {},
): Memory[] {
	const safeLimit = Math.max(limit, 0);
	if (safeLimit === 0) return [];
	const reservedPinned = uniqueActivePinned(options.pinnedPool ?? []).slice(0, safeLimit);
	const reservedPinnedIds = new Set(reservedPinned.map((memory) => memory.id));
	const ranked = new Map<string, RankedMemory>();
	for (const [index, memory] of similarityPool.entries()) {
		addRanked(ranked, memory, 1 / (index + 1));
	}
	for (const [index, memory] of hubPool.entries()) {
		addRanked(ranked, memory, 0.8 / (index + 1));
	}
	const rankedNonPinned = [...ranked.values()]
		.filter(({ memory }) => isActiveMemoryForRecall(memory) && !reservedPinnedIds.has(memory.id))
		.map(({ memory, score }) => ({
			memory,
			score: adjustedScore(memory, score),
		}))
		.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
		.map(({ memory }) => memory);
	return [...reservedPinned, ...rankedNonPinned.slice(0, safeLimit - reservedPinned.length)];
}

function addRanked(ranked: Map<string, RankedMemory>, memory: Memory, score: number): void {
	const existing = ranked.get(memory.id);
	if (existing) {
		existing.score += score;
		return;
	}
	ranked.set(memory.id, { memory, score });
}

function adjustedScore(memory: Memory, retrievalScore: number): number {
	let score =
		retrievalScore + (memory.effective_importance ?? memory.importance_score ?? memory.confidence);
	if ((memory.access_count ?? memory.use_count) === 0) {
		score += 0.05;
	}
	if (memory.superseded_by || hasSupersedesInbound(memory)) {
		score *= 0.35;
	}
	return score;
}

function hasSupersedesInbound(memory: Memory): boolean {
	return (memory.inbound_links ?? []).some((link) => link.type === "supersedes");
}

function uniqueActivePinned(memories: readonly Memory[]): Memory[] {
	const seen = new Set<string>();
	const pinned: Memory[] = [];
	for (const memory of memories) {
		if (!isActiveMemoryForRecall(memory) || seen.has(memory.id)) continue;
		seen.add(memory.id);
		pinned.push(memory);
	}
	return pinned;
}

function allGenomeMemories(genome: Genome): Memory[] {
	const maybeStore = (genome as unknown as { memories?: { all?: () => Memory[] } }).memories;
	return typeof maybeStore?.all === "function" ? maybeStore.all() : [];
}

function pinnedMemories(memories: readonly Memory[], ids: readonly string[]): Memory[] {
	if (ids.length === 0) return [];
	const normalized = new Set(ids.map((id) => id.toLowerCase()));
	return memories.filter((memory) => {
		if (!isActiveMemoryForRecall(memory)) return false;
		return (
			normalized.has(memory.id.toLowerCase()) ||
			normalized.has((memory.short_id ?? "").toLowerCase())
		);
	});
}
