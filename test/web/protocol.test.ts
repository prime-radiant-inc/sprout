import { describe, expect, test } from "bun:test";
import type { Command, SessionEvent } from "../../src/kernel/types.ts";
import type { CommandMessage, ServerMessage } from "../../src/web/protocol.ts";
import { parseCommandMessage } from "../../src/web/protocol.ts";

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
			session: { id: "sess-1", status: "running" },
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

describe("parseCommandMessage", () => {
	test("parses a valid submit_goal command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "submit_goal", data: { goal: "Fix the bug" } },
		});
		const msg = parseCommandMessage(raw);
		expect(msg.type).toBe("command");
		expect(msg.command.kind).toBe("submit_goal");
		expect(msg.command.data.goal).toBe("Fix the bug");
	});

	test("parses a valid steer command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "steer", data: { message: "Focus on auth" } },
		});
		const msg = parseCommandMessage(raw);
		expect(msg.command.kind).toBe("steer");
		expect(msg.command.data.message).toBe("Focus on auth");
	});

	test("parses a valid interrupt command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "interrupt", data: {} },
		});
		const msg = parseCommandMessage(raw);
		expect(msg.command.kind).toBe("interrupt");
	});

	test("parses a valid quit command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit", data: {} },
		});
		const msg = parseCommandMessage(raw);
		expect(msg.command.kind).toBe("quit");
	});

	test("unknown command kinds pass through", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "custom_thing", data: { foo: "bar" } },
		});
		const msg = parseCommandMessage(raw);
		// Cast to string — the runtime parser accepts any kind string,
		// even though the TypeScript type narrows to CommandKind
		expect(msg.command.kind as string).toBe("custom_thing");
		expect(msg.command.data.foo).toBe("bar");
	});

	test("throws on invalid JSON", () => {
		expect(() => parseCommandMessage("not json{")).toThrow("Invalid JSON");
	});

	test("throws on non-object JSON (string)", () => {
		expect(() => parseCommandMessage('"just a string"')).toThrow("must be a JSON object");
	});

	test("throws on non-object JSON (array)", () => {
		expect(() => parseCommandMessage("[1, 2, 3]")).toThrow("must be a JSON object");
	});

	test("throws on null JSON", () => {
		expect(() => parseCommandMessage("null")).toThrow("must be a JSON object");
	});

	test("throws on missing type field", () => {
		const raw = JSON.stringify({
			command: { kind: "quit", data: {} },
		});
		expect(() => parseCommandMessage(raw)).toThrow("type");
	});

	test("throws on wrong type field value", () => {
		const raw = JSON.stringify({
			type: "event",
			command: { kind: "quit", data: {} },
		});
		expect(() => parseCommandMessage(raw)).toThrow("type");
	});

	test("throws on missing command field", () => {
		const raw = JSON.stringify({ type: "command" });
		expect(() => parseCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is not an object", () => {
		const raw = JSON.stringify({ type: "command", command: "quit" });
		expect(() => parseCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is null", () => {
		const raw = JSON.stringify({ type: "command", command: null });
		expect(() => parseCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is an array", () => {
		const raw = JSON.stringify({ type: "command", command: [1, 2] });
		expect(() => parseCommandMessage(raw)).toThrow("command");
	});

	test("throws when command.kind is missing", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { data: {} },
		});
		expect(() => parseCommandMessage(raw)).toThrow("kind");
	});

	test("throws when command.kind is not a string", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: 42, data: {} },
		});
		expect(() => parseCommandMessage(raw)).toThrow("kind");
	});

	test("throws when command.data is missing", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit" },
		});
		expect(() => parseCommandMessage(raw)).toThrow("data");
	});

	test("throws when command.data is not an object", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit", data: "not-an-object" },
		});
		expect(() => parseCommandMessage(raw)).toThrow("data");
	});
});
