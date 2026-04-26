import type { Memory, RecallResult, RoutingRule } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import type { Genome } from "./genome.ts";
import { surfaceMemories } from "./recall-pipeline.ts";
import { renderMemoryBlock } from "./render-memory-block.ts";
import { runSubcorticalPrepass, type SubcorticalRecallExpansion } from "./subcortical.ts";

export interface RecallOptions {
	limit?: number;
	pinnedMemoryIds?: readonly string[];
	additionalContext?: string;
	subcortical?: {
		prompt: string;
		client: Client;
		model: string;
		provider: string;
		maxTokens?: number;
	};
}

/**
 * Search the genome for context relevant to the query.
 * Deterministic and cheap — never an LLM call.
 *
 * Default strategy (spec Section 5.3):
 * 1. If < 20 agents, return all. Else return all (placeholder for embedding search).
 * 2. Surface memories through the local hybrid index plus entity-hub merge.
 * 3. Match routing rules by keyword.
 */
export async function recall(
	genome: Genome,
	query: string,
	options: RecallOptions = {},
): Promise<RecallResult> {
	// 1. Agents: return all (placeholder until embeddings)
	const agents = genome.allAgents();

	const subcorticalExpansion: SubcorticalRecallExpansion | undefined = options.subcortical
		? await runSubcorticalPrepass({
				query,
				additionalContext: options.additionalContext,
				...options.subcortical,
			})
		: undefined;

	// 2. Surface memories
	const surface = await surfaceMemories(genome, query, {
		limit: options.limit ?? 5,
		subcorticalExpansion,
		pinnedMemoryIds: options.pinnedMemoryIds,
	});
	const memories = surface.memories;

	// 3. Match routing rules
	const routing_hints = genome.matchRoutingRules(query);

	// Mark used memories (spec: confidence refreshed on use)
	if (memories.length > 0) {
		await genome.markMemoriesUsed(memories.map((m) => m.id));
	}

	return {
		agents,
		memories,
		routing_hints,
		memory_block: surface.rendered,
		surfaced_memory_ids: memories.map((memory) => memory.id),
	};
}

/**
 * Render memories as an XML block for injection into the system prompt.
 * Spec Section 5.4: <memories>...</memories>
 */
export function renderMemories(memories: Memory[]): string {
	return renderMemoryBlock(memories);
}

/**
 * Render routing hints as an XML block for injection into the system prompt.
 * Spec Section 5.4: <routing_hints>...</routing_hints>
 */
export function renderRoutingHints(hints: RoutingRule[]): string {
	if (hints.length === 0) return "";
	const items = hints
		.map((r) => `- When: ${r.condition} → prefer ${r.preference} (strength: ${r.strength})`)
		.join("\n");
	return `\n<routing_hints>\n${items}\n</routing_hints>`;
}
