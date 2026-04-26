import type { Memory } from "../kernel/types.ts";
import { JsonlStore } from "./jsonl-store.ts";
import { memoryShortId, normalizeMemory } from "./memory-schema.ts";

const HALF_LIFE_DAYS = 30;

export class MemoryStore {
	private entries: Memory[] = [];
	private loadedFingerprints = new Map<string, string>();
	private readonly jsonl: JsonlStore<unknown>;

	constructor(jsonlPath: string) {
		this.jsonl = new JsonlStore(jsonlPath);
	}

	/** Read JSONL lines from disk, parsing each as a Memory. */
	async load(): Promise<void> {
		this.entries = (await this.jsonl.load()).map((record) => normalizeMemory(record));
		this.assertUniqueShortIds();
		this.refreshLoadedFingerprints();
	}

	/** Append a memory to the in-memory list and to the JSONL file on disk. */
	async add(memory: Memory): Promise<void> {
		const normalized = this.stage(memory);
		await this.jsonl.append(normalized);
		this.refreshLoadedFingerprints();
	}

	/** Add a memory only in memory; caller must save/commit the enclosing mutation. */
	stage(memory: Memory): Memory {
		const normalized = normalizeMemory(memory);
		if (this.entries.some((m) => m.id === normalized.id)) {
			throw new Error(`Memory with id '${normalized.id}' already exists`);
		}
		const shortId = (normalized.short_id ?? memoryShortId(normalized.id)).toLowerCase();
		const collision = this.entries.find(
			(memory) => (memory.short_id ?? memoryShortId(memory.id)).toLowerCase() === shortId,
		);
		if (collision) {
			throw new Error(
				`Memory short id collision '${shortId}' for '${normalized.id}' and '${collision.id}'`,
			);
		}
		this.entries.push(normalized);
		return normalized;
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

	/** Increment mention_count for memories whose short ids appeared in assistant text. */
	markMentioned(shortIds: readonly string[], now = Date.now()): string[] {
		const wanted = new Set(shortIds.map((id) => id.toLowerCase()));
		const mentioned: string[] = [];
		for (const memory of this.entries) {
			const shortId = (memory.short_id ?? "").toLowerCase();
			if (!shortId || !wanted.has(shortId)) continue;
			memory.mention_count = (memory.mention_count ?? 0) + 1;
			memory.updated_at = now;
			mentioned.push(memory.id);
		}
		return mentioned;
	}

	/** Rewrite the entire JSONL file from the in-memory entries. */
	async save(): Promise<void> {
		await this.jsonl.rewrite(this.entries);
		this.refreshLoadedFingerprints();
	}

	/**
	 * Merge pending local memory edits over the latest on-disk JSONL snapshot.
	 * This preserves unrelated writes from other processes while rejecting same-id
	 * conflicts instead of silently overwriting them.
	 */
	async mergeLatestFromDisk(): Promise<void> {
		const latest = new MemoryStore(this.jsonl.path);
		await latest.load();
		const latestEntries = latest.all();
		const latestById = new Map(latestEntries.map((memory) => [memory.id, memory]));
		const merged = [...latestEntries];
		const mergedIndexById = new Map(merged.map((memory, index) => [memory.id, index]));

		for (const memory of this.changedSinceLoad()) {
			const latestMemory = latestById.get(memory.id);
			const latestFingerprint = latestMemory ? memoryFingerprint(latestMemory) : undefined;
			const loadedFingerprint = this.loadedFingerprints.get(memory.id);
			const pendingFingerprint = memoryFingerprint(memory);
			if (loadedFingerprint && !latestFingerprint) {
				throw new Error(`Memory '${memory.id}' was removed on disk; reload before saving mutation`);
			}
			if (
				latestFingerprint &&
				loadedFingerprint &&
				latestFingerprint !== loadedFingerprint &&
				pendingFingerprint !== latestFingerprint
			) {
				throw new Error(`Memory '${memory.id}' changed on disk; reload before saving mutation`);
			}
			if (latestFingerprint && !loadedFingerprint && latestFingerprint !== pendingFingerprint) {
				throw new Error(`Memory '${memory.id}' already exists on disk`);
			}
			const existingIndex = mergedIndexById.get(memory.id);
			if (existingIndex === undefined) {
				mergedIndexById.set(memory.id, merged.length);
				merged.push(memory);
			} else {
				merged[existingIndex] = memory;
			}
		}

		this.entries = merged.map((memory) => normalizeMemory(memory));
		this.assertUniqueShortIds();
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

	private assertUniqueShortIds(): void {
		const byShortId = new Map<string, string>();
		for (const memory of this.entries) {
			const shortId = (memory.short_id ?? memoryShortId(memory.id)).toLowerCase();
			const existing = byShortId.get(shortId);
			if (existing && existing !== memory.id) {
				throw new Error(
					`Memory short id collision '${shortId}' for '${memory.id}' and '${existing}'`,
				);
			}
			byShortId.set(shortId, memory.id);
		}
	}

	private changedSinceLoad(): Memory[] {
		return this.entries.filter((memory) => {
			const loaded = this.loadedFingerprints.get(memory.id);
			return loaded === undefined || loaded !== memoryFingerprint(memory);
		});
	}

	private refreshLoadedFingerprints(): void {
		this.loadedFingerprints = new Map(
			this.entries.map((memory) => [memory.id, memoryFingerprint(memory)]),
		);
	}
}

function memoryFingerprint(memory: Memory): string {
	return JSON.stringify(memory);
}
