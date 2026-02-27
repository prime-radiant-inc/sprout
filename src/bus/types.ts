import type { SessionEvent } from "../kernel/types.ts";

/** Identity of the agent that initiated a message */
export interface CallerIdentity {
	agent_name: string;
	depth: number;
}

/** Sent to a new agent's inbox to start it */
export interface StartMessage {
	kind: "start";
	handle_id: string;
	agent_name: string;
	genome_path: string;
	session_id: string;
	caller: CallerIdentity;
	goal: string;
	hints?: string[];
	shared: boolean;
	/** Override agent_id for events. Used to pass parent-assigned ULID to child. */
	agent_id?: string;
}

/** Sent to a completed/idle agent to continue conversation */
export interface ContinueMessage {
	kind: "continue";
	message: string;
	caller: CallerIdentity;
}

/** Injected between turns of a running agent */
export interface SteerMessage {
	kind: "steer";
	message: string;
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
	| ResultMessage
	| EventMessage;

const VALID_KINDS = new Set(["start", "continue", "steer", "result", "event"]);

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
				"agent_name",
				"genome_path",
				"session_id",
				"caller",
				"goal",
				"shared",
			]);
			validateCallerIdentity(obj);
			break;
		case "continue":
			requireFields(obj, ["message", "caller"]);
			validateCallerIdentity(obj);
			break;
		case "steer":
			requireFields(obj, ["message"]);
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

function validateCallerIdentity(obj: Record<string, unknown>): void {
	const caller = obj.caller;
	if (caller === null || typeof caller !== "object" || Array.isArray(caller)) {
		throw new Error("'caller' must be an object with agent_name (string) and depth (number)");
	}
	const c = caller as Record<string, unknown>;
	if (typeof c.agent_name !== "string" || typeof c.depth !== "number") {
		throw new Error("'caller' must have agent_name (string) and depth (number)");
	}
}

function requireFields(obj: Record<string, unknown>, fields: string[]): void {
	for (const field of fields) {
		if (!(field in obj) || obj[field] === undefined) {
			throw new Error(`Missing required field "${field}" for ${obj.kind} message`);
		}
	}
}
