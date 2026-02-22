import type { Memory, RecallResult, RoutingRule } from "../kernel/types.ts";
import type { Genome } from "./genome.ts";

/**
 * Search the genome for context relevant to the query.
 * Deterministic and cheap — never an LLM call.
 *
 * Default strategy (spec Section 5.3):
 * 1. If < 20 agents, return all. Else return all (placeholder for embedding search).
 * 2. Search memories by keyword (limit 5, minConfidence 0.3).
 * 3. Match routing rules by keyword.
 */
export async function recall(genome: Genome, query: string): Promise<RecallResult> {
	// 1. Agents: return all (placeholder until embeddings)
	const agents = genome.allAgents();

	// 2. Search memories
	const memories = genome.memories.search(query, 5, 0.3);

	// 3. Match routing rules
	const routing_hints = genome.matchRoutingRules(query);

	// Mark used memories (spec: confidence refreshed on use)
	if (memories.length > 0) {
		await genome.markMemoriesUsed(memories.map((m) => m.id));
	}

	return { agents, memories, routing_hints };
}

/**
 * Render memories as an XML block for injection into the system prompt.
 * Spec Section 5.4: <memories>...</memories>
 */
export function renderMemories(memories: Memory[]): string {
	if (memories.length === 0) return "";
	const items = memories.map((m) => `- ${m.content}`).join("\n");
	return `\n<memories>\n${items}\n</memories>`;
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
