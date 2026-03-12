import { describe, expect, test } from "bun:test";
import { loadResumeState, resolveResumeSelection } from "../../src/host/cli-resume.ts";
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

	test("resume loads a canonical selection request from persisted metadata", async () => {
		const state = await loadResumeState(
			{
				command: { kind: "resume", sessionId: "01ABC" },
				projectDataDir: "/tmp/project",
				sessionsDir: "/tmp/project/sessions",
			},
			{
				listSessions: async () => [],
				loadSessionMetadata: async () => ({
					sessionId: "01ABC",
					agentSpec: "root",
					selection: {
						kind: "model",
						model: { providerId: "openai", modelId: "gpt-4o" },
					},
					resolvedModel: { providerId: "openai", modelId: "gpt-4o" },
					status: "idle",
					turns: 0,
					contextTokens: 0,
					contextWindowSize: 0,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
				replayEventLog: async () => [],
				loadEventLog: async () => [],
				loadAllEventLogs: async () => [],
				extractChildHandles: async () => [],
				checkHandleCompleted: async () => false,
				readHandleResult: async () => null,
			},
		);

		expect(state?.selectionRequest).toEqual({
			kind: "model",
			model: { providerId: "openai", modelId: "gpt-4o" },
		});
	});

	test("resolveResumeSelection resolves unique legacy raw model ids to explicit provider identities", () => {
		expect(
			resolveResumeSelection(
				{ kind: "unqualified_model", modelId: "gpt-4o" },
				{
					settings: {
						providers: [
							{
								id: "openai",
								kind: "openai",
								label: "OpenAI",
								enabled: true,
								discoveryStrategy: "remote-only",
								createdAt: "",
								updatedAt: "",
							},
						],
						routing: {
							providerPriority: ["openai"],
							tierOverrides: {},
						},
					},
					catalog: [
						{
							providerId: "openai",
							models: [{ id: "gpt-4o", label: "gpt-4o", source: "remote" }],
						},
					],
				},
			),
		).toEqual({
			selection: {
				kind: "model",
				model: { providerId: "openai", modelId: "gpt-4o" },
			},
			resolved: { providerId: "openai", modelId: "gpt-4o" },
			source: "session",
		});
	});

	test("resolveResumeSelection rejects ambiguous legacy raw model ids", () => {
		expect(() =>
			resolveResumeSelection(
				{ kind: "unqualified_model", modelId: "gpt-4o" },
				{
					settings: {
						providers: [
							{
								id: "openai",
								kind: "openai",
								label: "OpenAI",
								enabled: true,
								discoveryStrategy: "remote-only",
								createdAt: "",
								updatedAt: "",
							},
							{
								id: "openrouter",
								kind: "openrouter",
								label: "OpenRouter",
								enabled: true,
								discoveryStrategy: "remote-only",
								createdAt: "",
								updatedAt: "",
							},
						],
						routing: {
							providerPriority: ["openai", "openrouter"],
							tierOverrides: {},
						},
					},
					catalog: [
						{
							providerId: "openai",
							models: [{ id: "gpt-4o", label: "gpt-4o", source: "remote" }],
						},
						{
							providerId: "openrouter",
							models: [{ id: "gpt-4o", label: "gpt-4o", source: "remote" }],
						},
					],
				},
			),
		).toThrow(/Ambiguous model/);
	});

	test("resolveResumeSelection rejects stale or missing catalogs for legacy raw model ids", () => {
		expect(() =>
			resolveResumeSelection(
				{ kind: "unqualified_model", modelId: "gpt-4o" },
				{
					settings: {
						providers: [
							{
								id: "openai",
								kind: "openai",
								label: "OpenAI",
								enabled: true,
								discoveryStrategy: "remote-only",
								createdAt: "",
								updatedAt: "",
							},
						],
						routing: {
							providerPriority: ["openai"],
							tierOverrides: {},
						},
					},
					catalog: [],
				},
			),
		).toThrow(/catalog/i);
	});
});
