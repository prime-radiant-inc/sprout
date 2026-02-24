// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

export enum ContentKind {
	TEXT = "text",
	IMAGE = "image",
	TOOL_CALL = "tool_call",
	TOOL_RESULT = "tool_result",
	THINKING = "thinking",
	REDACTED_THINKING = "redacted_thinking",
}

export interface ContentPart {
	kind: ContentKind | string;
	text?: string;
	image?: ImageData;
	tool_call?: ToolCallData;
	tool_result?: ToolResultData;
	thinking?: ThinkingData;
}

export interface ImageData {
	url?: string;
	data?: Uint8Array;
	media_type?: string;
	detail?: "auto" | "low" | "high";
}

export interface ToolCallData {
	id: string;
	name: string;
	arguments: Record<string, unknown> | string;
}

export interface ToolResultData {
	tool_call_id: string;
	content: string | Record<string, unknown>;
	is_error: boolean;
}

export interface ThinkingData {
	text: string;
	signature?: string;
	redacted?: boolean;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool" | "developer";

export interface Message {
	role: Role;
	content: ContentPart[];
	name?: string;
	tool_call_id?: string;
}

/** Convenience constructors for common message shapes */
export const Msg = {
	system(text: string): Message {
		return { role: "system", content: [{ kind: ContentKind.TEXT, text }] };
	},
	user(text: string): Message {
		return { role: "user", content: [{ kind: ContentKind.TEXT, text }] };
	},
	assistant(text: string): Message {
		return { role: "assistant", content: [{ kind: ContentKind.TEXT, text }] };
	},
	toolResult(toolCallId: string, content: string, isError = false): Message {
		return {
			role: "tool",
			content: [
				{
					kind: ContentKind.TOOL_RESULT,
					tool_result: { tool_call_id: toolCallId, content, is_error: isError },
				},
			],
			tool_call_id: toolCallId,
		};
	},
};

/** Extract concatenated text from all text parts in a message */
export function messageText(msg: Message): string {
	return msg.content
		.filter((p) => p.kind === ContentKind.TEXT)
		.map((p) => p.text ?? "")
		.join("");
}

/** Extract tool calls from a message */
export function messageToolCalls(msg: Message): ToolCall[] {
	return msg.content
		.filter((p) => p.kind === ContentKind.TOOL_CALL && p.tool_call)
		.map((p) => ({
			id: p.tool_call!.id,
			name: p.tool_call!.name,
			arguments:
				typeof p.tool_call!.arguments === "string"
					? JSON.parse(p.tool_call!.arguments)
					: p.tool_call!.arguments,
		}));
}

/** Extract reasoning/thinking text from a message */
export function messageReasoning(msg: Message): string | undefined {
	const parts = msg.content
		.filter((p) => p.kind === ContentKind.THINKING && p.thinking)
		.map((p) => p.thinking!.text);
	return parts.length > 0 ? parts.join("") : undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

export interface Request {
	model: string;
	messages: Message[];
	provider?: string;
	system?: string;
	tools?: ToolDefinition[];
	tool_choice?: "auto" | "none" | "required" | { name: string };
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stop_sequences?: string[];
	reasoning_effort?: "low" | "medium" | "high";
	provider_options?: Record<string, unknown>;
}

export interface FinishReason {
	reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";
	raw?: string;
}

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	reasoning_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
}

export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input_tokens: a.input_tokens + b.input_tokens,
		output_tokens: a.output_tokens + b.output_tokens,
		total_tokens: a.total_tokens + b.total_tokens,
		reasoning_tokens: addOptional(a.reasoning_tokens, b.reasoning_tokens),
		cache_read_tokens: addOptional(a.cache_read_tokens, b.cache_read_tokens),
		cache_write_tokens: addOptional(a.cache_write_tokens, b.cache_write_tokens),
	};
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined && b === undefined) return undefined;
	return (a ?? 0) + (b ?? 0);
}

export interface Response {
	id: string;
	model: string;
	provider: string;
	message: Message;
	finish_reason: FinishReason;
	usage: Usage;
	raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamEventType =
	| "stream_start"
	| "text_start"
	| "text_delta"
	| "text_end"
	| "reasoning_start"
	| "reasoning_delta"
	| "reasoning_end"
	| "tool_call_start"
	| "tool_call_delta"
	| "tool_call_end"
	| "finish"
	| "error";

export interface StreamEvent {
	type: StreamEventType;
	delta?: string;
	reasoning_delta?: string;
	tool_call?: Partial<ToolCall>;
	finish_reason?: FinishReason;
	usage?: Usage;
	response?: Response;
	error?: Error;
}

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
	name: string;
	complete(request: Request): Promise<Response>;
	stream(request: Request): AsyncIterable<StreamEvent>;
}
