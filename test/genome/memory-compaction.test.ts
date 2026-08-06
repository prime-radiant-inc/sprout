import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/genome/genome.ts";
import type { Memory } from "../../src/kernel/types.ts";
import { seedMemories } from "../helpers/genome-seed.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "memory-a",
		content: overrides.content ?? "Sprout stores memory in JSONL.",
		tags: overrides.tags ?? ["memory"],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1,
		...overrides,
	};
}

describe("memory log compaction", () => {
	test("removes archived and superseded rows while retaining active memories", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-memory-compaction-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await seedMemories(genome, memory({ id: "active" }));
			await seedMemories(genome, memory({ id: "archived", archived_at: 1000 }));
			await seedMemories(genome, memory({ id: "superseded", superseded_by: "active" }));
			const active = genome.memories.getById("active")!;
			active.inbound_links = [
				{
					uuid: "archived",
					type: "corroborates",
					reasoning: "Archived source used to point here.",
					created_at: 1000,
				},
				{
					uuid: "superseded",
					type: "supersedes",
					reasoning: "Superseded source used to point here.",
					created_at: 1000,
				},
			];
			await genome.saveMemoryMutation("genome: test inactive memory refs");

			const result = await genome.compactMemoryLog();

			expect(result.beforeCount).toBe(3);
			expect(result.afterCount).toBe(1);
			expect(result.removedIds).toEqual(["archived", "superseded"]);
			expect(genome.memories.all().map((entry) => entry.id)).toEqual(["active"]);
			expect(genome.memories.getById("active")?.inbound_links).toEqual([]);
			expect(await git(root, "status", "--porcelain")).toBe("");
			const raw = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			expect(raw).toContain('"id":"active"');
			expect(raw).not.toContain('"id":"archived"');
			expect(raw).not.toContain('"id":"superseded"');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("due check records a weekly cadence without rewriting every run", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-memory-compaction-due-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await seedMemories(genome, memory({ id: "active" }));

			const first = await genome.compactMemoryLogIfDue(1000);
			const second = await genome.compactMemoryLogIfDue(1000 + 60_000);

			expect(first.due).toBe(true);
			expect(first.result?.removedIds).toEqual([]);
			expect(second).toEqual({ due: false });
			expect(await git(root, "status", "--porcelain")).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
