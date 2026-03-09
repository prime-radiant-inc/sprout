import type { PricingTable } from "./pricing.ts";
import type { Command, SessionEvent } from "./types.ts";

/** Server -> Browser: a single live event */
export interface EventServerMessage {
	type: "event";
	event: SessionEvent;
}

/** Server -> Browser: full state snapshot on initial connection */
export interface SnapshotServerMessage {
	type: "snapshot";
	events: SessionEvent[];
	session: {
		id: string;
		status: string;
		availableModels: string[];
		currentModel: string | null;
		pricingTable: PricingTable | null;
	};
}

/** All message types the server sends to the browser */
export type ServerMessage = EventServerMessage | SnapshotServerMessage;

/** Browser -> Server: a user command */
export interface CommandMessage {
	type: "command";
	command: Command;
}

const VALID_COMMAND_KINDS = new Set<Command["kind"]>([
	"submit_goal",
	"steer",
	"interrupt",
	"compact",
	"clear",
	"switch_model",
	"quit",
]);

/** Build a command envelope for transport from browser to server. */
export function createCommandMessage(command: Command): CommandMessage {
	return { type: "command", command };
}

/**
 * Parse a raw JSON string into a validated CommandMessage.
 * Validates structure and command kind.
 * Throws on invalid JSON, missing fields, or wrong types.
 */
export function parseCommandMessage(raw: string): CommandMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid JSON: ${raw.slice(0, 100)}`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Command message must be a JSON object");
	}

	const obj = parsed as Record<string, unknown>;

	if (obj.type !== "command") {
		throw new Error(`Invalid or missing type: ${JSON.stringify(obj.type)}. Expected "command"`);
	}

	const command = obj.command;
	if (command === null || typeof command !== "object" || Array.isArray(command)) {
		throw new Error("'command' must be an object with kind (string) and data (object)");
	}

	const cmd = command as Record<string, unknown>;

	if (typeof cmd.kind !== "string") {
		throw new Error(`'command.kind' must be a string, got ${JSON.stringify(cmd.kind)}`);
	}
	if (!VALID_COMMAND_KINDS.has(cmd.kind as Command["kind"])) {
		throw new Error(`Unknown command kind: ${JSON.stringify(cmd.kind)}`);
	}

	if (cmd.data === null || typeof cmd.data !== "object" || Array.isArray(cmd.data)) {
		throw new Error("'command.data' must be an object");
	}

	return obj as unknown as CommandMessage;
}
