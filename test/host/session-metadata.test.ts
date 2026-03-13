import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listSessions,
	loadSessionMetadata,
	loadSessionSummaries,
	type PersistedSessionMetadataSnapshot,
	SessionMetadata,
	type SessionMetadataSnapshot,
} from "../../src/host/session-metadata.ts";

const defaultSelection = {
	kind: "model",
	model: { providerId: "anthropic", modelId: "claude-haiku" },
} as const;

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
			selection: defaultSelection,
			resolvedModel: defaultSelection.model,
			sessionsDir: tempDir,
		});

		await meta.save();

		const filePath = join(tempDir, "01JTEST000000000000000001.meta.json");
		const raw = await readFile(filePath, "utf-8");
		const snapshot: SessionMetadataSnapshot = JSON.parse(raw);

		expect(snapshot.sessionId).toBe("01JTEST000000000000000001");
		expect(snapshot.agentSpec).toBe("root");
		expect((snapshot as PersistedSessionMetadataSnapshot).selection).toEqual(defaultSelection);
		expect((snapshot as PersistedSessionMetadataSnapshot).resolvedModel).toEqual(
			defaultSelection.model,
		);
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
			selection: defaultSelection,
			resolvedModel: defaultSelection.model,
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
			selection: defaultSelection,
			resolvedModel: defaultSelection.model,
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
			selection: defaultSelection,
			resolvedModel: defaultSelection.model,
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
			selection: defaultSelection,
			resolvedModel: defaultSelection.model,
			sessionsDir: tempDir,
		});

		await meta.save();
		const first = await loadSessionMetadata(join(tempDir, "01JTEST000000000000000004.meta.json"));

		// Small delay to ensure timestamp differs
		await new Promise((r) => setTimeout(r, 10));

		meta.updateTurn(1, 100, 200000);
		await meta.save();
		const second = await loadSessionMetadata(join(tempDir, "01JTEST000000000000000004.meta.json"));

		expect(second.updatedAt >= first.updatedAt).toBe(true);
		expect(second.createdAt).toBe(first.createdAt);
	});

	test("save persists canonical selection and resolvedModel", async () => {
		const meta = new SessionMetadata({
			sessionId: "01JTEST000000000000000010",
			agentSpec: "root",
			selection: {
				kind: "model",
				model: { providerId: "openai", modelId: "gpt-4o" },
			},
			resolvedModel: { providerId: "openai", modelId: "gpt-4o" },
			sessionsDir: tempDir,
		});

		await meta.save();

		const snapshot = await loadSessionMetadata(
			join(tempDir, "01JTEST000000000000000010.meta.json"),
		);
		expect((snapshot as PersistedSessionMetadataSnapshot).selection).toEqual({
			kind: "model",
			model: { providerId: "openai", modelId: "gpt-4o" },
		});
		expect((snapshot as PersistedSessionMetadataSnapshot).resolvedModel).toEqual({
			providerId: "openai",
			modelId: "gpt-4o",
		});
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
			selection: { kind: "tier", tier: "balanced" },
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
		expect((snapshot as PersistedSessionMetadataSnapshot).selection).toEqual({
			kind: "tier",
			tier: "balanced",
		});
		expect(snapshot.status).toBe("interrupted");
		expect(snapshot.turns).toBe(5);
		expect(snapshot.contextTokens).toBe(3000);
		expect(snapshot.contextWindowSize).toBe(200000);
	});
});

describe("loadIfExists", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-meta-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("detects stuck running status and sets to interrupted", async () => {
		const sessionId = "01STUCK_RUNNING_TEST";
		const metaPath = join(tempDir, `${sessionId}.meta.json`);

		// Create a "running" metadata file (simulating crashed session)
		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			metaPath,
			JSON.stringify({
				sessionId,
				agentSpec: "root",
				selection: { kind: "tier", tier: "best" },
				status: "running",
				turns: 5,
				contextTokens: 1000,
				contextWindowSize: 200000,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		);

		const meta = new SessionMetadata({
			sessionId,
			agentSpec: "root",
			selection: { kind: "tier", tier: "best" },
			sessionsDir: tempDir,
		});

		await meta.loadIfExists(metaPath);

		// Verify file was rewritten with "interrupted"
		const snapshot = await loadSessionMetadata(metaPath);
		expect(snapshot.status).toBe("interrupted");
	});

	test("does nothing for idle or interrupted metadata", async () => {
		const sessionId = "01IDLE_TEST";
		const metaPath = join(tempDir, `${sessionId}.meta.json`);

		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			metaPath,
			JSON.stringify({
				sessionId,
				agentSpec: "root",
				selection: { kind: "tier", tier: "best" },
				status: "idle",
				turns: 3,
				contextTokens: 500,
				contextWindowSize: 200000,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		);

		const meta = new SessionMetadata({
			sessionId,
			agentSpec: "root",
			selection: { kind: "tier", tier: "best" },
			sessionsDir: tempDir,
		});

		await meta.loadIfExists(metaPath);

		// Status should remain idle
		const snapshot = await loadSessionMetadata(metaPath);
		expect(snapshot.status).toBe("idle");
	});

	test("does nothing if metadata file does not exist", async () => {
		const meta = new SessionMetadata({
			sessionId: "01NONEXISTENT",
			agentSpec: "root",
			selection: { kind: "tier", tier: "best" },
			sessionsDir: tempDir,
		});

		// Should not throw
		await meta.loadIfExists(join(tempDir, "nonexistent.meta.json"));
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
				selection: defaultSelection,
				resolvedModel: defaultSelection.model,
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

	test("skips corrupted meta files", async () => {
		const { writeFile } = await import("node:fs/promises");

		// Create one valid session
		const meta = new SessionMetadata({
			sessionId: "01GOOD000000000000000000",
			agentSpec: "root",
			selection: defaultSelection,
			resolvedModel: defaultSelection.model,
			sessionsDir: tempDir,
		});
		await meta.save();

		// Create one corrupted .meta.json file
		await writeFile(join(tempDir, "01BAD0000000000000000000.meta.json"), "not json{{{");

		const sessions = await listSessions(tempDir);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.sessionId).toBe("01GOOD000000000000000000");
	});
});

describe("loadSessionSummaries", () => {
	let sessionsDir: string;
	let logsDir: string;

	beforeEach(async () => {
		const base = await mkdtemp(join(tmpdir(), "sprout-summaries-"));
		sessionsDir = join(base, "sessions");
		logsDir = join(base, "logs");
		await import("node:fs/promises").then((fs) => fs.mkdir(sessionsDir, { recursive: true }));
		await import("node:fs/promises").then((fs) => fs.mkdir(logsDir, { recursive: true }));
	});

	afterEach(async () => {
		const base = sessionsDir.replace(/\/sessions$/, "");
		await rm(base, { recursive: true, force: true });
	});

	async function writeSession(id: string): Promise<void> {
		const meta = new SessionMetadata({
			sessionId: id,
			agentSpec: "root",
			selection: defaultSelection,
			resolvedModel: defaultSelection.model,
			sessionsDir,
		});
		await meta.save();
	}

	async function writeLog(id: string, events: object[]): Promise<void> {
		const { writeFile } = await import("node:fs/promises");
		const lines = events.map((e) => JSON.stringify(e)).join("\n");
		await writeFile(join(logsDir, `${id}.jsonl`), `${lines}\n`);
	}

	test("returns firstPrompt from the first perceive event", async () => {
		const id = "01AAAA00000000000000000001";
		await writeSession(id);
		await writeLog(id, [
			{ kind: "perceive", depth: 0, data: { goal: "Fix the login bug" } },
			{ kind: "plan_end", depth: 0, data: { text: "I fixed it" } },
		]);

		const entries = await loadSessionSummaries(sessionsDir, logsDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.firstPrompt).toBe("Fix the login bug");
	});

	test("returns lastMessage from the last plan_end event", async () => {
		const id = "01AAAA00000000000000000002";
		await writeSession(id);
		await writeLog(id, [
			{ kind: "perceive", depth: 0, data: { goal: "Refactor DB" } },
			{ kind: "plan_end", depth: 0, data: { text: "First response" } },
			{ kind: "plan_end", depth: 0, data: { text: "Final response" } },
		]);

		const entries = await loadSessionSummaries(sessionsDir, logsDir);
		expect(entries[0]!.lastMessage).toBe("Final response");
	});

	test("ignores perceive and plan_end events at depth > 0", async () => {
		const id = "01AAAA00000000000000000003";
		await writeSession(id);
		await writeLog(id, [
			{ kind: "perceive", depth: 1, data: { goal: "Subagent goal" } },
			{ kind: "perceive", depth: 0, data: { goal: "Root goal" } },
			{ kind: "plan_end", depth: 1, data: { text: "Subagent response" } },
			{ kind: "plan_end", depth: 0, data: { text: "Root response" } },
		]);

		const entries = await loadSessionSummaries(sessionsDir, logsDir);
		expect(entries[0]!.firstPrompt).toBe("Root goal");
		expect(entries[0]!.lastMessage).toBe("Root response");
	});

	test("sets firstPrompt and lastMessage to undefined when log is missing", async () => {
		const id = "01AAAA00000000000000000004";
		await writeSession(id);
		// No log file written

		const entries = await loadSessionSummaries(sessionsDir, logsDir);
		expect(entries[0]!.firstPrompt).toBeUndefined();
		expect(entries[0]!.lastMessage).toBeUndefined();
	});

	test("returns metadata fields alongside summary fields", async () => {
		const id = "01AAAA00000000000000000005";
		await writeSession(id);
		await writeLog(id, [{ kind: "perceive", depth: 0, data: { goal: "Do something" } }]);

		const entries = await loadSessionSummaries(sessionsDir, logsDir);
		expect(entries[0]!.sessionId).toBe(id);
		expect(entries[0]!.agentSpec).toBe("root");
	});
});
