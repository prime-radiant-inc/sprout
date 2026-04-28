import { describe, expect, test } from "bun:test";
import type {
	AgentAddress,
	AgentMessageMessage,
	BusMessage,
	ContinueMessage,
	EventMessage,
	ResultMessage,
	StartMessage,
	SteerMessage,
} from "../../src/bus/types.ts";
import { parseBusMessage, rootAgentAddress } from "../../src/bus/types.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
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

	test("StartMessage has all required fields", () => {
		const msg: StartMessage = {
			kind: "start",
			handle_id: "01JTEST000000000000000001",
			self: addr(
				"code-editor",
				1,
				undefined,
				"01JTEST000000000000000001",
				"01JTEST000000000000000001",
			),
			genome_path: "/tmp/genome",
			session_id: "session-1",
			caller: addr("root", 0),
			goal: "Fix the bug",
			shared: false,
		};
		expect(msg.kind).toBe("start");
		expect(msg.handle_id).toBe("01JTEST000000000000000001");
		expect(msg.self.agentName).toBe("code-editor");
		expect(msg.genome_path).toBe("/tmp/genome");
		expect(msg.session_id).toBe("session-1");
		expect(msg.caller.agentName).toBe("root");
		expect(msg.goal).toBe("Fix the bug");
		expect(msg.shared).toBe(false);
		expect(msg.hints).toBeUndefined();
	});

	test("StartMessage accepts optional hints", () => {
		const msg: StartMessage = {
			kind: "start",
			handle_id: "01JTEST000000000000000002",
			self: addr(
				"code-reader",
				1,
				undefined,
				"01JTEST000000000000000002",
				"01JTEST000000000000000002",
			),
			genome_path: "/tmp/genome",
			session_id: "session-1",
			caller: addr("root", 0),
			goal: "Find the auth module",
			hints: ["Check src/auth/"],
			shared: true,
		};
		expect(msg.hints).toEqual(["Check src/auth/"]);
		expect(msg.shared).toBe(true);
	});

	test("ContinueMessage carries message and caller", () => {
		const msg: ContinueMessage = {
			kind: "continue",
			message: "Now fix the other bug too",
			caller: addr("root", 0),
			trusted_user_instruction: "Search memory only; do not mutate anything",
		};
		expect(msg.kind).toBe("continue");
		expect(msg.message).toBe("Now fix the other bug too");
		expect(msg.caller.depth).toBe(0);
		expect(msg.trusted_user_instruction).toBe("Search memory only; do not mutate anything");
	});

	test("SteerMessage carries injected message", () => {
		const msg: SteerMessage = {
			kind: "steer",
			message: "Focus on the login module first",
			trusted_user_instruction: "Search memory only; do not mutate anything",
		};
		expect(msg.kind).toBe("steer");
		expect(msg.message).toBe("Focus on the login module first");
		expect(msg.trusted_user_instruction).toBe("Search memory only; do not mutate anything");
	});

	test("AgentMessageMessage carries agent-originated guidance", () => {
		const msg: AgentMessageMessage = {
			kind: "agent_message",
			message: "You wrote: start coding too early.",
			from: addr("metacognitive", 1, "observer"),
			to: addr("root", 0),
			ack_topic: "session/s1/agent-message-ack/m1",
		};
		expect(msg.kind).toBe("agent_message");
		expect(msg.message).toContain("start coding");
		expect(msg.from.agentName).toBe("metacognitive");
		expect(msg.from.role).toBe("observer");
		expect(msg.ack_topic).toContain("agent-message-ack");
	});

	test("ResultMessage carries completion data", () => {
		const msg: ResultMessage = {
			kind: "result",
			handle_id: "01JTEST000000000000000001",
			output: "Fixed the null check on line 23",
			success: true,
			stumbles: 0,
			turns: 3,
			timed_out: false,
		};
		expect(msg.kind).toBe("result");
		expect(msg.handle_id).toBe("01JTEST000000000000000001");
		expect(msg.output).toContain("null check");
		expect(msg.success).toBe(true);
		expect(msg.stumbles).toBe(0);
		expect(msg.turns).toBe(3);
		expect(msg.timed_out).toBe(false);
	});

	test("ResultMessage captures failure with stumbles", () => {
		const msg: ResultMessage = {
			kind: "result",
			handle_id: "01JTEST000000000000000003",
			output: "Could not complete the task",
			success: false,
			stumbles: 2,
			turns: 50,
			timed_out: true,
		};
		expect(msg.success).toBe(false);
		expect(msg.stumbles).toBe(2);
		expect(msg.timed_out).toBe(true);
	});

	test("EventMessage wraps a SessionEvent", () => {
		const event: SessionEvent = {
			kind: "plan_start",
			timestamp: Date.now(),
			agent_id: "code-editor",
			depth: 1,
			data: { model: "claude-sonnet-4-6" },
		};
		const msg: EventMessage = {
			kind: "event",
			handle_id: "01JTEST000000000000000001",
			event,
		};
		expect(msg.kind).toBe("event");
		expect(msg.handle_id).toBe("01JTEST000000000000000001");
		expect(msg.event.kind).toBe("plan_start");
		expect(msg.event.agent_id).toBe("code-editor");
	});

	test("BusMessage union accepts all message kinds", () => {
		const messages: BusMessage[] = [
			{
				kind: "start",
				handle_id: "h1",
				self: addr("editor", 1, undefined, "h1", "h1"),
				genome_path: "/g",
				session_id: "s1",
				caller: addr("root", 0),
				goal: "do stuff",
				shared: false,
			},
			{
				kind: "continue",
				message: "more stuff",
				caller: addr("root", 0),
			},
			{ kind: "steer", message: "focus" },
			{
				kind: "agent_message",
				message: "observer guidance",
				from: addr("metacognitive", 1),
				to: addr("root", 0),
			},
			{
				kind: "result",
				handle_id: "h1",
				output: "done",
				success: true,
				stumbles: 0,
				turns: 1,
				timed_out: false,
			},
			{
				kind: "event",
				handle_id: "h1",
				event: {
					kind: "plan_start",
					timestamp: 0,
					agent_id: "editor",
					depth: 1,
					data: {},
				},
			},
		];
		expect(messages).toHaveLength(6);
		const kinds = messages.map((m) => m.kind);
		expect(kinds).toEqual(["start", "continue", "steer", "agent_message", "result", "event"]);
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
