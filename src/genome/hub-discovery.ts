import type { Memory } from "../kernel/types.ts";

export interface HubMemoryResult {
	memory: Memory;
	score: number;
	matchedEntities: string[];
}

export function discoverEntityHubMemories(
	memories: readonly Memory[],
	query: string,
	limit = 10,
): HubMemoryResult[] {
	const normalizedQuery = query.toLowerCase();
	if (!normalizedQuery.trim()) return [];

	return memories
		.flatMap((memory) => {
			if (memory.archived_at) return [];
			const matchedEntities = (memory.entity_links ?? [])
				.filter((entity) => normalizedQuery.includes(entity.name.toLowerCase()))
				.map((entity) => entity.name);
			if (matchedEntities.length === 0) return [];
			return [
				{
					memory,
					score: matchedEntities.length / Math.max(memory.entity_links?.length ?? 1, 1),
					matchedEntities,
				},
			];
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				(b.memory.effective_importance ?? b.memory.importance_score ?? b.memory.confidence) -
					(a.memory.effective_importance ?? a.memory.importance_score ?? a.memory.confidence) ||
				a.memory.id.localeCompare(b.memory.id),
		)
		.slice(0, limit);
}
