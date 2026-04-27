import { describe, expect, test } from "bun:test";
import type { LearnSignal, SessionEvent } from "../../src/kernel/types.ts";
import {
	learnSignalEvidenceWindow,
	renderLearnEvidenceEvents,
} from "../../src/learn/extraction-evidence.ts";

function event(
	kind: SessionEvent["kind"],
	timestamp: number,
	data: Record<string, unknown>,
	depth = 0,
	agent_id = depth === 0 ? "root" : "child",
): SessionEvent {
	return { kind, timestamp, agent_id, depth, data };
}

function signal(timestamp: number): LearnSignal {
	return {
		kind: "failure",
		goal: "Fix the failing task",
		agent_name: "root",
		session_id: "session-1",
		timestamp,
		details: {
			agent_name: "worker",
			goal: "Normal child work",
			output: "The child failed",
			success: false,
			stumbles: 1,
			turns: 2,
			timed_out: false,
		},
	};
}

describe("learn signal extraction evidence", () => {
	test("excludes observer telemetry while preserving normal task evidence", () => {
		const events: SessionEvent[] = [
			event("session_start", 100, { session_id: "session-1" }, 0, "session"),
			event("perceive", 150, { goal: "Root task" }),
			event("agent_message", 200, {
				from_agent_name: "metacognitive",
				to_agent_name: "root",
				text_preview: "observer notification should not be evidence",
			}),
			event("act_start", 250, {
				agent_name: "metacognitive",
				child_id: "observer-metacognitive",
				handle_id: "observer-metacognitive",
				observer: true,
				goal: "observer frame should not be evidence",
				description: "observe root turns",
			}),
			event(
				"perceive",
				300,
				{ goal: "<observer_frame>hidden observer frame</observer_frame>" },
				1,
				"observer-metacognitive",
			),
			event(
				"plan_end",
				350,
				{ text: "observer analysis should not be evidence" },
				1,
				"observer-metacognitive",
			),
			event("act_start", 400, {
				agent_name: "worker",
				child_id: "worker-1",
				goal: "normal child work should remain evidence",
			}),
			event(
				"primitive_end",
				450,
				{ name: "exec", success: false, output: "normal command failed" },
				1,
				"worker-1",
			),
			event("learn_signal", 500, { signal: "failure" }),
		];

		const evidence = learnSignalEvidenceWindow({ signal: signal(500), events });
		const rendered = renderLearnEvidenceEvents(evidence);

		expect(rendered).toContain("Root task");
		expect(rendered).toContain("normal child work should remain evidence");
		expect(rendered).toContain("normal command failed");
		expect(rendered).not.toContain("observer notification should not be evidence");
		expect(rendered).not.toContain("observer frame should not be evidence");
		expect(rendered).not.toContain("hidden observer frame");
		expect(rendered).not.toContain("observer analysis should not be evidence");
	});
});
