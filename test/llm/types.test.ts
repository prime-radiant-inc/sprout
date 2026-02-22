import { describe, expect, test } from "bun:test";
import {
	ContentKind,
	type FinishReason,
	type Message,
	type Request,
	type Response,
	type StreamEventType,
	type ToolCall,
	type ToolDefinition,
	type Usage,
} from "../../src/llm/types.ts";

describe("LLM types", () => {
	test("Message can be constructed with role and content parts", () => {
		const msg: Message = {
			role: "user",
			content: [{ kind: ContentKind.TEXT, text: "Hello" }],
		};
		expect(msg.role).toBe("user");
		expect(msg.content[0]!.text).toBe("Hello");
	});

	test("Message convenience constructors create proper messages", async () => {
		const { Msg } = await import("../../src/llm/types.ts");
		const sys = Msg.system("You are helpful");
		expect(sys.role).toBe("system");
		expect(sys.content[0]!.text).toBe("You are helpful");

		const user = Msg.user("What is 2+2?");
		expect(user.role).toBe("user");

		const assistant = Msg.assistant("4");
		expect(assistant.role).toBe("assistant");

		const tool = Msg.toolResult("call_123", "72F and sunny");
		expect(tool.role).toBe("tool");
		expect(tool.tool_call_id).toBe("call_123");
	});

	test("Message.text accessor concatenates text parts", async () => {
		const { messageText } = await import("../../src/llm/types.ts");
		const msg: Message = {
			role: "assistant",
			content: [
				{ kind: ContentKind.TEXT, text: "Hello " },
				{ kind: ContentKind.TOOL_CALL, tool_call: { id: "1", name: "fn", arguments: {} } },
				{ kind: ContentKind.TEXT, text: "world" },
			],
		};
		expect(messageText(msg)).toBe("Hello world");
	});

	test("ContentKind covers all required kinds", () => {
		const kinds = [
			ContentKind.TEXT,
			ContentKind.IMAGE,
			ContentKind.TOOL_CALL,
			ContentKind.TOOL_RESULT,
			ContentKind.THINKING,
			ContentKind.REDACTED_THINKING,
		];
		expect(kinds).toHaveLength(6);
	});

	test("ToolDefinition has name, description, and parameters", () => {
		const tool: ToolDefinition = {
			name: "get_weather",
			description: "Get current weather",
			parameters: {
				type: "object",
				properties: {
					location: { type: "string" },
				},
				required: ["location"],
			},
		};
		expect(tool.name).toBe("get_weather");
	});

	test("ToolCall captures id, name, and arguments", () => {
		const call: ToolCall = {
			id: "call_abc",
			name: "get_weather",
			arguments: { location: "San Francisco" },
		};
		expect(call.id).toBe("call_abc");
	});

	test("Usage supports addition", async () => {
		const { addUsage } = await import("../../src/llm/types.ts");
		const a: Usage = {
			input_tokens: 100,
			output_tokens: 50,
			total_tokens: 150,
		};
		const b: Usage = {
			input_tokens: 200,
			output_tokens: 100,
			total_tokens: 300,
			reasoning_tokens: 50,
			cache_read_tokens: 80,
		};
		const sum = addUsage(a, b);
		expect(sum.input_tokens).toBe(300);
		expect(sum.output_tokens).toBe(150);
		expect(sum.total_tokens).toBe(450);
		expect(sum.reasoning_tokens).toBe(50);
		expect(sum.cache_read_tokens).toBe(80);
	});

	test("Usage addition treats undefined + number as number", async () => {
		const { addUsage } = await import("../../src/llm/types.ts");
		const a: Usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
		const b: Usage = {
			input_tokens: 20,
			output_tokens: 10,
			total_tokens: 30,
			cache_write_tokens: 100,
		};
		const sum = addUsage(a, b);
		expect(sum.cache_write_tokens).toBe(100);
	});

	test("FinishReason carries unified reason and raw provider value", () => {
		const reason: FinishReason = { reason: "stop", raw: "end_turn" };
		expect(reason.reason).toBe("stop");
		expect(reason.raw).toBe("end_turn");
	});

	test("Request contains model, messages, and optional tools", () => {
		const req: Request = {
			model: "claude-opus-4-6",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "Hi" }] }],
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "auto",
		};
		expect(req.model).toBe("claude-opus-4-6");
		expect(req.tools).toHaveLength(1);
	});

	test("Response contains message, usage, and finish reason", () => {
		const resp: Response = {
			id: "resp_1",
			model: "claude-opus-4-6",
			provider: "anthropic",
			message: {
				role: "assistant",
				content: [{ kind: ContentKind.TEXT, text: "Hello" }],
			},
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		};
		expect(resp.provider).toBe("anthropic");
	});

	test("StreamEvent types cover the start/delta/end pattern", () => {
		const types: StreamEventType[] = [
			"stream_start",
			"text_start",
			"text_delta",
			"text_end",
			"reasoning_start",
			"reasoning_delta",
			"reasoning_end",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_end",
			"finish",
			"error",
		];
		expect(types).toHaveLength(12);
	});
});
