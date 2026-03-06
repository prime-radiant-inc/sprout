import { describe, expect, test } from "bun:test";
import type {
	BusMessage,
	CallerIdentity,
	ContinueMessage,
	EventMessage,
	ResultMessage,
	StartMessage,
	SteerMessage,
} from "../../src/bus/types.ts";
import { parseBusMessage } from "../../src/bus/types.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";

describe("bus message types", () => {
	test("CallerIdentity carries agent name and depth", () => {
		const caller: CallerIdentity = { agent_name: "root", depth: 0 };
		expect(caller.agent_name).toBe("root");
		expect(caller.depth).toBe(0);
	});

	test("StartMessage has all required fields", () => {
		const msg: StartMessage = {
			kind: "start",
			handle_id: "01JTEST000000000000000001",
			agent_id: "01JTEST000000000000000001",
			agent_name: "code-editor",
			genome_path: "/tmp/genome",
			session_id: "session-1",
			caller: { agent_name: "root", depth: 0 },
			goal: "Fix the bug",
			shared: false,
		};
		expect(msg.kind).toBe("start");
		expect(msg.handle_id).toBe("01JTEST000000000000000001");
		expect(msg.agent_name).toBe("code-editor");
		expect(msg.genome_path).toBe("/tmp/genome");
		expect(msg.session_id).toBe("session-1");
		expect(msg.caller.agent_name).toBe("root");
		expect(msg.goal).toBe("Fix the bug");
		expect(msg.shared).toBe(false);
		expect(msg.hints).toBeUndefined();
	});

	test("StartMessage accepts optional hints", () => {
		const msg: StartMessage = {
			kind: "start",
			handle_id: "01JTEST000000000000000002",
			agent_id: "01JTEST000000000000000002",
			agent_name: "code-reader",
			genome_path: "/tmp/genome",
			session_id: "session-1",
			caller: { agent_name: "root", depth: 0 },
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
			caller: { agent_name: "root", depth: 0 },
		};
		expect(msg.kind).toBe("continue");
		expect(msg.message).toBe("Now fix the other bug too");
		expect(msg.caller.depth).toBe(0);
	});

	test("SteerMessage carries injected message", () => {
		const msg: SteerMessage = {
			kind: "steer",
			message: "Focus on the login module first",
		};
		expect(msg.kind).toBe("steer");
		expect(msg.message).toBe("Focus on the login module first");
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
				agent_id: "h1",
				agent_name: "editor",
				genome_path: "/g",
				session_id: "s1",
				caller: { agent_name: "root", depth: 0 },
				goal: "do stuff",
				shared: false,
			},
			{
				kind: "continue",
				message: "more stuff",
				caller: { agent_name: "root", depth: 0 },
			},
			{ kind: "steer", message: "focus" },
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
		expect(messages).toHaveLength(5);
		const kinds = messages.map((m) => m.kind);
		expect(kinds).toEqual(["start", "continue", "steer", "result", "event"]);
	});
});

describe("parseBusMessage", () => {
	test("parses a valid StartMessage", () => {
		const raw = JSON.stringify({
			kind: "start",
			handle_id: "h1",
			agent_id: "h1",
			agent_name: "editor",
			genome_path: "/g",
			session_id: "s1",
			caller: { agent_name: "root", depth: 0 },
			goal: "do stuff",
			shared: false,
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("start");
		expect((msg as StartMessage).goal).toBe("do stuff");
	});

	test("parses a valid ContinueMessage", () => {
		const raw = JSON.stringify({
			kind: "continue",
			message: "keep going",
			caller: { agent_name: "root", depth: 0 },
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("continue");
		expect((msg as ContinueMessage).message).toBe("keep going");
	});

	test("parses a valid SteerMessage", () => {
		const raw = JSON.stringify({
			kind: "steer",
			message: "focus on tests",
		});
		const msg = parseBusMessage(raw);
		expect(msg.kind).toBe("steer");
		expect((msg as SteerMessage).message).toBe("focus on tests");
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

	test("throws on missing required ContinueMessage fields", () => {
		const partial = JSON.stringify({ kind: "continue" });
		expect(() => parseBusMessage(partial)).toThrow();
	});

	test("throws on missing required SteerMessage fields", () => {
		const partial = JSON.stringify({ kind: "steer" });
		expect(() => parseBusMessage(partial)).toThrow();
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
			agent_id: "H1",
			agent_name: "editor",
			genome_path: "/tmp",
			session_id: "S1",
			caller: "not-an-object",
			goal: "fix",
			shared: false,
		});
		expect(() => parseBusMessage(raw)).toThrow(/caller/);
	});

	test("throws on start message with caller missing agent_name", () => {
		const raw = JSON.stringify({
			kind: "start",
			handle_id: "H1",
			agent_id: "H1",
			agent_name: "editor",
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
});
