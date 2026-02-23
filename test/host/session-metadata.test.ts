import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionMetadata,
	type SessionMetadataSnapshot,
	listSessions,
	loadSessionMetadata,
} from "../../src/host/session-metadata.ts";

describe("SessionMetadata", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-meta-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("save creates a JSON file", async () => {
		const meta = new SessionMetadata({
			sessionId: "01JTEST000000000000000001",
			agentSpec: "root",
			model: "claude-haiku",
			sessionsDir: tempDir,
		});

		await meta.save();

		const filePath = join(tempDir, "01JTEST000000000000000001.meta.json");
		const raw = await readFile(filePath, "utf-8");
		const snapshot: SessionMetadataSnapshot = JSON.parse(raw);

		expect(snapshot.sessionId).toBe("01JTEST000000000000000001");
		expect(snapshot.agentSpec).toBe("root");
		expect(snapshot.model).toBe("claude-haiku");
		expect(snapshot.status).toBe("idle");
		expect(snapshot.turns).toBe(0);
		expect(snapshot.contextTokens).toBe(0);
		expect(snapshot.contextWindowSize).toBe(0);
		expect(snapshot.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(snapshot.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("save creates dir if needed", async () => {
		const nestedDir = join(tempDir, "nested", "sessions");
		const meta = new SessionMetadata({
			sessionId: "01JTEST000000000000000001",
			agentSpec: "root",
			model: "claude-haiku",
			sessionsDir: nestedDir,
		});

		await meta.save();

		const files = await readdir(nestedDir);
		expect(files).toContain("01JTEST000000000000000001.meta.json");
	});

	test("updateTurn updates counts", async () => {
		const meta = new SessionMetadata({
			sessionId: "01JTEST000000000000000002",
			agentSpec: "root",
			model: "claude-haiku",
			sessionsDir: tempDir,
		});

		meta.updateTurn(3, 1500, 200000);
		await meta.save();

		const snapshot = await loadSessionMetadata(
			join(tempDir, "01JTEST000000000000000002.meta.json"),
		);
		expect(snapshot.turns).toBe(3);
		expect(snapshot.contextTokens).toBe(1500);
		expect(snapshot.contextWindowSize).toBe(200000);
	});

	test("setStatus changes status", async () => {
		const meta = new SessionMetadata({
			sessionId: "01JTEST000000000000000003",
			agentSpec: "root",
			model: "claude-haiku",
			sessionsDir: tempDir,
		});

		meta.setStatus("running");
		await meta.save();

		const snapshot = await loadSessionMetadata(
			join(tempDir, "01JTEST000000000000000003.meta.json"),
		);
		expect(snapshot.status).toBe("running");
	});

	test("updatedAt changes on save", async () => {
		const meta = new SessionMetadata({
			sessionId: "01JTEST000000000000000004",
			agentSpec: "root",
			model: "claude-haiku",
			sessionsDir: tempDir,
		});

		await meta.save();
		const first = await loadSessionMetadata(
			join(tempDir, "01JTEST000000000000000004.meta.json"),
		);

		// Small delay to ensure timestamp differs
		await new Promise((r) => setTimeout(r, 10));

		meta.updateTurn(1, 100, 200000);
		await meta.save();
		const second = await loadSessionMetadata(
			join(tempDir, "01JTEST000000000000000004.meta.json"),
		);

		expect(second.updatedAt >= first.updatedAt).toBe(true);
		expect(second.createdAt).toBe(first.createdAt);
	});
});

describe("loadSessionMetadata", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-meta-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("round-trip save and load", async () => {
		const meta = new SessionMetadata({
			sessionId: "01JTEST000000000000000005",
			agentSpec: "planner",
			model: "claude-sonnet",
			sessionsDir: tempDir,
		});
		meta.updateTurn(5, 3000, 200000);
		meta.setStatus("interrupted");
		await meta.save();

		const snapshot = await loadSessionMetadata(
			join(tempDir, "01JTEST000000000000000005.meta.json"),
		);

		expect(snapshot.sessionId).toBe("01JTEST000000000000000005");
		expect(snapshot.agentSpec).toBe("planner");
		expect(snapshot.model).toBe("claude-sonnet");
		expect(snapshot.status).toBe("interrupted");
		expect(snapshot.turns).toBe(5);
		expect(snapshot.contextTokens).toBe(3000);
		expect(snapshot.contextWindowSize).toBe(200000);
	});
});

describe("listSessions", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-meta-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("sorted by ULID (filename)", async () => {
		// Create 3 sessions with ULIDs that sort as AAA < BBB < CCC
		// Insert them out of order: AAA, CCC, BBB
		for (const id of [
			"01AAAA00000000000000000000",
			"01CCCC00000000000000000000",
			"01BBBB00000000000000000000",
		]) {
			const meta = new SessionMetadata({
				sessionId: id,
				agentSpec: "root",
				model: "claude-haiku",
				sessionsDir: tempDir,
			});
			await meta.save();
		}

		const sessions = await listSessions(tempDir);
		expect(sessions).toHaveLength(3);
		expect(sessions[0]!.sessionId).toBe("01AAAA00000000000000000000");
		expect(sessions[1]!.sessionId).toBe("01BBBB00000000000000000000");
		expect(sessions[2]!.sessionId).toBe("01CCCC00000000000000000000");
	});

	test("returns empty array for missing dir", async () => {
		const sessions = await listSessions(join(tempDir, "nonexistent"));
		expect(sessions).toEqual([]);
	});
});
