import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsStore } from "../../src/learn/metrics-store.ts";

describe("MetricsStore", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-metrics-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("stumbleCount returns 0 for unknown agent/kind", async () => {
		const store = new MetricsStore(join(tempDir, "unknown.jsonl"));
		await store.load();
		expect(store.stumbleCount("no-agent", "no-kind")).toBe(0);
	});

	test("recordStumble increments count and persists to disk", async () => {
		const filePath = join(tempDir, "stumble-persist.jsonl");
		const store = new MetricsStore(filePath);
		await store.load();

		await store.recordStumble("editor", "tool_error");
		await store.recordStumble("editor", "tool_error");
		await store.recordStumble("editor", "timeout");

		// Verify in-memory counts
		expect(store.stumbleCount("editor", "tool_error")).toBe(2);
		expect(store.stumbleCount("editor", "timeout")).toBe(1);

		// Verify JSONL lines on disk
		const raw = await readFile(filePath, "utf-8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(3);

		const first = JSON.parse(lines[0]!);
		expect(first.type).toBe("stumble");
		expect(first.agent_name).toBe("editor");
		expect(first.kind).toBe("tool_error");
		expect(typeof first.timestamp).toBe("number");

		const third = JSON.parse(lines[2]!);
		expect(third.kind).toBe("timeout");
	});

	test("load restores counts from disk", async () => {
		const filePath = join(tempDir, "load-restore.jsonl");
		const store1 = new MetricsStore(filePath);
		await store1.load();

		await store1.recordStumble("reader", "parse_error");
		await store1.recordStumble("reader", "parse_error");
		await store1.recordAction("reader");
		await store1.recordAction("reader");
		await store1.recordAction("reader");

		// Create a new store, load from disk, verify counts restored
		const store2 = new MetricsStore(filePath);
		await store2.load();

		expect(store2.stumbleCount("reader", "parse_error")).toBe(2);
		expect(store2.totalActions("reader")).toBe(3);
	});

	test("recordAction increments total action count", async () => {
		const store = new MetricsStore(join(tempDir, "actions.jsonl"));
		await store.load();

		expect(store.totalActions("runner")).toBe(0);

		await store.recordAction("runner");
		await store.recordAction("runner");

		expect(store.totalActions("runner")).toBe(2);
	});

	test("stumbleRate computes ratio of stumbles to actions", async () => {
		const store = new MetricsStore(join(tempDir, "rate.jsonl"));
		await store.load();

		await store.recordAction("agent-a");
		await store.recordAction("agent-a");
		await store.recordAction("agent-a");
		await store.recordAction("agent-a");
		await store.recordStumble("agent-a", "error");

		// 1 stumble / 4 actions = 0.25
		expect(store.stumbleRate("agent-a")).toBeCloseTo(0.25);
	});

	test("stumbleRate returns 0 when no actions recorded", async () => {
		const store = new MetricsStore(join(tempDir, "no-actions.jsonl"));
		await store.load();

		// No actions, no stumbles
		expect(store.stumbleRate("ghost")).toBe(0);

		// Has stumbles but no actions — still 0 (avoid division by zero)
		await store.recordStumble("ghost", "oops");
		expect(store.stumbleRate("ghost")).toBe(0);
	});
});
