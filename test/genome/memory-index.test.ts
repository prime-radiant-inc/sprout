import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlStore } from "../../src/genome/jsonl-store.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import { normalizeMemory } from "../../src/genome/memory-schema.ts";
import type { Memory } from "../../src/kernel/types.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return normalizeMemory({
		id: overrides.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		content: overrides.content ?? "default memory content",
		tags: overrides.tags ?? ["default"],
		source: overrides.source ?? "test",
		created: overrides.created ?? Date.now(),
		last_used: overrides.last_used ?? Date.now(),
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1.0,
		...overrides,
	});
}

describe("MemoryIndex", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-memory-index-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates schema and rebuilds from memory records", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({ id: "idx-1", content: "typescript compiler error" }),
				makeMemory({
					id: "idx-2",
					content: "auth module lives in src/auth",
					entity_links: [{ uuid: "entity-sprout", type: "PROJECT", name: "Sprout" }],
					outbound_links: [
						{
							uuid: "idx-1",
							type: "contextualizes",
							reasoning: "same implementation session",
							created_at: 1700000000000,
						},
					],
				}),
			]);

			expect(index.stats()).toEqual({
				memoryCount: 2,
				entityCount: 1,
				linkCount: 1,
			});
		} finally {
			index.close();
		}
	});

	test("searches indexed text with FTS5", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([
				makeMemory({ id: "idx-typescript", content: "typescript compiler error" }),
				makeMemory({ id: "idx-python", content: "python runtime failure" }),
			]);

			expect(index.searchText("compiler", 5)).toEqual(["idx-typescript"]);
		} finally {
			index.close();
		}
	});

	test("rebuilds from JSONL-loaded legacy fixture records", async () => {
		const fixture = new JsonlStore<unknown>(
			join(process.cwd(), "test/fixtures/memory/legacy-memories.jsonl"),
		);
		const records = (await fixture.load()).map((record) => normalizeMemory(record));
		const index = MemoryIndex.open(join(tempDir, "index.db"));
		try {
			index.rebuild(records);

			expect(index.stats().memoryCount).toBe(4);
			expect(index.searchText("typecheck", 5)).toEqual(["legacy-learn"]);
		} finally {
			index.close();
		}
	});

	test("rebuild clears records from previous generations", () => {
		const index = MemoryIndex.open(":memory:");
		try {
			index.rebuild([makeMemory({ id: "old", content: "old content" })]);
			index.rebuild([makeMemory({ id: "new", content: "new content" })]);

			expect(index.stats().memoryCount).toBe(1);
			expect(index.searchText("old", 5)).toEqual([]);
			expect(index.searchText("new", 5)).toEqual(["new"]);
		} finally {
			index.close();
		}
	});
});
