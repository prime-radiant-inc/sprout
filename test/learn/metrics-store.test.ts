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

	test("stumbleRateForPeriod returns rate within time window", async () => {
		const store = new MetricsStore(join(tempDir, "windowed-rate.jsonl"));
		await store.load();

		await store.recordStumble("agent-a", "error");
		await store.recordAction("agent-a");

		// 1 stumble / 1 action = 1.0 all-time
		expect(store.stumbleRate("agent-a")).toBeCloseTo(1.0);

		// Rate since 1 second ago should include everything we just recorded
		const rate = await store.stumbleRateForPeriod("agent-a", Date.now() - 1000);
		expect(rate).toBeCloseTo(1.0);

		// Rate since the future should be 0 (no entries in that window)
		const futureRate = await store.stumbleRateForPeriod("agent-a", Date.now() + 1000);
		expect(futureRate).toBe(0);
	});

	test("stumbleRateForPeriod respects until parameter", async () => {
		const store = new MetricsStore(join(tempDir, "windowed-until.jsonl"));
		await store.load();

		await store.recordStumble("agent-b", "error");
		await store.recordAction("agent-b");

		// With until in the past, nothing should be in range
		const pastRate = await store.stumbleRateForPeriod("agent-b", 0, 1);
		expect(pastRate).toBe(0);

		// With until in the future and since=0, everything should be included
		const allRate = await store.stumbleRateForPeriod("agent-b", 0, Date.now() + 1000);
		expect(allRate).toBeCloseTo(1.0);
	});

	test("stumbleRateForPeriod returns 0 for nonexistent file", async () => {
		const store = new MetricsStore(join(tempDir, "does-not-exist.jsonl"));
		await store.load();

		const rate = await store.stumbleRateForPeriod("nobody", 0);
		expect(rate).toBe(0);
	});

	test("actionCountSince counts actions after a given timestamp", async () => {
		const store = new MetricsStore(join(tempDir, "action-count-since.jsonl"));
		await store.load();

		await store.recordAction("agent-x");
		await store.recordAction("agent-x");

		await new Promise((r) => setTimeout(r, 5));
		const cutoff = Date.now();
		await new Promise((r) => setTimeout(r, 5));

		await store.recordAction("agent-x");
		await store.recordAction("agent-x");
		await store.recordAction("agent-x");

		const count = await store.actionCountSince("agent-x", cutoff);
		expect(count).toBe(3);
	});

	test("actionCountSince returns 0 for nonexistent file", async () => {
		const store = new MetricsStore(join(tempDir, "no-file-actions.jsonl"));
		await store.load();

		const count = await store.actionCountSince("nobody", 0);
		expect(count).toBe(0);
	});

	test("actionCountSince returns 0 when no actions match", async () => {
		const store = new MetricsStore(join(tempDir, "no-match-actions.jsonl"));
		await store.load();

		await store.recordAction("agent-y");

		const count = await store.actionCountSince("agent-y", Date.now() + 1000);
		expect(count).toBe(0);
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
