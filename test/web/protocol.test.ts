import { describe, expect, test } from "bun:test";
import type { Command, SessionEvent } from "../../src/kernel/types.ts";
import type {
	CommandMessage as CanonicalCommandMessage,
	ServerMessage as CanonicalServerMessage,
} from "../../src/kernel/protocol.ts";
import {
	createCommandMessage,
	parseCommandMessage as parseCanonicalCommandMessage,
} from "../../src/kernel/protocol.ts";
import type { CommandMessage, ServerMessage } from "../../src/web/protocol.ts";
import { parseCommandMessage as parseLegacyCommandMessage } from "../../src/web/protocol.ts";

describe("web protocol types", () => {
	test("ServerMessage event variant wraps a SessionEvent", () => {
		const event: SessionEvent = {
			kind: "plan_start",
			timestamp: Date.now(),
			agent_id: "root",
			depth: 0,
			data: { model: "claude-sonnet-4-6" },
		};
		const msg: ServerMessage = { type: "event", event };
		expect(msg.type).toBe("event");
		expect(msg.event.kind).toBe("plan_start");
		expect(msg.event.agent_id).toBe("root");
	});

	test("ServerMessage snapshot variant carries events and session info", () => {
		const events: SessionEvent[] = [
			{
				kind: "session_start",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: {},
			},
			{
				kind: "perceive",
				timestamp: 1001,
				agent_id: "root",
				depth: 0,
				data: { goal: "fix bug" },
			},
		];
		const msg: ServerMessage = {
			type: "snapshot",
			events,
			session: { id: "sess-1", status: "running", availableModels: [], currentModel: null },
		};
		expect(msg.type).toBe("snapshot");
		expect(msg.events).toHaveLength(2);
		expect(msg.session.id).toBe("sess-1");
		expect(msg.session.status).toBe("running");
	});

	test("CommandMessage wraps a Command", () => {
		const command: Command = {
			kind: "submit_goal",
			data: { goal: "Write tests" },
		};
		const msg: CommandMessage = { type: "command", command };
		expect(msg.type).toBe("command");
		expect(msg.command.kind).toBe("submit_goal");
		expect(msg.command.data.goal).toBe("Write tests");
	});
});

describe("canonical protocol module", () => {
	test("createCommandMessage produces a valid command envelope", () => {
		const command: Command = { kind: "interrupt", data: {} };
		const msg = createCommandMessage(command);
		expect(msg).toEqual({
			type: "command",
			command,
		});
	});

	test("canonical and legacy protocol types are structurally compatible", () => {
		const command: Command = { kind: "quit", data: {} };
		const canonicalCommandMessage: CanonicalCommandMessage = createCommandMessage(command);
		const legacyCommandMessage: CommandMessage = canonicalCommandMessage;
		expect(legacyCommandMessage.type).toBe("command");

		const event: SessionEvent = {
			kind: "plan_start",
			timestamp: Date.now(),
			agent_id: "root",
			depth: 0,
			data: {},
		};
		const canonicalServerMessage: CanonicalServerMessage = { type: "event", event };
		const legacyServerMessage: ServerMessage = canonicalServerMessage;
		expect(legacyServerMessage.type).toBe("event");
	});

	test("canonical parser accepts the same valid payloads as legacy parser", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "submit_goal", data: { goal: "Fix the bug" } },
		});
		expect(parseCanonicalCommandMessage(raw)).toEqual(parseLegacyCommandMessage(raw));
	});
});

describe("parseCommandMessage", () => {
	test("parses a valid submit_goal command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "submit_goal", data: { goal: "Fix the bug" } },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.type).toBe("command");
		expect(msg.command.kind).toBe("submit_goal");
		expect(msg.command.data.goal).toBe("Fix the bug");
	});

	test("parses a valid steer command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "steer", data: { message: "Focus on auth" } },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.command.kind).toBe("steer");
		expect(msg.command.data.message).toBe("Focus on auth");
	});

	test("parses a valid interrupt command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "interrupt", data: {} },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.command.kind).toBe("interrupt");
	});

	test("parses a valid quit command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit", data: {} },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.command.kind).toBe("quit");
	});

	test("throws when command.kind is unknown", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "custom_thing", data: { foo: "bar" } },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("Unknown command kind");
	});

	test("throws on invalid JSON", () => {
		expect(() => parseLegacyCommandMessage("not json{")).toThrow("Invalid JSON");
	});

	test("throws on non-object JSON (string)", () => {
		expect(() => parseLegacyCommandMessage('"just a string"')).toThrow("must be a JSON object");
	});

	test("throws on non-object JSON (array)", () => {
		expect(() => parseLegacyCommandMessage("[1, 2, 3]")).toThrow("must be a JSON object");
	});

	test("throws on null JSON", () => {
		expect(() => parseLegacyCommandMessage("null")).toThrow("must be a JSON object");
	});

	test("throws on missing type field", () => {
		const raw = JSON.stringify({
			command: { kind: "quit", data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("type");
	});

	test("throws on wrong type field value", () => {
		const raw = JSON.stringify({
			type: "event",
			command: { kind: "quit", data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("type");
	});

	test("throws on missing command field", () => {
		const raw = JSON.stringify({ type: "command" });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is not an object", () => {
		const raw = JSON.stringify({ type: "command", command: "quit" });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is null", () => {
		const raw = JSON.stringify({ type: "command", command: null });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is an array", () => {
		const raw = JSON.stringify({ type: "command", command: [1, 2] });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command.kind is missing", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("kind");
	});

	test("throws when command.kind is not a string", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: 42, data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("kind");
	});

	test("throws when command.data is missing", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit" },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("data");
	});

	test("throws when command.data is not an object", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit", data: "not-an-object" },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("data");
	});
});
