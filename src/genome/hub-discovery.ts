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
	entityHints: readonly string[] = [],
): HubMemoryResult[] {
	const normalizedQuery = query.toLowerCase();
	const normalizedHints = new Set(
		entityHints.map((hint) => hint.toLowerCase().trim()).filter((hint) => hint.length > 0),
	);
	if (!normalizedQuery.trim() && normalizedHints.size === 0) return [];

	return memories
		.flatMap((memory) => {
			if (memory.archived_at) return [];
			const matchedEntities = (memory.entity_links ?? [])
				.filter((entity) => {
					const name = entity.name.toLowerCase();
					return normalizedQuery.includes(name) || normalizedHints.has(name);
				})
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
