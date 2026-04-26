import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attachReadySegmentEmbedding,
	type MemorySegment,
	normalizeSegment,
	SegmentStore,
} from "../../src/genome/segments.ts";
import { FakeEmbeddingProvider } from "../../src/llm/embeddings.ts";

function makeSegment(overrides: Partial<MemorySegment> = {}): MemorySegment {
	return normalizeSegment({
		id: overrides.id ?? "seg-1",
		session_id: overrides.session_id ?? "session-1",
		summary: overrides.summary ?? "Implemented local SQLite memory recall.",
		title: overrides.title ?? "Memory recall implementation",
		started_at: overrides.started_at ?? 1700000000000,
		ended_at: overrides.ended_at ?? 1700000060000,
		created_at: overrides.created_at ?? 1700000061000,
		message_count: overrides.message_count ?? 3,
		project_id: overrides.project_id ?? "sprout",
		project_confidence: overrides.project_confidence ?? 0.9,
		complexity: overrides.complexity ?? 2,
		source: "session-collapse",
		...overrides,
	});
}

describe("SegmentStore", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-segments-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("normalizes minimal segment records", () => {
		const segment = normalizeSegment({
			id: "seg-min",
			session_id: "session-1",
			summary: "User prefers local embeddings.",
		});

		expect(segment.title).toBe("Session segment");
		expect(segment.project_id).toBe("unknown");
		expect(segment.source).toBe("session-collapse");
	});

	test("adds, loads, and rewrites segment records", async () => {
		const path = join(tempDir, "segments.jsonl");
		const store = new SegmentStore(path);
		await store.load();
		await store.add(makeSegment({ id: "seg-a" }));
		await store.add(makeSegment({ id: "seg-b", summary: "Added transcript collapse." }));

		const reloaded = new SegmentStore(path);
		await reloaded.load();
		expect(reloaded.all().map((segment) => segment.id)).toEqual(["seg-a", "seg-b"]);
		expect(reloaded.getById("seg-b")?.summary).toBe("Added transcript collapse.");

		await reloaded.save();
		const savedAgain = new SegmentStore(path);
		await savedAgain.load();
		expect(savedAgain.all()).toHaveLength(2);
	});

	test("attaches ready local-compatible embeddings to segment summaries", async () => {
		const embedded = await attachReadySegmentEmbedding(
			makeSegment({ id: "seg-embed", summary: "SQLite segment index summary" }),
			new FakeEmbeddingProvider(),
			{ now: 1700000100000 },
		);

		expect(embedded.embedding?.status).toBe("ready");
		expect(embedded.embedding?.dimensions).toBe(768);
		expect(embedded.embedding?.vector).toHaveLength(768);
		expect(embedded.embedding?.embedded_at).toBe(1700000100000);
	});
});
