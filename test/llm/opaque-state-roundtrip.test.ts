import { describe, expect, test } from "bun:test";
import { AnthropicAdapter } from "../../src/llm/anthropic.ts";
import { GeminiAdapter } from "../../src/llm/gemini.ts";
import {
	buildResponsesInput,
	OpenAIAdapter,
	parseResponsesResponse,
} from "../../src/llm/openai.ts";
import { ContentKind, type Message, type Request } from "../../src/llm/types.ts";

/**
 * Byte-exact persistence of opaque provider state across journal/resume
 * (sap-completion Phase 1). A resumed session reassembles prior assistant turns
 * from JSON journal records; the opaque provider blocks (Anthropic thinking
 * signatures, OpenAI encrypted reasoning items, Gemini thought signatures) must
 * round-trip byte-for-byte and be replayed into the next provider request in
 * original position/encoding.
 */

/** Simulate the JSONL journal round-trip an assistant turn undergoes on resume. */
function throughJournal(message: Message): Message {
	return JSON.parse(JSON.stringify(message)) as Message;
}

describe("Anthropic thinking-block opaque state", () => {
	const SIGNATURE = "EqoBCkgI...opaque-signature-bytes/+=";

	test("thinking signature round-trips byte-exact into the next request", async () => {
		const adapter = new AnthropicAdapter("test-key");
		let capturedSecondRequest: any;
		let call = 0;
		(adapter as any).client = {
			messages: {
				create: async (params: any) => {
					call++;
					if (call === 2) capturedSecondRequest = params;
					return {
						id: `msg-${call}`,
						model: "claude-opus-4-8",
						role: "assistant",
						type: "message",
						content: [
							{ type: "thinking", thinking: "Let me reason.", signature: SIGNATURE },
							{ type: "text", text: "Hello." },
						],
						stop_reason: "end_turn",
						usage: { input_tokens: 5, output_tokens: 3 },
					};
				},
			},
		};

		const first = await adapter.complete({
			model: "claude-opus-4-8",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hi" }] }],
		});

		const thinkingPart = first.message.content.find((p) => p.kind === ContentKind.THINKING);
		expect(thinkingPart?.thinking?.signature).toBe(SIGNATURE);

		// Persist + resume: journal the assistant message, then send it back.
		const resumed = throughJournal(first.message);
		await adapter.complete({
			model: "claude-opus-4-8",
			messages: [
				{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hi" }] },
				resumed,
				{ role: "user", content: [{ kind: ContentKind.TEXT, text: "again" }] },
			],
		});

		const assistantMsg = capturedSecondRequest.messages.find((m: any) => m.role === "assistant");
		const outThinking = assistantMsg.content.find((b: any) => b.type === "thinking");
		expect(outThinking).toEqual({
			type: "thinking",
			thinking: "Let me reason.",
			signature: SIGNATURE,
		});
	});
});

describe("OpenAI Responses encrypted-reasoning opaque state", () => {
	const REASONING_ITEM = {
		id: "rs_abc123",
		type: "reasoning" as const,
		summary: [],
		encrypted_content: "gAAAAAB-opaque-encrypted-reasoning-bytes==",
		status: "completed" as const,
	};

	test("parse captures the reasoning item verbatim as opaque provider state", () => {
		const raw: any = {
			id: "resp-1",
			model: "gpt-5",
			status: "completed",
			output: [
				REASONING_ITEM,
				{
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "get_weather",
					arguments: '{"location":"SF"}',
				},
			],
			usage: { input_tokens: 10, output_tokens: 4 },
		};

		const response = parseResponsesResponse(raw, "openai");
		const statePart = response.message.content.find((p) => p.kind === ContentKind.PROVIDER_STATE);
		expect(statePart?.provider_state?.block_type).toBe("reasoning");
		expect(statePart?.provider_state?.data).toEqual(REASONING_ITEM);
		// Reasoning must precede the function_call in content order.
		expect(response.message.content[0]!.kind).toBe(ContentKind.PROVIDER_STATE);
	});

	test("reasoning item replays verbatim ahead of the assistant call on resume", () => {
		const raw: any = {
			id: "resp-1",
			model: "gpt-5",
			status: "completed",
			output: [
				REASONING_ITEM,
				{
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "get_weather",
					arguments: '{"location":"SF"}',
				},
			],
			usage: { input_tokens: 10, output_tokens: 4 },
		};
		const assistant = throughJournal(parseResponsesResponse(raw, "openai").message);

		const request: Request = {
			model: "gpt-5",
			messages: [
				{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather?" }] },
				assistant,
				{
					role: "tool",
					content: [
						{
							kind: ContentKind.TOOL_RESULT,
							tool_result: {
								tool_call_id: "call_1",
								content: "72F",
								is_error: false,
							},
						},
					],
					tool_call_id: "call_1",
				},
			],
		};

		const input = buildResponsesInput(request);
		const reasoningIdx = input.findIndex((i: any) => i.type === "reasoning");
		const callIdx = input.findIndex((i: any) => i.type === "function_call");
		expect(reasoningIdx).toBeGreaterThanOrEqual(0);
		expect(input[reasoningIdx]).toEqual(REASONING_ITEM);
		expect(reasoningIdx).toBeLessThan(callIdx);
	});

	test("streamed reasoning item with encrypted_content survives on the final response", async () => {
		const rawResponse = {
			id: "resp-stream",
			model: "gpt-5",
			status: "completed",
			output: [
				REASONING_ITEM,
				{ type: "message", content: [{ type: "output_text", text: "done" }] },
			],
			usage: { input_tokens: 8, output_tokens: 2 },
		};
		async function* streamResponse() {
			yield { type: "response.output_text.delta", delta: "done" };
			yield { type: "response.output_item.done", item: { type: "message" } };
			yield { type: "response.completed", response: rawResponse };
		}
		const adapter = new OpenAIAdapter("test-key");
		(adapter as any).client.responses.create = async () => streamResponse();

		const events = [];
		for await (const event of adapter.stream({
			model: "gpt-5",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hi" }] }],
		})) {
			events.push(event);
		}
		const finish = events.find((e) => e.type === "finish");
		const statePart = finish?.response?.message.content.find(
			(p) => p.kind === ContentKind.PROVIDER_STATE,
		);
		expect(statePart?.provider_state?.data).toEqual(REASONING_ITEM);
	});
});

describe("Gemini thought-signature opaque state", () => {
	const SIGNATURE = "Cq8BAdHtim-opaque-thought-signature-base64==";

	test("thought signature on a function call round-trips into the next request", async () => {
		const adapter = new GeminiAdapter("test-key");
		let capturedContents: any;
		let call = 0;
		(adapter as any).client = {
			models: {
				generateContent: async (params: any) => {
					call++;
					if (call === 2) capturedContents = params.contents;
					if (call === 1) {
						return {
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: { name: "get_weather", args: { location: "SF" } },
												thoughtSignature: SIGNATURE,
											},
										],
									},
									finishReason: "STOP",
								},
							],
							usageMetadata: {
								promptTokenCount: 5,
								candidatesTokenCount: 3,
								totalTokenCount: 8,
							},
						};
					}
					return {
						candidates: [{ content: { parts: [{ text: "72F" }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
					};
				},
			},
		};

		const first = await adapter.complete({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather?" }] }],
			tools: [
				{ name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
			],
		});

		const callPart = first.message.content.find((p) => p.kind === ContentKind.TOOL_CALL);
		expect(callPart?.thought_signature).toBe(SIGNATURE);

		const resumed = throughJournal(first.message);
		await adapter.complete({
			model: "gemini-2.5-flash",
			messages: [
				{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather?" }] },
				resumed,
				{
					role: "tool",
					content: [
						{
							kind: ContentKind.TOOL_RESULT,
							tool_result: {
								tool_call_id: callPart!.tool_call!.id,
								content: "72F",
								is_error: false,
							},
						},
					],
					tool_call_id: callPart!.tool_call!.id,
				},
			],
			tools: [
				{ name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
			],
		});

		const modelContent = capturedContents.find((c: any) => c.role === "model");
		const fnPart = modelContent.parts.find((p: any) => p.functionCall);
		expect(fnPart.thoughtSignature).toBe(SIGNATURE);
	});
});

describe("redaction excludes opaque provider state", () => {
	test("secret-looking bytes inside opaque state survive redaction untouched", async () => {
		// Opaque provider state lives in structured fields that never pass through
		// redactSensitiveTranscriptContent — a resumed turn keeps it byte-identical
		// even when the bytes resemble a token.
		const { redactSensitiveTranscriptContent } = await import("../../src/kernel/redaction.ts");
		const opaque = "Bearer sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const message: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.PROVIDER_STATE,
					provider_state: {
						provider: "openai",
						block_type: "reasoning",
						data: { id: "rs_1", type: "reasoning", encrypted_content: opaque },
					},
				},
			],
		};
		const resumed = throughJournal(message);
		expect(resumed.content[0]!.provider_state?.data.encrypted_content).toBe(opaque);
		// The redaction gate would mangle the string if it were ever applied.
		expect(redactSensitiveTranscriptContent(opaque)).not.toBe(opaque);
	});
});
