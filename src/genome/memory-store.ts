import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Memory } from "../kernel/types.ts";

const HALF_LIFE_DAYS = 30;

export class MemoryStore {
	private entries: Memory[] = [];
	private readonly path: string;

	constructor(jsonlPath: string) {
		this.path = jsonlPath;
	}

	/** Read JSONL lines from disk, parsing each as a Memory. */
	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf-8");
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				this.entries = [];
				return;
			}
			throw err;
		}
		this.entries = raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Memory);
	}

	/** Append a memory to the in-memory list and to the JSONL file on disk. */
	async add(memory: Memory): Promise<void> {
		if (this.entries.some((m) => m.id === memory.id)) {
			throw new Error(`Memory with id '${memory.id}' already exists`);
		}
		this.entries.push(memory);
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(memory)}\n`);
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
	}

	/** Rewrite the entire JSONL file from the in-memory entries. */
	async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const content =
			this.entries.length > 0
				? `${this.entries.map((m) => JSON.stringify(m)).join("\n")}\n`
				: "";
		await writeFile(this.path, content);
	}

	/** Calculate confidence decayed by time since last use (30-day half-life). */
	effectiveConfidence(memory: Memory): number {
		const daysSinceLastUse = (Date.now() - memory.last_used) / (24 * 60 * 60 * 1000);
		return memory.confidence * 0.5 ** (daysSinceLastUse / HALF_LIFE_DAYS);
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
