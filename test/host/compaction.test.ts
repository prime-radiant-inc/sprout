import { describe, expect, test } from "bun:test";
import { compactHistory, shouldCompact } from "../../src/host/compaction.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Message, Request, Response } from "../../src/llm/types.ts";
import { ContentKind, Msg, messageText } from "../../src/llm/types.ts";

// ---------------------------------------------------------------------------
// shouldCompact — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe("shouldCompact", () => {
	test("returns false below threshold", () => {
		expect(shouldCompact(70, 100)).toBe(false);
		expect(shouldCompact(79, 100)).toBe(false);
		expect(shouldCompact(0, 100)).toBe(false);
	});

	test("returns true at or above threshold", () => {
		expect(shouldCompact(80, 100)).toBe(true);
		expect(shouldCompact(81, 100)).toBe(true);
		expect(shouldCompact(100, 100)).toBe(true);
		expect(shouldCompact(8000, 10000)).toBe(true);
	});

	test("shouldCompact returns false below 80% and true at 80%", () => {
		expect(shouldCompact(158000, 200000)).toBe(false);
		expect(shouldCompact(160000, 200000)).toBe(true);
		expect(shouldCompact(162000, 200000)).toBe(true);
	});

	test("returns false for zero context window", () => {
		expect(shouldCompact(0, 0)).toBe(false);
		expect(shouldCompact(100, 0)).toBe(false);
		expect(shouldCompact(100, -1)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// compactHistory
// ---------------------------------------------------------------------------

function makeFakeClient(summaryText: string): Client {
	const mockResponse: Response = {
		id: "mock-compact",
		model: "test-model",
		provider: "test",
		message: Msg.assistant(summaryText),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
	};
	return {
		complete: async () => mockResponse,
	} as unknown as Client;
}

function makeHistory(count: number): Message[] {
	const messages: Message[] = [];
	for (let i = 0; i < count; i++) {
		if (i % 2 === 0) {
			messages.push(Msg.user(`User message ${i}`));
		} else {
			messages.push(Msg.assistant(`Assistant message ${i}`));
		}
	}
	return messages;
}

/** Assistant message containing a tool call */
function assistantWithToolCall(callId: string): Message {
	return {
		role: "assistant",
		content: [
			{
				kind: ContentKind.TOOL_CALL,
				tool_call: { id: callId, name: "some_tool", arguments: "{}" },
			},
		],
	};
}

describe("compactHistory", () => {
	test("returns early when history <= 6 messages", async () => {
		const history = makeHistory(6);
		const original = [...history];
		const client = makeFakeClient("Should not be called");

		const result = await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		expect(result.summary).toBe("");
		expect(result.beforeCount).toBe(6);
		expect(result.afterCount).toBe(6);
		// History should be unchanged
		expect(history).toEqual(original);
	});

	test("preserves last 6 messages", async () => {
		const history = makeHistory(10);
		const last6 = history.slice(-6);
		const client = makeFakeClient("Compacted summary");

		await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		// After compaction: 1 summary message + 6 recent = 7
		expect(history.length).toBe(7);
		// The last 6 messages should match the originals
		expect(history.slice(-6)).toEqual(last6);
	});

	test("replaces older messages with summary", async () => {
		const history = makeHistory(10);
		const client = makeFakeClient("Compacted summary");

		const result = await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		expect(result.beforeCount).toBe(10);
		expect(result.afterCount).toBe(7);
		// summary now includes the prefix with log path reference
		expect(result.summary).toContain("Compacted summary");
		expect(result.summary).toContain("Full conversation log available at:");

		// First message should be the summary (as user message)
		const firstMsg = history[0]!;
		expect(firstMsg.role).toBe("user");
		const text = messageText(firstMsg);
		expect(text).toContain("Compacted summary");
	});

	test("summary includes log file path", async () => {
		const history = makeHistory(10);
		const logPath = "/var/log/sprout/session-42.jsonl";
		const client = makeFakeClient("The summary");

		await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath,
		});

		const summaryMsg = messageText(history[0]!);
		expect(summaryMsg).toContain(logPath);
	});

	test("summary prefix matches expected format", async () => {
		const history = makeHistory(10);
		const logPath = "/tmp/test.log";
		const client = makeFakeClient("The summary");

		await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath,
		});

		const summaryMsg = messageText(history[0]!);
		expect(summaryMsg).toContain(
			"Another language model started this task and produced a summary of its work.",
		);
		expect(summaryMsg).toContain(
			`Full conversation log available at: ${logPath} (grep for details if needed).`,
		);
		expect(summaryMsg).toContain(
			"Use this summary to continue the work without duplicating effort:",
		);
	});

	test("sends empty tools and system to prevent inheritance", async () => {
		const history = makeHistory(10);
		let capturedRequest: Request | undefined;
		const client = {
			complete: async (req: Request) => {
				capturedRequest = req;
				return {
					id: "mock",
					model: "test",
					provider: "test",
					message: Msg.assistant("Summary"),
					finish_reason: { reason: "stop" as const },
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				};
			},
		} as unknown as Client;

		await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.tools).toEqual([]);
		expect(capturedRequest!.system).toBe("");
	});

	test("buildCompactionPrompt includes older turns content", async () => {
		const history = makeHistory(10);
		// Capture what gets sent to client.complete()
		let capturedRequest: Request | undefined;
		const client = {
			complete: async (req: Request) => {
				capturedRequest = req;
				return {
					id: "mock",
					model: "test",
					provider: "test",
					message: Msg.assistant("Summary"),
					finish_reason: { reason: "stop" as const },
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				};
			},
		} as unknown as Client;

		await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		// The request should contain the older turns (first 4 messages)
		expect(capturedRequest).toBeDefined();
		const messages = capturedRequest!.messages;
		// Older turns are messages 0..3, plus a compaction prompt as final user message
		// The older turns should be present
		expect(messages.length).toBeGreaterThan(1);
		// Last message should be the compaction prompt
		const lastMsg = messages[messages.length - 1]!;
		expect(lastMsg.role).toBe("user");
		expect(messageText(lastMsg)).toContain("CONTEXT CHECKPOINT COMPACTION");
		// Earlier messages should include older turn content
		const allText = messages.map((m) => messageText(m)).join(" ");
		expect(allText).toContain("User message 0");
		expect(allText).toContain("Assistant message 1");
	});

	test("adjusts split point to avoid starting with tool message", async () => {
		// 10 messages: naive splitIndex = 10 - 6 = 4, which is a tool message.
		// Fix should walk back to index 3 (assistant), preserving 7 recent messages.
		const history: Message[] = [
			Msg.user("task description"),             // 0
			assistantWithToolCall("c1"),               // 1
			Msg.toolResult("c1", "result 1"),          // 2
			assistantWithToolCall("c2"),               // 3
			Msg.toolResult("c2", "result 2"),          // 4  <-- naive split
			Msg.toolResult("c2", "result 2b"),         // 5
			Msg.assistant("done with tools"),           // 6
			Msg.user("next question"),                  // 7
			assistantWithToolCall("c3"),               // 8
			Msg.toolResult("c3", "result 3"),          // 9
		];
		const client = makeFakeClient("Compacted summary");

		const result = await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		// Split should have moved back to index 3, so:
		// olderTurns = [0..2], recentTurns = [3..9] = 7 messages
		// afterCount = 1 (summary) + 7 = 8
		expect(result.afterCount).toBe(8);
		// The preserved recent messages should start with assistant, not tool
		expect(history[1]!.role).not.toBe("tool");
		// Specifically, history[1] should be the assistant(c2) from original index 3
		expect(history[1]!.role).toBe("assistant");
	});

	test("preserves more than 6 messages when needed to avoid splitting tool pairs", async () => {
		// 12 messages: naive splitIndex = 12 - 6 = 6, which is a tool message.
		// Cluster of tool results at indices 4-6 forces walk back to index 4 (assistant).
		const history: Message[] = [
			Msg.user("start"),                         // 0
			Msg.assistant("thinking"),                  // 1
			Msg.user("do the thing"),                   // 2
			assistantWithToolCall("c1"),               // 3
			assistantWithToolCall("c2"),               // 4
			Msg.toolResult("c1", "r1"),                // 5
			Msg.toolResult("c2", "r2"),                // 6  <-- naive split
			Msg.assistant("analysis"),                  // 7
			Msg.user("follow-up"),                      // 8
			Msg.assistant("response"),                  // 9
			Msg.user("another"),                        // 10
			Msg.assistant("final"),                     // 11
		];
		const client = makeFakeClient("Compacted summary");

		const result = await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		// Walk back from 6 (tool) -> 5 (tool) -> 4 (assistant, stop)
		// olderTurns = [0..3], recentTurns = [4..11] = 8 messages
		// afterCount = 1 (summary) + 8 = 9
		expect(result.afterCount).toBe(9);
		// That's more than the default 7 (1 summary + 6 preserved)
		expect(result.afterCount).toBeGreaterThan(7);
	});

	test("returns early when split adjustment would preserve entire history", async () => {
		// 8 messages: naive splitIndex = 8 - 6 = 2, which is a tool message.
		// Walking back: index 1 is also tool, index 0 is assistant -> splitIndex = 0.
		// Should return early with empty summary and unchanged history.
		const history: Message[] = [
			assistantWithToolCall("c0"),               // 0
			Msg.toolResult("c0", "r0"),                // 1
			Msg.toolResult("c0", "r0b"),               // 2  <-- naive split
			Msg.assistant("result"),                    // 3
			Msg.user("question"),                       // 4
			Msg.assistant("answer"),                    // 5
			Msg.user("more"),                           // 6
			Msg.assistant("done"),                      // 7
		];
		const original = [...history];
		const client = makeFakeClient("Should not be called");

		const result = await compactHistory({
			history,
			client,
			model: "test-model",
			provider: "test",
			logPath: "/tmp/test.log",
		});

		expect(result.summary).toBe("");
		expect(result.beforeCount).toBe(8);
		expect(result.afterCount).toBe(8);
		expect(history).toEqual(original);
	});
});
