import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlStore } from "../../src/genome/jsonl-store.ts";

describe("JsonlStore", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-jsonl-store-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("loads an empty list when file does not exist", async () => {
		const store = new JsonlStore<{ id: string }>(join(tempDir, "missing.jsonl"));
		expect(await store.load()).toEqual([]);
	});

	test("appends and loads JSONL records", async () => {
		const path = join(tempDir, "records.jsonl");
		const store = new JsonlStore<{ id: string; value: number }>(path);

		await store.append({ id: "a", value: 1 });
		await store.append({ id: "b", value: 2 });

		expect(await store.load()).toEqual([
			{ id: "a", value: 1 },
			{ id: "b", value: 2 },
		]);
	});

	test("rewrites records atomically", async () => {
		const path = join(tempDir, "rewrite.jsonl");
		const store = new JsonlStore<{ id: string }>(path);

		await store.append({ id: "old" });
		await store.rewrite([{ id: "new-1" }, { id: "new-2" }]);

		expect((await readFile(path, "utf-8")).trim().split("\n")).toHaveLength(2);
		expect(await store.load()).toEqual([{ id: "new-1" }, { id: "new-2" }]);
	});

	test("same-millisecond rewrites use unique temp paths", async () => {
		const path = join(tempDir, "rewrite-collision.jsonl");
		const store = new JsonlStore<{ id: string }>(path);
		const originalNow = Date.now;
		Date.now = () => 1234;
		try {
			await Promise.all([store.rewrite([{ id: "first" }]), store.rewrite([{ id: "second" }])]);
		} finally {
			Date.now = originalNow;
		}

		const records = await store.load();
		expect(records).toHaveLength(1);
		expect(["first", "second"]).toContain(records[0]!.id);
	});

	test("reports malformed JSON with filename and line number", async () => {
		const path = join(tempDir, "bad.jsonl");
		await writeFile(path, '{"id":"ok"}\nnot json\n');
		const store = new JsonlStore<{ id: string }>(path);

		await expect(store.load()).rejects.toThrow(/bad\.jsonl:2/);
	});

	test("corrupt-record error names the full path and how to recover from git", async () => {
		const path = join(tempDir, "memories.jsonl");
		await writeFile(path, '{"id":"ok"}\n{"torn": \n');
		const store = new JsonlStore<{ id: string }>(path);

		const error = await store.load().then(
			() => {
				throw new Error("load() should have rejected");
			},
			(err: unknown) => err as Error,
		);
		expect(error.message).toContain(path);
		expect(error.message).toContain("git");
		expect(error.message).toContain("restore");
	});
});
