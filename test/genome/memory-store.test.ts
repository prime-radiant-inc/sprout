import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/genome/memory-store.ts";
import type { Memory } from "../../src/kernel/types.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		content: overrides.content ?? "default memory content",
		tags: overrides.tags ?? ["default"],
		source: overrides.source ?? "test",
		created: overrides.created ?? Date.now(),
		last_used: overrides.last_used ?? Date.now(),
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1.0,
	};
}

describe("MemoryStore", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-memstore-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("starts empty after load on nonexistent file", async () => {
		const store = new MemoryStore(join(tempDir, "nonexistent.jsonl"));
		await store.load();
		expect(store.all()).toEqual([]);
	});

	test("add() appends memory and writes to JSONL file", async () => {
		const filePath = join(tempDir, "add-test.jsonl");
		const store = new MemoryStore(filePath);
		await store.load();

		const mem = makeMemory({ id: "mem-add-1", content: "first memory" });
		await store.add(mem);

		// Verify in-memory
		const all = store.all();
		expect(all).toHaveLength(1);
		expect(all[0]!.id).toBe("mem-add-1");

		// Verify on disk
		const raw = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw.trim());
		expect(parsed.id).toBe("mem-add-1");
		expect(parsed.content).toBe("first memory");
	});

	test("load() reads existing JSONL file", async () => {
		const filePath = join(tempDir, "load-test.jsonl");
		const mem1 = makeMemory({ id: "load-1", content: "alpha" });
		const mem2 = makeMemory({ id: "load-2", content: "beta" });
		await writeFile(filePath, `${JSON.stringify(mem1)}\n${JSON.stringify(mem2)}\n`);

		const store = new MemoryStore(filePath);
		await store.load();

		const all = store.all();
		expect(all).toHaveLength(2);
		expect(all[0]!.id).toBe("load-1");
		expect(all[1]!.id).toBe("load-2");
	});

	test("search() finds by keyword in content", async () => {
		const store = new MemoryStore(join(tempDir, "search-content.jsonl"));
		await store.load();
		await store.add(makeMemory({ id: "s1", content: "typescript compiler error" }));
		await store.add(makeMemory({ id: "s2", content: "python runtime crash" }));
		await store.add(makeMemory({ id: "s3", content: "typescript type inference" }));

		const results = store.search("typescript");
		expect(results.length).toBeGreaterThanOrEqual(2);
		const ids = results.map((m) => m.id);
		expect(ids).toContain("s1");
		expect(ids).toContain("s3");
	});

	test("search() finds by keyword in tags", async () => {
		const store = new MemoryStore(join(tempDir, "search-tags.jsonl"));
		await store.load();
		await store.add(makeMemory({ id: "t1", content: "some fact", tags: ["debugging", "nodejs"] }));
		await store.add(makeMemory({ id: "t2", content: "another fact", tags: ["deployment"] }));

		const results = store.search("debugging");
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("t1");
	});

	test("search() filters by minConfidence using effective confidence", async () => {
		const store = new MemoryStore(join(tempDir, "search-confidence.jsonl"));
		await store.load();

		// Recent memory, high confidence
		await store.add(makeMemory({ id: "c1", content: "fresh knowledge", confidence: 1.0 }));

		// Old memory, should have decayed below 0.3
		const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
		await store.add(
			makeMemory({
				id: "c2",
				content: "stale knowledge",
				confidence: 0.5,
				last_used: sixtyDaysAgo,
			}),
		);

		// Default minConfidence is 0.3
		const results = store.search("knowledge");
		const ids = results.map((m) => m.id);
		expect(ids).toContain("c1");
		expect(ids).not.toContain("c2"); // 0.5 * 0.5^(60/30) = 0.5 * 0.25 = 0.125 < 0.3
	});

	test("search() respects limit", async () => {
		const store = new MemoryStore(join(tempDir, "search-limit.jsonl"));
		await store.load();
		for (let i = 0; i < 10; i++) {
			await store.add(makeMemory({ id: `lim-${i}`, content: "common keyword here" }));
		}

		const results = store.search("common keyword", 3);
		expect(results).toHaveLength(3);
	});

	test("search() returns empty for empty/whitespace query", async () => {
		const store = new MemoryStore(join(tempDir, "search-empty.jsonl"));
		await store.load();
		await store.add(makeMemory({ content: "something" }));

		expect(store.search("")).toEqual([]);
		expect(store.search("   ")).toEqual([]);
		expect(store.search("\t\n")).toEqual([]);
	});

	test("markUsed() updates last_used and use_count", async () => {
		const store = new MemoryStore(join(tempDir, "markused.jsonl"));
		await store.load();
		const before = Date.now();
		const mem = makeMemory({ id: "mu-1", use_count: 3, last_used: before - 10000 });
		await store.add(mem);

		store.markUsed("mu-1");

		const updated = store.getById("mu-1")!;
		expect(updated.use_count).toBe(4);
		expect(updated.last_used).toBeGreaterThanOrEqual(before);
	});

	test("effectiveConfidence() decays based on time since last use", () => {
		const store = new MemoryStore(join(tempDir, "decay.jsonl"));

		// Recent memory: effective confidence should be close to base confidence
		const recent = makeMemory({ confidence: 1.0, last_used: Date.now() });
		expect(store.effectiveConfidence(recent)).toBeCloseTo(1.0, 1);

		// 30 days old: should be ~0.5 (one half-life)
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		const aged = makeMemory({ confidence: 1.0, last_used: thirtyDaysAgo });
		expect(store.effectiveConfidence(aged)).toBeCloseTo(0.5, 1);

		// 60 days old: should be ~0.25 (two half-lives)
		const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
		const old = makeMemory({ confidence: 1.0, last_used: sixtyDaysAgo });
		expect(store.effectiveConfidence(old)).toBeCloseTo(0.25, 1);
	});

	test("getById() returns specific memory or undefined", async () => {
		const store = new MemoryStore(join(tempDir, "getbyid.jsonl"));
		await store.load();
		await store.add(makeMemory({ id: "find-me" }));

		expect(store.getById("find-me")).toBeDefined();
		expect(store.getById("find-me")!.id).toBe("find-me");
		expect(store.getById("nonexistent")).toBeUndefined();
	});

	test("save() rewrites entire JSONL file", async () => {
		const filePath = join(tempDir, "save-test.jsonl");
		const store = new MemoryStore(filePath);
		await store.load();
		await store.add(makeMemory({ id: "save-1", content: "original" }));
		await store.add(makeMemory({ id: "save-2", content: "also original" }));

		// Mutate in memory via markUsed
		store.markUsed("save-1");
		await store.save();

		// Load in a new instance and verify
		const store2 = new MemoryStore(filePath);
		await store2.load();
		expect(store2.all()).toHaveLength(2);
		const reloaded = store2.getById("save-1")!;
		expect(reloaded.use_count).toBe(1);
	});
});
