import type { Memory } from "../kernel/types.ts";
import { JsonlStore } from "./jsonl-store.ts";
import { normalizeMemory } from "./memory-schema.ts";

const HALF_LIFE_DAYS = 30;

export class MemoryStore {
	private entries: Memory[] = [];
	private readonly jsonl: JsonlStore<unknown>;

	constructor(jsonlPath: string) {
		this.jsonl = new JsonlStore(jsonlPath);
	}

	/** Read JSONL lines from disk, parsing each as a Memory. */
	async load(): Promise<void> {
		this.entries = (await this.jsonl.load()).map((record) => normalizeMemory(record));
	}

	/** Append a memory to the in-memory list and to the JSONL file on disk. */
	async add(memory: Memory): Promise<void> {
		const normalized = normalizeMemory(memory);
		if (this.entries.some((m) => m.id === normalized.id)) {
			throw new Error(`Memory with id '${normalized.id}' already exists`);
		}
		this.entries.push(normalized);
		await this.jsonl.append(normalized);
	}

	/**
	 * Search memories by keyword matching in content and tags.
	 * Tokenizes the query into lowercase words, scores each memory by
	 * how many query tokens appear in its content or tags, filters by
	 * effective confidence, and returns the top results.
	 */
	search(query: string, limit = 5, minConfidence = 0.3): Memory[] {
		const tokens = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 0);
		if (tokens.length === 0) return [];

		const scored: { memory: Memory; score: number }[] = [];

		for (const memory of this.entries) {
			if (this.effectiveConfidence(memory) < minConfidence) continue;

			const haystack = `${memory.content} ${memory.tags.join(" ")}`.toLowerCase();
			let score = 0;
			for (const token of tokens) {
				if (haystack.includes(token)) score++;
			}
			if (score > 0) {
				scored.push({ memory, score });
			}
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map((s) => s.memory);
	}

	/** Update last_used timestamp and increment use_count. */
	markUsed(id: string): void {
		const memory = this.entries.find((m) => m.id === id);
		if (!memory) return;
		memory.last_used = Date.now();
		memory.use_count++;
		memory.last_accessed_at = memory.last_used;
		memory.access_count = memory.use_count;
	}

	/** Rewrite the entire JSONL file from the in-memory entries. */
	async save(): Promise<void> {
		await this.jsonl.rewrite(this.entries);
	}

	/** Calculate confidence decayed by time since last use (30-day half-life). */
	effectiveConfidence(memory: Memory): number {
		const daysSinceLastUse = (Date.now() - memory.last_used) / (24 * 60 * 60 * 1000);
		return memory.confidence * 0.5 ** (daysSinceLastUse / HALF_LIFE_DAYS);
	}

	/** Remove entries whose effective confidence is below the threshold, returning their ids. */
	pruneByConfidence(minConfidence: number): string[] {
		const pruned: string[] = [];
		this.entries = this.entries.filter((m) => {
			if (this.effectiveConfidence(m) < minConfidence) {
				pruned.push(m.id);
				return false;
			}
			return true;
		});
		return pruned;
	}

	/** Return a shallow copy of all entries. */
	all(): Memory[] {
		return [...this.entries];
	}

	/** Find a memory by its id. */
	getById(id: string): Memory | undefined {
		return this.entries.find((m) => m.id === id);
	}
}
