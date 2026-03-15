import { describe, expect, test } from "bun:test";
import { executePlanningTurn } from "../../src/agents/run-loop-planning.ts";
import type { ReplayTurnRecord } from "../../src/host/replay/types.ts";
import { ContentKind, Msg, type Request, type Response } from "../../src/llm/types.ts";

describe("executePlanningTurn", () => {
	test("success path emits planning events, appends assistant message, and returns tool calls", async () => {
		const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
		const debugCalls: Array<{ message: string; data?: Record<string, unknown> }> = [];
		const history = [Msg.user("goal")];
		let capturedRequest: Request | undefined;
		const replayRecords: ReplayTurnRecord[] = [];

		const response: Response = {
			id: "r1",
			model: "claude-sonnet-4-5-20250929",
			provider: "anthropic",
			message: {
				role: "assistant",
				content: [
					{ kind: ContentKind.TEXT, text: "Working on it" },
					{
						kind: ContentKind.TOOL_CALL,
						tool_call: { id: "c1", name: "read_file", arguments: { path: "README.md" } },
					},
				],
			},
			finish_reason: { reason: "tool_calls" },
			usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
		};

		const result = await executePlanningTurn({
			sessionId: "01SESSION",
			turn: 2,
			agentId: "root",
			depth: 0,
			systemPrompt: "sys",
			history,
			agentTools: [],
			primitiveTools: [],
			model: "claude-sonnet-4-5-20250929",
			provider: "anthropic",
			emit: (kind, _agentId, _depth, data) => {
				events.push({ kind, data });
			},
			requestPlanResponse: async (opts) => {
				capturedRequest = opts.request;
				return { response, latencyMs: 42 };
			},
			recordReplay: (record) => {
				replayRecords.push(record);
			},
			logger: {
				debug: (_category, message, data) => {
					debugCalls.push({ message, data });
				},
			},
		});

		expect(capturedRequest?.model).toBe("claude-sonnet-4-5-20250929");
		expect(capturedRequest?.provider).toBe("anthropic");
		expect(events.map((e) => e.kind)).toEqual(["plan_start", "llm_start", "llm_end", "plan_end"]);
		expect(history.at(-1)).toEqual(response.message);
		expect(debugCalls[0]?.message).toBe("Plan response received");
		expect(replayRecords).toHaveLength(1);
		expect(replayRecords[0]).toMatchObject({
			schema_version: "sprout-replay-v1",
			session_id: "01SESSION",
			agent_id: "root",
			depth: 0,
			turn: 2,
			request_context: {
				system_prompt: "sys",
				history: [Msg.user("goal")],
				agent_tools: [],
				primitive_tools: [],
			},
			request: {
				model: "claude-sonnet-4-5-20250929",
				provider: "anthropic",
				messages: [Msg.system("sys"), Msg.user("goal")],
			},
			response,
		});
		expect(typeof replayRecords[0]?.timestamp).toBe("string");
		expect(result.kind).toBe("success");
		if (result.kind === "success") {
			expect(result.toolCalls).toEqual([
				{ id: "c1", name: "read_file", arguments: { path: "README.md" } },
			]);
		}
	});

	test("interrupted path returns interrupted without appending history", async () => {
		const events: string[] = [];
		const history = [Msg.user("goal")];
		let debugCalled = false;
		const replayRecords: ReplayTurnRecord[] = [];

		const result = await executePlanningTurn({
			sessionId: "01SESSION",
			turn: 1,
			agentId: "root",
			depth: 0,
			systemPrompt: "sys",
			history,
			agentTools: [],
			primitiveTools: [],
			model: "claude-sonnet-4-5-20250929",
			provider: "anthropic",
			emit: (kind) => {
				events.push(kind);
			},
			requestPlanResponse: async () => "interrupted",
			recordReplay: (record) => {
				replayRecords.push(record);
			},
			logger: {
				debug: () => {
					debugCalled = true;
				},
			},
		});

		expect(result).toEqual({ kind: "interrupted" });
		expect(events).toEqual(["plan_start", "llm_start"]);
		expect(history).toEqual([Msg.user("goal")]);
		expect(debugCalled).toBe(false);
		expect(replayRecords).toEqual([]);
	});
});
