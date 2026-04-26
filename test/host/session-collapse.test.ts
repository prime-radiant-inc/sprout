import { describe, expect, test } from "bun:test";
import {
	buildCollapseTranscript,
	renderCollapseTranscript,
} from "../../src/core/session-collapse.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
import { Msg } from "../../src/llm/types.ts";

function event(
	kind: SessionEvent["kind"],
	timestamp: number,
	data: Record<string, unknown>,
	depth = 0,
	agent_id = depth === 0 ? "root" : "child",
): SessionEvent {
	return { kind, timestamp, agent_id, depth, data };
}

describe("session collapse transcript", () => {
	test("builds deterministic root-only transcripts from session events", () => {
		const messages = buildCollapseTranscript([
			event("plan_end", 300, { text: "I will inspect package.json." }),
			event("perceive", 100, { goal: "Run tests" }),
			event("primitive_end", 400, {
				name: "exec_command",
				tool_result_message: Msg.toolResult("tool-1", "bun test passed"),
			}),
			event("plan_end", 250, { text: "child internal analysis" }, 1, "engineer"),
			event("act_end", 500, {
				agent_name: "engineer",
				tool_result_message: Msg.toolResult("delegate-1", "implemented feature"),
			}),
			event("session_end", 600, { output: "Done" }),
		]);

		expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
			"user:Run tests",
			"assistant:I will inspect package.json.",
			"assistant:bun test passed",
			"assistant:implemented feature",
			"assistant:Done",
		]);
		expect(messages.every((message) => message.timestamp >= 100)).toBe(true);
		expect(messages.some((message) => message.content === "child internal analysis")).toBe(false);
	});

	test("can include subagent events when explicitly requested", () => {
		const messages = buildCollapseTranscript(
			[
				event("perceive", 100, { goal: "Root goal" }),
				event("plan_end", 200, { text: "child detail" }, 1, "engineer"),
			],
			{ includeSubagents: true },
		);

		expect(messages.map((message) => message.agent_id)).toEqual(["root", "engineer"]);
	});

	test("renders absolute timestamps for summary prompts", () => {
		const rendered = renderCollapseTranscript([
			{
				role: "user",
				content: "Use <sqlite>",
				timestamp: Date.UTC(2026, 3, 26, 12, 0, 0),
				agent_id: "root",
				event_kind: "perceive",
			},
		]);

		expect(rendered).toContain('time="2026-04-26T12:00:00.000Z"');
		expect(rendered).toContain("Use &lt;sqlite&gt;");
	});
});
