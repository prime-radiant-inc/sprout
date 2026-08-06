import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryShortId } from "../../src/genome/memory-schema.ts";
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
		...overrides,
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

	test("stage() adds memory in memory and save() writes it to JSONL file", async () => {
		const filePath = join(tempDir, "add-test.jsonl");
		const store = new MemoryStore(filePath);
		await store.load();

		const mem = makeMemory({ id: "mem-add-1", content: "first memory" });
		store.stage(mem);
		await store.save();

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

	test("load() normalizes legacy fixture records", async () => {
		const store = new MemoryStore(
			join(process.cwd(), "test/fixtures/memory/legacy-memories.jsonl"),
		);
		await store.load();

		const all = store.all();
		expect(all).toHaveLength(4);
		expect(all[0]!.schema_version).toBe(2);
		expect(all[0]!.text).toBe(all[0]!.content);
		expect(all[0]!.short_id).toBe(memoryShortId("legacy-durable"));
		expect(all[0]!.entity_links).toEqual([]);
		expect(all[0]!.project_ids).toEqual([]);
	});

	test("search() finds by keyword in content", async () => {
		const store = new MemoryStore(join(tempDir, "search-content.jsonl"));
		await store.load();
		store.stage(makeMemory({ id: "s1", content: "typescript compiler error" }));
		store.stage(makeMemory({ id: "s2", content: "python runtime crash" }));
		store.stage(makeMemory({ id: "s3", content: "typescript type inference" }));

		const results = store.search("typescript");
		expect(results.length).toBeGreaterThanOrEqual(2);
		const ids = results.map((m) => m.id);
		expect(ids).toContain("s1");
		expect(ids).toContain("s3");
	});

	test("search() finds by keyword in tags", async () => {
		const store = new MemoryStore(join(tempDir, "search-tags.jsonl"));
		await store.load();
		store.stage(makeMemory({ id: "t1", content: "some fact", tags: ["debugging", "nodejs"] }));
		store.stage(makeMemory({ id: "t2", content: "another fact", tags: ["deployment"] }));

		const results = store.search("debugging");
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("t1");
	});

	test("search() filters by minConfidence using effective confidence", async () => {
		const store = new MemoryStore(join(tempDir, "search-confidence.jsonl"));
		await store.load();

		// Recent memory, high confidence
		store.stage(makeMemory({ id: "c1", content: "fresh knowledge", confidence: 1.0 }));

		// Old memory, should have decayed below 0.3
		const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
		store.stage(
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

	test("search() excludes archived and superseded memories", async () => {
		const store = new MemoryStore(join(tempDir, "search-inactive.jsonl"));
		await store.load();

		store.stage(makeMemory({ id: "active", content: "durable sqlite memory" }));
		store.stage(
			makeMemory({
				id: "archived",
				content: "durable sqlite memory",
				archived_at: 123,
			}),
		);
		store.stage(
			makeMemory({
				id: "superseded-field",
				content: "durable sqlite memory",
				superseded_by: "active",
			}),
		);
		store.stage(
			makeMemory({
				id: "superseded-inbound",
				content: "durable sqlite memory",
				inbound_links: [
					{ uuid: "active", type: "supersedes", reasoning: "replaced", created_at: 1 },
				],
			}),
		);

		expect(store.search("sqlite").map((memory) => memory.id)).toEqual(["active"]);
	});

	test("search() respects limit", async () => {
		const store = new MemoryStore(join(tempDir, "search-limit.jsonl"));
		await store.load();
		for (let i = 0; i < 10; i++) {
			store.stage(makeMemory({ id: `lim-${i}`, content: "common keyword here" }));
		}

		const results = store.search("common keyword", 3);
		expect(results).toHaveLength(3);
	});

	test("search() returns empty for empty/whitespace query", async () => {
		const store = new MemoryStore(join(tempDir, "search-empty.jsonl"));
		await store.load();
		store.stage(makeMemory({ content: "something" }));

		expect(store.search("")).toEqual([]);
		expect(store.search("   ")).toEqual([]);
		expect(store.search("\t\n")).toEqual([]);
	});

	test("markUsed() updates last_used and use_count", async () => {
		const store = new MemoryStore(join(tempDir, "markused.jsonl"));
		await store.load();
		const before = Date.now();
		const mem = makeMemory({ id: "mu-1", use_count: 3, last_used: before - 10000 });
		store.stage(mem);

		store.markUsed("mu-1");

		const updated = store.getById("mu-1")!;
		expect(updated.use_count).toBe(4);
		expect(updated.last_used).toBeGreaterThanOrEqual(before);
	});

	test("markMentioned() increments mention count by short id", async () => {
		const store = new MemoryStore(join(tempDir, "mentions.jsonl"));
		await store.load();
		store.stage(makeMemory({ id: "mention-target", content: "cited memory" }));

		const mentioned = store.markMentioned(
			[memoryShortId("mention-target"), "mem_missing0"],
			1700000000000,
		);

		expect(mentioned).toEqual(["mention-target"]);
		const updated = store.getById("mention-target")!;
		expect(updated.mention_count).toBe(1);
		expect(updated.updated_at).toBe(1700000000000);
	});

	test("markMentioned() deduplicates repeated short ids per response", async () => {
		const store = new MemoryStore(join(tempDir, "mentions-dedupe.jsonl"));
		await store.load();
		store.stage(makeMemory({ id: "repeat-target", content: "cited memory" }));

		const shortId = memoryShortId("repeat-target");
		store.markMentioned([shortId, shortId]);

		expect(store.getById("repeat-target")?.mention_count).toBe(1);
	});

	test("markMentioned() falls back to derived short id when short_id is missing", async () => {
		const store = new MemoryStore(join(tempDir, "mentions-derived-short-id.jsonl"));
		await store.load();
		store.stage(makeMemory({ id: "derived-target", content: "cited memory" }));
		const memory = store.getById("derived-target")!;
		delete memory.short_id;

		const mentioned = store.markMentioned([memoryShortId("derived-target")], 1700000000000);

		expect(mentioned).toEqual(["derived-target"]);
		expect(memory.mention_count).toBe(1);
		expect(memory.updated_at).toBe(1700000000000);
	});

	test("stage() rejects short id collisions", async () => {
		const store = new MemoryStore(join(tempDir, "short-id-collision.jsonl"));
		await store.load();
		store.stage(makeMemory({ id: "first", short_id: "mem_deadbeef" }));

		expect(() => store.stage(makeMemory({ id: "second", short_id: "mem_deadbeef" }))).toThrow(
			"short id collision",
		);
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
		store.stage(makeMemory({ id: "find-me" }));

		expect(store.getById("find-me")).toBeDefined();
		expect(store.getById("find-me")!.id).toBe("find-me");
		expect(store.getById("nonexistent")).toBeUndefined();
	});

	test("save() rewrites entire JSONL file", async () => {
		const filePath = join(tempDir, "save-test.jsonl");
		const store = new MemoryStore(filePath);
		await store.load();
		store.stage(makeMemory({ id: "save-1", content: "original" }));
		store.stage(makeMemory({ id: "save-2", content: "also original" }));

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

	test("mergeLatestFromDisk rejects stale edits to memories removed on disk", async () => {
		const filePath = join(tempDir, "merge-removed.jsonl");
		const staleStore = new MemoryStore(filePath);
		await staleStore.load();
		staleStore.stage(makeMemory({ id: "removed-memory" }));
		await staleStore.save();
		const deletingStore = new MemoryStore(filePath);
		await deletingStore.load();
		deletingStore.getById("removed-memory")!.archived_at = Date.now();
		const removed = deletingStore.removeArchivedOrSuperseded();
		await deletingStore.save();
		staleStore.getById("removed-memory")!.archived_at = Date.now();

		expect(removed).toEqual(["removed-memory"]);
		await expect(staleStore.mergeLatestFromDisk()).rejects.toThrow("removed on disk");
	});

	test("stage() throws on duplicate id", async () => {
		const filePath = join(tempDir, `memories-${Date.now()}.jsonl`);
		const store = new MemoryStore(filePath);
		await store.load();
		store.stage(makeMemory({ id: "dup-1", content: "first" }));
		expect(() => store.stage(makeMemory({ id: "dup-1", content: "second" }))).toThrow(
			/already exists/,
		);
	});
});
