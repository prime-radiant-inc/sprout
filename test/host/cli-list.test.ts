import { describe, expect, test } from "bun:test";
import { runListMode } from "../../src/host/cli-list.ts";
import type { SessionListEntry } from "../../src/host/session-metadata.ts";

function makeSession(sessionId: string): SessionListEntry {
	return {
		sessionId,
		agentSpec: "root",
		model: "claude-sonnet-4-5",
		status: "idle",
		turns: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		createdAt: "2026-03-04T00:00:00.000Z",
		updatedAt: "2026-03-04T00:00:00.000Z",
	};
}

describe("runListMode", () => {
	test("prints no-sessions message and exits when no sessions exist", async () => {
		let noSessionsCount = 0;
		const resumed: string[] = [];

		await runListMode(
			{
				sessionsDir: "/tmp/sessions",
				logsDir: "/tmp/logs",
				onResume: async (sessionId) => {
					resumed.push(sessionId);
				},
			},
			{
				loadSessionSummaries: async () => [],
				presentSessionPicker: async () => {
					throw new Error("picker should not be called");
				},
				onNoSessions: () => {
					noSessionsCount++;
				},
			},
		);

		expect(noSessionsCount).toBe(1);
		expect(resumed).toEqual([]);
	});

	test("resumes the selected session id from the picker", async () => {
		const resumed: string[] = [];

		await runListMode(
			{
				sessionsDir: "/tmp/sessions",
				logsDir: "/tmp/logs",
				onResume: async (sessionId) => {
					resumed.push(sessionId);
				},
			},
			{
				loadSessionSummaries: async () => [makeSession("01AAA"), makeSession("01BBB")],
				presentSessionPicker: async (sessions) => {
					expect(sessions.map((s) => s.sessionId)).toEqual(["01AAA", "01BBB"]);
					return "01BBB";
				},
				onNoSessions: () => {
					throw new Error("onNoSessions should not be called");
				},
			},
		);

		expect(resumed).toEqual(["01BBB"]);
	});

	test("does not resume when picker is cancelled", async () => {
		const resumed: string[] = [];

		await runListMode(
			{
				sessionsDir: "/tmp/sessions",
				logsDir: "/tmp/logs",
				onResume: async (sessionId) => {
					resumed.push(sessionId);
				},
			},
			{
				loadSessionSummaries: async () => [makeSession("01AAA")],
				presentSessionPicker: async () => null,
				onNoSessions: () => {
					throw new Error("onNoSessions should not be called");
				},
			},
		);

		expect(resumed).toEqual([]);
	});
});
