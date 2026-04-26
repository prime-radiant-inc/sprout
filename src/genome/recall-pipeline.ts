import type { Memory } from "../kernel/types.ts";
import type { Genome } from "./genome.ts";
import { discoverEntityHubMemories } from "./hub-discovery.ts";
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
	const limit = options.limit ?? 5;
	const allMemories = allGenomeMemories(genome);
	const recallQuery = options.subcorticalExpansion
		? expandedRecallQuery(query, options.subcorticalExpansion)
		: query;
	const entityHints = options.subcorticalExpansion?.entities.map((entity) => entity.name) ?? [];
	const pinnedPool = pinnedMemories(allMemories, [
		...(options.pinnedMemoryIds ?? []),
		...(options.subcorticalExpansion?.pinned_memory_ids ?? []),
	]);
	const similarityPool = await genome.searchMemories(recallQuery, limit * 2, 0.3);
	const hubPool = discoverEntityHubMemories(allMemories, recallQuery, limit * 2, entityHints).map(
		(result) => result.memory,
	);
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
	const ranked = new Map<string, RankedMemory>();
	for (const [index, memory] of (options.pinnedPool ?? []).entries()) {
		addRanked(ranked, memory, 2 / (index + 1));
	}
	for (const [index, memory] of similarityPool.entries()) {
		addRanked(ranked, memory, 1 / (index + 1));
	}
	for (const [index, memory] of hubPool.entries()) {
		addRanked(ranked, memory, 0.8 / (index + 1));
	}
	return [...ranked.values()]
		.filter(({ memory }) => !memory.archived_at)
		.map(({ memory, score }) => ({
			memory,
			score: adjustedScore(memory, score),
		}))
		.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
		.slice(0, Math.max(limit, 0))
		.map(({ memory }) => memory);
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

function allGenomeMemories(genome: Genome): Memory[] {
	const maybeStore = (genome as unknown as { memories?: { all?: () => Memory[] } }).memories;
	return typeof maybeStore?.all === "function" ? maybeStore.all() : [];
}

function pinnedMemories(memories: readonly Memory[], ids: readonly string[]): Memory[] {
	if (ids.length === 0) return [];
	const normalized = new Set(ids.map((id) => id.toLowerCase()));
	return memories.filter((memory) => {
		if (memory.archived_at) return false;
		return (
			normalized.has(memory.id.toLowerCase()) ||
			normalized.has((memory.short_id ?? "").toLowerCase())
		);
	});
}
