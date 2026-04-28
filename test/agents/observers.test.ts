import { describe, expect, test } from "bun:test";
import { buildObserverFrame, renderObserverFrame } from "../../src/agents/observers.ts";
import type { EventKind, SessionEvent } from "../../src/kernel/types.ts";

describe("observer frames", () => {
	test("filters event kinds and preserves input order", () => {
		const frame = buildObserverFrame({
			sessionId: "sess_1",
			events: [
				event("recall", "root", 0, { text: "memory lookup" }),
				event("plan_end", "root", 0, { text: "I will answer the design question." }),
				event("warning", "root", 0, { message: "retrying tool" }),
				event("primitive_start", "root", 0, { tool: "read_file" }),
			],
			includeKinds: ["plan_end", "warning"],
			maxEvents: 10,
			maxChars: 5000,
		});

		expect(frame.events.map((e) => e.kind)).toEqual(["plan_end", "warning"]);
		expect(frame.events.map((e) => e.index)).toEqual([1, 2]);
		expect(frame.truncated).toBe(false);
		expect(frame.events[0]!.quote).toBe("I will answer the design question.");
		expect(frame.events[1]!.quote).toBe("retrying tool");
	});

	test("keeps the newest maxEvents events and marks the frame truncated", () => {
		const frame = buildObserverFrame({
			sessionId: "sess_1",
			events: [
				event("plan_end", "root", 0, { text: "first" }),
				event("plan_end", "root", 0, { text: "second" }),
				event("plan_end", "root", 0, { text: "third" }),
			],
			includeKinds: ["plan_end"],
			maxEvents: 2,
			maxChars: 5000,
		});

		expect(frame.events.map((e) => e.quote)).toEqual(["second", "third"]);
		expect(frame.events.map((e) => e.index)).toEqual([1, 2]);
		expect(frame.truncated).toBe(true);
	});

	test("drops oldest rendered frame events to respect maxChars", () => {
		const frame = buildObserverFrame({
			sessionId: "sess_1",
			events: [
				event("plan_end", "root", 0, { text: "a".repeat(300) }),
				event("plan_end", "root", 0, { text: "kept" }),
			],
			includeKinds: ["plan_end"],
			maxEvents: 10,
			maxChars: 220,
		});

		expect(renderObserverFrame(frame).length).toBeLessThanOrEqual(220);
		expect(frame.events.map((e) => e.quote)).toEqual(["kept"]);
		expect(frame.truncated).toBe(true);
	});

	test("redacts secrets before rendering quotes", () => {
		const frame = buildObserverFrame({
			sessionId: "sess_1",
			events: [
				event("warning", "root", 0, {
					message: `OPENAI_API_KEY=sk-${"a".repeat(32)} failed`,
				}),
			],
			includeKinds: ["warning"],
			maxEvents: 10,
			maxChars: 5000,
		});

		const rendered = renderObserverFrame(frame);
		expect(rendered).toContain("OPENAI_API_KEY=[REDACTED_API_KEY]");
		expect(rendered).not.toContain(`sk-${"a".repeat(32)}`);
	});

	test("summarizes common observer event kinds", () => {
		const frame = buildObserverFrame({
			sessionId: "sess_1",
			events: [
				event("primitive_end", "root", 0, {
					tool: "read_file",
					success: false,
					error: "ENOENT",
				}),
				event("act_end", "root", 0, {
					agent_name: "engineer",
					success: true,
					output: "done",
				}),
				event("interrupted", "root", 0, { message: "Agent interrupted" }),
			],
			includeKinds: ["primitive_end", "act_end", "interrupted"],
			maxEvents: 10,
			maxChars: 5000,
		});

		expect(frame.events.map((e) => e.summary)).toEqual([
			"read_file failed.",
			"engineer delegation completed.",
			"Agent was interrupted.",
		]);
	});

	test("quotes delegation tool result messages", () => {
		const frame = buildObserverFrame({
			sessionId: "sess_1",
			events: [
				event("act_end", "root", 0, {
					agent_name: "engineer",
					success: true,
					tool_result_message: {
						role: "tool",
						content: [
							{
								kind: "tool_result",
								tool_result: {
									tool_call_id: "delegate_1",
									content: "delegate final says done",
									is_error: false,
								},
							},
						],
					},
				}),
			],
			includeKinds: ["act_end"],
			maxEvents: 10,
			maxChars: 5000,
		});

		expect(frame.events[0]!.quote).toBe("delegate final says done");
	});

	test("renders XML-safe frame text", () => {
		const frame = buildObserverFrame({
			sessionId: "sess<&1",
			events: [event("plan_end", "root", 0, { text: `Use "a < b" & continue` })],
			includeKinds: ["plan_end"],
			maxEvents: 10,
			maxChars: 5000,
		});

		const rendered = renderObserverFrame(frame);
		expect(rendered).toContain("sess&lt;&amp;1");
		expect(rendered).toContain("&quot;a &lt; b&quot; &amp; continue");
	});

	test("does not render a dynamic observer comment policy", () => {
		const frame = buildObserverFrame({
			sessionId: "sess_1",
			events: [event("plan_end", "root", 0, { text: "check assumptions" })],
			includeKinds: ["plan_end"],
			maxEvents: 10,
			maxChars: 5000,
		});

		const rendered = renderObserverFrame(frame);
		expect(rendered).not.toContain("<sprout:observer-comment-policy>");
		expect(rendered).not.toContain("can_message");
		expect(rendered).not.toContain("default_recipient");
	});

	test("rejects invalid bounds loudly", () => {
		expect(() =>
			buildObserverFrame({
				sessionId: "sess_1",
				events: [],
				includeKinds: ["plan_end"],
				maxEvents: 0,
				maxChars: 5000,
			}),
		).toThrow("maxEvents must be a positive integer");
		expect(() =>
			buildObserverFrame({
				sessionId: "sess_1",
				events: [],
				includeKinds: ["plan_end"],
				maxEvents: 1,
				maxChars: 0,
			}),
		).toThrow("maxChars must be a positive integer");
	});
});

function event(
	kind: EventKind,
	agentId: string,
	depth: number,
	data: Record<string, unknown>,
): SessionEvent {
	return {
		kind,
		timestamp: 1_700_000_000_000,
		agent_id: agentId,
		depth,
		data,
	};
}
