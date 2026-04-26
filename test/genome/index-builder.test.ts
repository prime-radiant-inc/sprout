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

	test("rebuilds when a source JSONL file disappears after indexing", async () => {
		const genomeRoot = join(tempDir, "deleted-source-genome");
		const memoriesDir = join(genomeRoot, "memories");
		const memoriesPath = join(memoriesDir, "memories.jsonl");
		await mkdir(memoriesDir, { recursive: true });
		await writeFile(memoriesPath, `${memoryJson("deleted-source-memory", "vanishingterm")}\n`);
		const indexPath = memoryIndexPath(genomeRoot);
		await rebuildMemoryIndexFromJsonl(genomeRoot);
		await rm(memoriesPath);

		await ensureMemoryIndexFresh(genomeRoot);

		const index = MemoryIndex.open(indexPath);
		try {
			expect(index.stats().memoryCount).toBe(0);
			expect(index.searchText("vanishingterm", 5)).toEqual([]);
		} finally {
			index.close();
		}
	});

	test("removes stale SQLite sidecars before publishing rebuilt index", async () => {
		const genomeRoot = join(tempDir, "sidecar-stale-genome");
		const memoriesDir = join(genomeRoot, "memories");
		await mkdir(memoriesDir, { recursive: true });
		await cp(
			join(process.cwd(), "test/fixtures/memory/legacy-memories.jsonl"),
			join(memoriesDir, "memories.jsonl"),
		);
		const indexPath = memoryIndexPath(genomeRoot);
		await rebuildMemoryIndexFromJsonl(genomeRoot);
		await writeFile(`${indexPath}-wal`, "stale wal");
		await writeFile(`${indexPath}-shm`, "stale shm");

		await rebuildMemoryIndexFromJsonl(genomeRoot);

		expect(existsSync(indexPath)).toBe(true);
		expect(existsSync(`${indexPath}-wal`)).toBe(false);
		expect(existsSync(`${indexPath}-shm`)).toBe(false);
	});

	test("waits for memory write lock before reading source JSONL", async () => {
		const genomeRoot = join(tempDir, "locked-rebuild-genome");
		const memoriesDir = join(genomeRoot, "memories");
		const memoriesPath = join(memoriesDir, "memories.jsonl");
		await mkdir(memoriesDir, { recursive: true });
		await writeFile(memoriesPath, `${memoryJson("old-memory", "oldterm")}\n`);
		const lockDir = join(genomeRoot, ".cache", "memory-write.lock");
		await mkdir(lockDir, { recursive: true });

		const rebuild = rebuildMemoryIndexFromJsonl(genomeRoot);
		await sleep(50);
		await writeFile(
			memoriesPath,
			`${memoryJson("old-memory", "oldterm")}\n${memoryJson("new-memory", "newterm")}\n`,
		);
		await rm(lockDir, { recursive: true, force: true });

		const result = await rebuild;

		const index = MemoryIndex.open(result.indexPath);
		try {
			expect(index.searchText("newterm", 5)).toEqual(["new-memory"]);
		} finally {
			index.close();
		}
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

function memoryJson(id: string, content: string): string {
	return JSON.stringify({
		id,
		content,
		tags: ["test"],
		source: "test",
		created: 1,
		last_used: 1,
		use_count: 0,
		confidence: 1,
	});
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
