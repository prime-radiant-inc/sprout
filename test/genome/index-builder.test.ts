import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryIndexPath, rebuildMemoryIndexFromJsonl } from "../../src/genome/index-builder.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";

describe("index-builder", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-index-builder-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("computes the cache index path inside the genome", () => {
		expect(memoryIndexPath("/tmp/genome")).toBe("/tmp/genome/.cache/index.db");
	});

	test("rebuilds an index from genome memory JSONL", async () => {
		const genomeRoot = join(tempDir, "genome");
		const memoriesDir = join(genomeRoot, "memories");
		await mkdir(memoriesDir, { recursive: true });
		await cp(
			join(process.cwd(), "test/fixtures/memory/legacy-memories.jsonl"),
			join(memoriesDir, "memories.jsonl"),
		);

		const result = await rebuildMemoryIndexFromJsonl(genomeRoot);

		expect(result.indexPath).toBe(memoryIndexPath(genomeRoot));
		expect(result.stats.memoryCount).toBe(4);
		expect(existsSync(result.indexPath)).toBe(true);

		const index = MemoryIndex.open(result.indexPath);
		try {
			expect(index.searchText("typecheck", 5)).toEqual(["legacy-learn"]);
		} finally {
			index.close();
		}
	});

	test("rebuilds an empty index when memories are absent", async () => {
		const genomeRoot = join(tempDir, "empty-genome");

		const result = await rebuildMemoryIndexFromJsonl(genomeRoot);

		expect(result.stats.memoryCount).toBe(0);
		expect(existsSync(result.indexPath)).toBe(true);
	});
});
