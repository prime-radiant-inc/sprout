import { describe, expect, test } from "bun:test";
import {
	agentEvents,
	agentInbox,
	agentMessageAck,
	agentReady,
	agentResult,
	genomeEvents,
	genomeMutations,
	sessionEvents,
} from "../../src/bus/topics.ts";

describe("topic builders", () => {
	test("agentInbox", () => {
		expect(agentInbox("S1", "H1")).toBe("session/S1/agent/H1/inbox");
	});

	test("agentEvents", () => {
		expect(agentEvents("S1", "H1")).toBe("session/S1/agent/H1/events");
	});

	test("agentReady", () => {
		expect(agentReady("S1", "H1")).toBe("session/S1/agent/H1/ready");
	});

	test("agentResult", () => {
		expect(agentResult("S1", "H1")).toBe("session/S1/agent/H1/result");
	});

	test("agentMessageAck", () => {
		expect(agentMessageAck("S1", "M1")).toBe("session/S1/agent-message-ack/M1");
	});

	test("genomeMutations", () => {
		expect(genomeMutations("S1")).toBe("session/S1/genome/mutations");
	});

	test("genomeEvents", () => {
		expect(genomeEvents("S1")).toBe("session/S1/genome/events");
	});

	test("sessionEvents", () => {
		expect(sessionEvents("S1")).toBe("session/S1/events");
	});
});
