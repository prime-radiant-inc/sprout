import type { Message, Request, Response, ToolDefinition } from "../../llm/types.ts";

export const REPLAY_SCHEMA_VERSION = "sprout-replay-v1";

export type ReplaySchemaVersion = typeof REPLAY_SCHEMA_VERSION;

export type ReplayRequest = Omit<Request, "signal">;

export interface ReplayRequestContext {
	system_prompt: string;
	history: Message[];
	agent_tools: ToolDefinition[];
	primitive_tools: ToolDefinition[];
}

export interface ReplayTurnRecord {
	schema_version: ReplaySchemaVersion;
	timestamp: string;
	session_id: string;
	agent_id: string;
	depth: number;
	turn: number;
	request_context: ReplayRequestContext;
	request: ReplayRequest;
	response: Response;
}
