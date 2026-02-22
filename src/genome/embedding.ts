import type { AgentSpec } from "../kernel/types.ts";

/**
 * Interface for embedding-based agent search.
 * Stub for Phase 4 — no implementation until genome exceeds 20 agents.
 * See spec Section 5.3 and Appendix D.11 question 5.
 */
export interface EmbeddingIndex {
	search(query: string, limit: number): Promise<AgentSpec[]>;
	rebuild(agents: AgentSpec[]): Promise<void>;
}
