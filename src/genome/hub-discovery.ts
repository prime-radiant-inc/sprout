import type { Memory } from "../kernel/types.ts";
import { isActiveMemoryForRecall } from "./memory-lifecycle.ts";

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
	const normalizedQuery = normalizeForEntityMatch(query);
	const normalizedHints = new Set(
		entityHints.map(normalizeForEntityMatch).filter((hint) => hint.length > 0),
	);
	if (!normalizedQuery.trim() && normalizedHints.size === 0) return [];

	return memories
		.flatMap((memory) => {
			if (!isActiveMemoryForRecall(memory)) return [];
			const matchedEntities = (memory.entity_links ?? [])
				.filter((entity) => {
					const name = normalizeForEntityMatch(entity.name);
					return normalizedHints.has(name) || entityNameMatchesQuery(name, normalizedQuery);
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

function entityNameMatchesQuery(name: string, normalizedQuery: string): boolean {
	if (!name || !normalizedQuery) return false;
	const phrasePattern = new RegExp(`(^| )${escapeRegExp(name)}( |$)`);
	return phrasePattern.test(normalizedQuery);
}

function normalizeForEntityMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
