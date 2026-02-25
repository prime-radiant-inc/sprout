import { describe, expect, test } from "bun:test";
import {
	agentInbox,
	agentEvents,
	agentResult,
	commandsTopic,
	genomeMutations,
	genomeEvents,
	parseTopic,
} from "../../src/bus/topics.ts";
import type {
	ParsedAgentTopic,
	ParsedSessionTopic,
} from "../../src/bus/topics.ts";

describe("topic builders", () => {
	test("agentInbox", () => {
		expect(agentInbox("S1", "H1")).toBe("session/S1/agent/H1/inbox");
	});

	test("agentEvents", () => {
		expect(agentEvents("S1", "H1")).toBe("session/S1/agent/H1/events");
	});

	test("agentResult", () => {
		expect(agentResult("S1", "H1")).toBe("session/S1/agent/H1/result");
	});

	test("commandsTopic", () => {
		expect(commandsTopic("S1")).toBe("session/S1/commands");
	});

	test("genomeMutations", () => {
		expect(genomeMutations("S1")).toBe("session/S1/genome/mutations");
	});

	test("genomeEvents", () => {
		expect(genomeEvents("S1")).toBe("session/S1/genome/events");
	});
});

describe("parseTopic", () => {
	describe("agent topics", () => {
		test("parses inbox topic", () => {
			const result = parseTopic("session/S1/agent/H1/inbox");
			expect(result).toEqual({
				session_id: "S1",
				handle_id: "H1",
				channel: "inbox",
			});
		});

		test("parses events topic", () => {
			const result = parseTopic("session/S1/agent/H1/events");
			expect(result).toEqual({
				session_id: "S1",
				handle_id: "H1",
				channel: "events",
			});
		});

		test("parses result topic", () => {
			const result = parseTopic("session/S1/agent/H1/result");
			expect(result).toEqual({
				session_id: "S1",
				handle_id: "H1",
				channel: "result",
			});
		});
	});

	describe("session topics", () => {
		test("parses commands topic", () => {
			const result = parseTopic("session/S1/commands");
			expect(result).toEqual({
				session_id: "S1",
				channel: "commands",
			});
		});

		test("parses genome/mutations topic", () => {
			const result = parseTopic("session/S1/genome/mutations");
			expect(result).toEqual({
				session_id: "S1",
				channel: "genome/mutations",
			});
		});

		test("parses genome/events topic", () => {
			const result = parseTopic("session/S1/genome/events");
			expect(result).toEqual({
				session_id: "S1",
				channel: "genome/events",
			});
		});
	});

	describe("invalid topics", () => {
		test("returns null for empty string", () => {
			expect(parseTopic("")).toBeNull();
		});

		test("returns null for unrecognized format", () => {
			expect(parseTopic("foo/bar/baz")).toBeNull();
		});

		test("returns null for missing session prefix", () => {
			expect(parseTopic("agent/H1/inbox")).toBeNull();
		});

		test("returns null for incomplete agent topic", () => {
			expect(parseTopic("session/S1/agent/H1")).toBeNull();
		});

		test("returns null for trailing slash", () => {
			expect(parseTopic("session/S1/commands/")).toBeNull();
		});
	});

	describe("round-trip with builders", () => {
		test("agentInbox round-trips", () => {
			const topic = agentInbox("sess-42", "handle-7");
			const parsed = parseTopic(topic) as ParsedAgentTopic;
			expect(parsed.session_id).toBe("sess-42");
			expect(parsed.handle_id).toBe("handle-7");
			expect(parsed.channel).toBe("inbox");
		});

		test("genomeMutations round-trips", () => {
			const topic = genomeMutations("sess-42");
			const parsed = parseTopic(topic) as ParsedSessionTopic;
			expect(parsed.session_id).toBe("sess-42");
			expect(parsed.channel).toBe("genome/mutations");
		});
	});
});
