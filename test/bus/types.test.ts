import { describe, expect, test } from "bun:test";
import type {
	AgentAddress,
	AgentMessageMessage,
	ContinueMessage,
	EventMessage,
	ResultMessage,
	StartMessage,
	SteerMessage,
} from "../../src/bus/types.ts";
import { parseBusMessage, rootAgentAddress } from "../../src/bus/types.ts";
import { addr } from "../helpers/agent-address.ts";

describe("bus message types", () => {
	test("AgentAddress carries exact runtime identity", () => {
		const caller: AgentAddress = addr("root", 0);
		expect(caller.agentName).toBe("root");
		expect(caller.depth).toBe(0);
		expect(caller.handleId).toBe("root");
		expect(caller.agentId).toBe("root");
	});

	test("rootAgentAddress preserves custom root spec identity on the root handle", () => {
		expect(rootAgentAddress("editor")).toEqual({
			agentName: "editor",
			depth: 0,
			handleId: "root",
			agentId: "root",
		});
	});
});

describe("parseBusMessage", () => {
	test("parses a valid StartMessage", () => {
		const raw = JSON.stringify({
			kind: "start",
			handle_id: "h1",
			self: addr("editor", 1, undefined, "h1", "h1"),
			genome_path: "/g",
			session_id: "s1",
			caller: addr("root", 0),
			goal: "do stuff",
			shared: false,
			trusted_user_instruction: "current trusted instruction",
			surfaced_memory_block: "<memory_context>cached</memory_context>",
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("start");
		expect((msg as StartMessage).goal).toBe("do stuff");
		expect((msg as StartMessage).trusted_user_instruction).toBe("current trusted instruction");
		expect((msg as StartMessage).surfaced_memory_block).toBe(
			"<memory_context>cached</memory_context>",
		);
	});

	test("parses a valid ContinueMessage", () => {
		const raw = JSON.stringify({
			kind: "continue",
			message: "keep going",
			caller: addr("root", 0),
			trusted_user_instruction: "current trusted instruction",
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("continue");
		expect((msg as ContinueMessage).message).toBe("keep going");
		expect((msg as ContinueMessage).trusted_user_instruction).toBe("current trusted instruction");
	});

	test("parses a valid SteerMessage", () => {
		const raw = JSON.stringify({
			kind: "steer",
			message: "focus on tests",
			trusted_user_instruction: "current trusted instruction",
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("steer");
		expect((msg as SteerMessage).message).toBe("focus on tests");
		expect((msg as SteerMessage).trusted_user_instruction).toBe("current trusted instruction");
	});

	test("parses a valid AgentMessageMessage", () => {
		const raw = JSON.stringify({
			kind: "agent_message",
			message: "observer guidance",
			from: addr("metacognitive", 1, "observer"),
			to: addr("root", 0),
			ack_topic: "session/s1/agent-message-ack/m1",
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("agent_message");
		expect((msg as AgentMessageMessage).message).toBe("observer guidance");
		expect((msg as AgentMessageMessage).from.agentName).toBe("metacognitive");
		expect((msg as AgentMessageMessage).from.role).toBe("observer");
		expect((msg as AgentMessageMessage).ack_topic).toContain("agent-message-ack");
	});

	test("parses a valid ResultMessage", () => {
		const raw = JSON.stringify({
			kind: "result",
			handle_id: "h1",
			output: "done",
			success: true,
			stumbles: 0,
			turns: 5,
			timed_out: false,
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("result");
		expect((msg as ResultMessage).turns).toBe(5);
	});

	test("parses a valid EventMessage", () => {
		const raw = JSON.stringify({
			kind: "event",
			handle_id: "h1",
			event: {
				kind: "plan_start",
				timestamp: 12345,
				agent_id: "editor",
				depth: 1,
				data: {},
			},
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("event");
		expect((msg as EventMessage).event.timestamp).toBe(12345);
	});

	test("throws on invalid JSON", () => {
		expect(() => parseBusMessage("not json")).toThrow();
	});

	test("throws on non-object JSON", () => {
		expect(() => parseBusMessage('"just a string"')).toThrow();
	});

	test("throws on null JSON", () => {
		expect(() => parseBusMessage("null")).toThrow();
	});

	test("throws on missing kind field", () => {
		expect(() => parseBusMessage('{"handle_id": "h1"}')).toThrow("kind");
	});

	test("throws on unknown kind", () => {
		expect(() => parseBusMessage('{"kind": "destroy"}')).toThrow("kind");
	});

	test("throws on missing required StartMessage fields", () => {
		const partial = JSON.stringify({ kind: "start", handle_id: "h1" });
		expect(() => parseBusMessage(partial)).toThrow();
	});

	test("throws on non-string optional StartMessage memory fields", () => {
		const base = {
			kind: "start",
			handle_id: "h1",
			self: addr("editor", 1, undefined, "h1", "h1"),
			genome_path: "/g",
			session_id: "s1",
			caller: addr("root", 0),
			goal: "do stuff",
			shared: false,
		};
		expect(() =>
			parseBusMessage(JSON.stringify({ ...base, trusted_user_instruction: 123 })),
		).toThrow("trusted_user_instruction");
		expect(() =>
			parseBusMessage(JSON.stringify({ ...base, surfaced_memory_block: { text: "bad" } })),
		).toThrow("surfaced_memory_block");
	});

	test("throws on missing required ContinueMessage fields", () => {
		const partial = JSON.stringify({ kind: "continue" });
		expect(() => parseBusMessage(partial)).toThrow();
	});

	test("throws on missing required SteerMessage fields", () => {
		const partial = JSON.stringify({ kind: "steer" });
		expect(() => parseBusMessage(partial)).toThrow();
	});

	test("throws on missing required AgentMessageMessage fields", () => {
		expect(() => parseBusMessage(JSON.stringify({ kind: "agent_message" }))).toThrow();
		expect(() => parseBusMessage(JSON.stringify({ kind: "agent_message", message: "hi" }))).toThrow(
			/from/,
		);
	});

	test("throws on non-string optional SteerMessage trusted instruction", () => {
		const partial = JSON.stringify({
			kind: "steer",
			message: "focus",
			trusted_user_instruction: false,
		});
		expect(() => parseBusMessage(partial)).toThrow("trusted_user_instruction");
	});

	test("throws on missing required ResultMessage fields", () => {
		const partial = JSON.stringify({ kind: "result", handle_id: "h1" });
		expect(() => parseBusMessage(partial)).toThrow();
	});

	test("throws on missing required EventMessage fields", () => {
		const partial = JSON.stringify({ kind: "event" });
		expect(() => parseBusMessage(partial)).toThrow();
	});

	test("throws on start message with non-object caller", () => {
		const raw = JSON.stringify({
			kind: "start",
			handle_id: "H1",
			self: addr("editor", 1, undefined, "H1", "H1"),
			genome_path: "/tmp",
			session_id: "S1",
			caller: "not-an-object",
			goal: "fix",
			shared: false,
		});
		expect(() => parseBusMessage(raw)).toThrow(/caller/);
	});

	test("throws on start message with caller missing agentName", () => {
		const raw = JSON.stringify({
			kind: "start",
			handle_id: "H1",
			self: addr("editor", 1, undefined, "H1", "H1"),
			genome_path: "/tmp",
			session_id: "S1",
			caller: { depth: 0 },
			goal: "fix",
			shared: false,
		});
		expect(() => parseBusMessage(raw)).toThrow(/caller/);
	});

	test("throws on continue message with invalid caller", () => {
		const raw = JSON.stringify({
			kind: "continue",
			message: "do more",
			caller: null,
		});
		expect(() => parseBusMessage(raw)).toThrow(/caller/);
	});

	test("start/continue/agent_message accept an optional env map of alias → ulid", () => {
		const env = { api_schema: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
		const start = parseBusMessage(
			JSON.stringify({
				kind: "start",
				handle_id: "H1",
				self: addr("editor", 1, undefined, "H1", "H1"),
				genome_path: "/tmp",
				session_id: "S1",
				caller: addr("root", 0),
				goal: "fix",
				shared: false,
				env,
			}),
		);
		expect((start as { env?: Record<string, string> }).env).toEqual(env);
		const cont = parseBusMessage(
			JSON.stringify({ kind: "continue", message: "more", caller: addr("root", 0), env }),
		);
		expect((cont as { env?: Record<string, string> }).env).toEqual(env);
		const agentMsg = parseBusMessage(
			JSON.stringify({
				kind: "agent_message",
				message: "hi",
				from: addr("a", 1),
				to: addr("b", 1),
				env,
			}),
		);
		expect((agentMsg as { env?: Record<string, string> }).env).toEqual(env);
	});

	test("throws on env that is not a string-to-string map", () => {
		const base = { kind: "continue", message: "more", caller: addr("root", 0) };
		expect(() => parseBusMessage(JSON.stringify({ ...base, env: "nope" }))).toThrow(/env/);
		expect(() => parseBusMessage(JSON.stringify({ ...base, env: ["x"] }))).toThrow(/env/);
		expect(() => parseBusMessage(JSON.stringify({ ...base, env: { a: 7 } }))).toThrow(/env/);
	});

	test("throws on address with invalid role", () => {
		const raw = JSON.stringify({
			kind: "agent_message",
			message: "bad role",
			from: { ...addr("metacognitive", 1), role: "delegate" },
			to: addr("root", 0),
		});
		expect(() => parseBusMessage(raw)).toThrow(/from\.role/);
	});
});
