import type { ResolverSettings } from "../agents/model-resolver.ts";
import type { SessionEvent } from "../kernel/types.ts";

/** Runtime address for an agent handle. Field names carry meaning at call sites. */
export interface AgentAddress {
	agentName: string;
	depth: number;
	handleId: string;
	agentId: string;
	role?: "observer";
}

export function rootAgentAddress(): AgentAddress {
	return {
		agentName: "root",
		depth: 0,
		handleId: "root",
		agentId: "root",
	};
}

/** Sent to a new agent's inbox to start it */
export interface StartMessage {
	kind: "start";
	handle_id: string;
	genome_path: string;
	session_id: string;
	self: AgentAddress;
	caller: AgentAddress;
	goal: string;
	hints?: string[];
	shared: boolean;
	eval_mode?: boolean;
	/** Selected provider context inherited from the caller. */
	provider_id?: string;
	/** Provider tier defaults and enabled-provider state inherited from the caller. */
	resolver_settings?: ResolverSettings;
	/** Original user instruction, trusted for deterministic runtime policy gates. */
	trusted_user_instruction?: string;
	/** Precomputed memory context inherited from the root session. Empty string suppresses it. */
	surfaced_memory_block?: string;
}

/** Sent to a completed/idle agent to continue conversation */
export interface ContinueMessage {
	kind: "continue";
	message: string;
	caller: AgentAddress;
	/** Current trusted user instruction for deterministic runtime policy gates. */
	trusted_user_instruction?: string;
}

/** Injected between turns of a running agent */
export interface SteerMessage {
	kind: "steer";
	message: string;
	/** Current trusted user instruction for deterministic runtime policy gates. */
	trusted_user_instruction?: string;
}

/** Agent-originated guidance injected between turns without becoming user steering. */
export interface AgentMessageMessage {
	kind: "agent_message";
	message: string;
	from: AgentAddress;
	to: AgentAddress;
	/** Optional topic the receiver publishes to after successful delivery. */
	ack_topic?: string;
}

/** Published by an agent on completion */
export interface ResultMessage {
	kind: "result";
	handle_id: string;
	output: string;
	success: boolean;
	stumbles: number;
	turns: number;
	timed_out: boolean;
}

/** Published by an agent throughout execution */
export interface EventMessage {
	kind: "event";
	handle_id: string;
	event: SessionEvent;
}

/** Union of all bus message types */
export type BusMessage =
	| StartMessage
	| ContinueMessage
	| SteerMessage
	| AgentMessageMessage
	| ResultMessage
	| EventMessage;

const VALID_KINDS = new Set(["start", "continue", "steer", "agent_message", "result", "event"]);

/** Parse a JSON string into a validated BusMessage. Throws on invalid input. */
export function parseBusMessage(raw: string): BusMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid JSON: ${raw.slice(0, 100)}`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Bus message must be a JSON object");
	}

	const obj = parsed as Record<string, unknown>;

	if (typeof obj.kind !== "string" || !VALID_KINDS.has(obj.kind)) {
		throw new Error(
			`Invalid or missing kind: ${JSON.stringify(obj.kind)}. Expected one of: ${[...VALID_KINDS].join(", ")}`,
		);
	}

	switch (obj.kind) {
		case "start":
			requireFields(obj, [
				"handle_id",
				"genome_path",
				"session_id",
				"self",
				"caller",
				"goal",
				"shared",
			]);
			validateAgentAddress(obj, "self");
			validateAgentAddress(obj, "caller");
			validateOptionalString(obj, "trusted_user_instruction");
			validateOptionalString(obj, "surfaced_memory_block");
			break;
		case "continue":
			requireFields(obj, ["message", "caller"]);
			validateAgentAddress(obj, "caller");
			validateOptionalString(obj, "trusted_user_instruction");
			break;
		case "steer":
			requireFields(obj, ["message"]);
			validateOptionalString(obj, "trusted_user_instruction");
			break;
		case "agent_message":
			requireFields(obj, ["message", "from", "to"]);
			validateAgentAddress(obj, "from");
			validateAgentAddress(obj, "to");
			validateOptionalString(obj, "ack_topic");
			break;
		case "result":
			requireFields(obj, ["handle_id", "output", "success", "stumbles", "turns", "timed_out"]);
			break;
		case "event":
			requireFields(obj, ["handle_id", "event"]);
			break;
	}

	return obj as unknown as BusMessage;
}

function validateOptionalString(obj: Record<string, unknown>, field: string): void {
	if (field in obj && obj[field] !== undefined && typeof obj[field] !== "string") {
		throw new Error(`'${field}' must be a string when present`);
	}
}

function validateAgentAddress(obj: Record<string, unknown>, field: string): void {
	const value = obj[field];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`'${field}' must be an object with agentName, depth, handleId, and agentId`);
	}
	const address = value as Record<string, unknown>;
	if (
		typeof address.agentName !== "string" ||
		typeof address.depth !== "number" ||
		typeof address.handleId !== "string" ||
		typeof address.agentId !== "string"
	) {
		throw new Error(
			`'${field}' must have agentName (string), depth (number), handleId (string), and agentId (string)`,
		);
	}
	if (address.role !== undefined && address.role !== "observer") {
		throw new Error(`'${field}.role' must be observer when present`);
	}
}

function requireFields(obj: Record<string, unknown>, fields: string[]): void {
	for (const field of fields) {
		if (!(field in obj) || obj[field] === undefined) {
			throw new Error(`Missing required field "${field}" for ${obj.kind} message`);
		}
	}
}
