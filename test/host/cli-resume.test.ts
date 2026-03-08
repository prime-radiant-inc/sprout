import { describe, expect, test } from "bun:test";
import { loadResumeState } from "../../src/host/cli-resume.ts";
import type { Message } from "../../src/llm/types.ts";

describe("loadResumeState", () => {
	test("resume-last returns undefined when no sessions exist", async () => {
		const state = await loadResumeState(
			{
				command: { kind: "resume-last" },
				projectDataDir: "/tmp/project",
				sessionsDir: "/tmp/project/sessions",
			},
			{
				listSessions: async () => [],
				replayEventLog: async () => [],
				loadEventLog: async () => [],
				loadAllEventLogs: async () => [],
				extractChildHandles: async () => [],
				checkHandleCompleted: async () => false,
				readHandleResult: async () => null,
			},
		);

		expect(state).toBeUndefined();
	});

	test("resume loads history, events, and completed child handle results", async () => {
		const history: Message[] = [{ role: "user", content: [{ kind: "text", text: "goal" }] }];
		const messages: string[] = [];
		const state = await loadResumeState(
			{
				command: { kind: "resume", sessionId: "01ABC" },
				projectDataDir: "/tmp/project",
				sessionsDir: "/tmp/project/sessions",
				onInfo: (line) => {
					messages.push(line);
				},
			},
			{
				listSessions: async () => [],
				replayEventLog: async () => history,
				loadEventLog: async () => [
					{
						kind: "perceive",
						timestamp: 1,
						agent_id: "root",
						depth: 0,
						data: { goal: "goal" },
					},
				],
				extractChildHandles: async () => [
					{ handleId: "h1", agentName: "worker", completed: false },
					{ handleId: "h2", agentName: "worker2", completed: true },
				],
				checkHandleCompleted: async (_dir, handleId) => handleId === "h1",
				readHandleResult: async (_dir, handleId) =>
					handleId === "h1"
						? {
								kind: "result",
								handle_id: "h1",
								output: "done",
								success: true,
								stumbles: 0,
								turns: 2,
								timed_out: false,
							}
						: null,
				loadAllEventLogs: async () => [
					{
						kind: "perceive",
						timestamp: 1,
						agent_id: "root",
						depth: 0,
						data: { goal: "goal" },
					},
				],
			},
		);

		expect(state).toBeDefined();
		expect(state!.sessionId).toBe("01ABC");
		expect(state!.history).toEqual(history);
		expect(state!.events).toHaveLength(1);
		expect(state!.completedHandles).toEqual([
			{
				handleId: "h1",
				ownerId: "root",
				result: {
					kind: "result",
					handle_id: "h1",
					output: "done",
					success: true,
					stumbles: 0,
					turns: 2,
					timed_out: false,
				},
			},
		]);
		expect(messages[0]).toContain("Resumed session 01ABC with 1 messages");
		expect(messages[1]).toContain("Child handles: 2 total, 2 completed, 0 pending");
	});
});
