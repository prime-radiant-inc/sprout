import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureMemoryIndexFresh,
	memoryIndexPath,
	rebuildMemoryIndexFromJsonl,
} from "../../src/genome/index-builder.ts";
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

	test("rebuilds a fresh-mtime index when schema version is stale", async () => {
		const genomeRoot = join(tempDir, "schema-stale-genome");
		const memoriesDir = join(genomeRoot, "memories");
		await mkdir(memoriesDir, { recursive: true });
		await cp(
			join(process.cwd(), "test/fixtures/memory/legacy-memories.jsonl"),
			join(memoriesDir, "memories.jsonl"),
		);
		const indexPath = memoryIndexPath(genomeRoot);
		await rebuildMemoryIndexFromJsonl(genomeRoot);
		const db = new Database(indexPath);
		try {
			db.run("UPDATE memory_index_meta SET value = '1' WHERE key = 'schema_version'");
		} finally {
			db.close();
		}

		await ensureMemoryIndexFresh(genomeRoot);

		expect(MemoryIndex.readSchemaVersion(indexPath)).toBe(MemoryIndex.currentSchemaVersion());
	});

	test("preserves an existing index when rebuild fails", async () => {
		const genomeRoot = join(tempDir, "rebuild-failure-genome");
		const memoriesDir = join(genomeRoot, "memories");
		await mkdir(memoriesDir, { recursive: true });
		const memoriesPath = join(memoriesDir, "memories.jsonl");
		await cp(join(process.cwd(), "test/fixtures/memory/legacy-memories.jsonl"), memoriesPath);
		const indexPath = memoryIndexPath(genomeRoot);
		await rebuildMemoryIndexFromJsonl(genomeRoot);

		await writeFile(
			memoriesPath,
			`${JSON.stringify({
				id: "bad-embedding",
				content: "This row should fail the index rebuild.",
				tags: ["memory"],
				source: "test",
				created: Date.now(),
				last_used: Date.now(),
				use_count: 0,
				confidence: 1,
				embedding: {
					status: "ready",
					provider: "test",
					model: "test",
					dimensions: 3,
					vector: [0, 0, 0],
				},
			})}\n`,
		);

		await expect(rebuildMemoryIndexFromJsonl(genomeRoot)).rejects.toThrow("embedding dimensions");

		expect(existsSync(indexPath)).toBe(true);
		const index = MemoryIndex.open(indexPath);
		try {
			expect(index.searchText("typecheck", 5)).toEqual(["legacy-learn"]);
		} finally {
			index.close();
		}
	});
});
