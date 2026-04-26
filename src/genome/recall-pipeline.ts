import type { Memory } from "../kernel/types.ts";
import type { Genome } from "./genome.ts";
import { discoverEntityHubMemories } from "./hub-discovery.ts";
import { renderMemoryBlock } from "./render-memory-block.ts";

export interface SurfacedMemoryBlock {
	memories: Memory[];
	rendered: string;
	stats: {
		similarityCount: number;
		hubCount: number;
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
	options: { limit?: number } = {},
): Promise<SurfacedMemoryBlock> {
	const limit = options.limit ?? 5;
	const similarityPool = await genome.searchMemories(query, limit * 2, 0.3);
	const hubPool = discoverEntityHubMemories(allGenomeMemories(genome), query, limit * 2).map(
		(result) => result.memory,
	);
	const memories = mergeAndRankMemories(similarityPool, hubPool, limit);
	return {
		memories,
		rendered: renderMemoryBlock(memories),
		stats: {
			similarityCount: similarityPool.length,
			hubCount: hubPool.length,
			finalCount: memories.length,
		},
	};
}

export function mergeAndRankMemories(
	similarityPool: readonly Memory[],
	hubPool: readonly Memory[],
	limit: number,
): Memory[] {
	const ranked = new Map<string, RankedMemory>();
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
