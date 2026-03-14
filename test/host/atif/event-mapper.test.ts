import { describe, expect, test } from "bun:test";
import { mapSessionEventToAtifStep } from "../../../src/host/atif/event-mapper.ts";
import type { PricingSnapshot } from "../../../src/host/pricing-cache.ts";
import type { SessionEvent } from "../../../src/kernel/types.ts";

const pricingSnapshot: PricingSnapshot = {
	source: "live",
	fetchedAt: "2026-03-14T12:00:00.000Z",
	upstreams: ["llm-prices"],
	table: [["gpt-4o", { input: 2.5, output: 10, cached_input: 1.25 }]],
};

function makeEvent(kind: SessionEvent["kind"], data: Record<string, unknown>): SessionEvent {
	return {
		kind,
		timestamp: Date.parse("2026-03-14T12:00:00.000Z"),
		agent_id: "root",
		depth: 0,
		data,
	};
}

describe("mapSessionEventToAtifStep", () => {
	test("maps perceive at depth 0 to a user step with the goal message", () => {
		const step = mapSessionEventToAtifStep({
			stepId: 1,
			event: makeEvent("perceive", { goal: "fix the failing test" }),
			pricingSnapshot,
		});

		expect(step).not.toBeNull();
		expect(step).toMatchObject({
			step_id: 1,
			source: "user",
			message: "fix the failing test",
		});
	});

	test("maps plan_end to an agent step with text, reasoning, and tool calls", () => {
		const step = mapSessionEventToAtifStep({
			stepId: 2,
			event: makeEvent("plan_end", {
				text: "I'll read the file first.",
				reasoning: "Need context before editing.",
				assistant_message: {
					role: "assistant",
					content: [
						{ kind: "text", text: "I'll read the file first." },
						{
							kind: "tool_call",
							tool_call: {
								id: "call_1",
								name: "read_file",
								arguments: { path: "src/app.ts" },
							},
						},
					],
				},
			}),
			pricingSnapshot,
		});

		expect(step).not.toBeNull();
		expect(step).toMatchObject({
			step_id: 2,
			source: "agent",
			message: "I'll read the file first.",
			reasoning_content: "Need context before editing.",
			tool_calls: [
				{
					tool_call_id: "call_1",
					function_name: "read_file",
					arguments: { path: "src/app.ts" },
				},
			],
		});
	});

	test("maps llm_end to a system step with token and cost metrics", () => {
		const step = mapSessionEventToAtifStep({
			stepId: 3,
			event: makeEvent("llm_end", {
				model: "gpt-4o",
				provider: "openai",
				input_tokens: 1200,
				output_tokens: 300,
				cache_read_tokens: 200,
				cache_write_tokens: 100,
			}),
			pricingSnapshot,
		});

		expect(step).not.toBeNull();
		expect(step).toMatchObject({
			step_id: 3,
			source: "system",
			message: "llm_end",
			model_name: "gpt-4o",
			metrics: {
				prompt_tokens: 1200,
				completion_tokens: 300,
				cached_tokens: 200,
			},
		});
		expect(step?.metrics?.cost_usd).toBeCloseTo(0.00575, 8);
		expect(step?.metrics?.extra?.cache_write_tokens).toBe(100);
	});

	test("maps primitive_end and act_end to observations", () => {
		const primitiveStep = mapSessionEventToAtifStep({
			stepId: 4,
			event: makeEvent("primitive_end", {
				name: "read_file",
				success: true,
				output: "file contents",
				tool_result_message: {
					role: "tool",
					tool_call_id: "call_1",
					content: [
						{
							kind: "tool_result",
							tool_result: {
								tool_call_id: "call_1",
								content: "file contents",
								is_error: false,
							},
						},
					],
				},
			}),
			pricingSnapshot,
		});
		const actStep = mapSessionEventToAtifStep({
			stepId: 5,
			event: makeEvent("act_end", {
				agent_name: "editor",
				success: true,
				tool_result_message: {
					role: "tool",
					tool_call_id: "call_2",
					content: [
						{
							kind: "tool_result",
							tool_result: {
								tool_call_id: "call_2",
								content: "subagent finished",
								is_error: false,
							},
						},
					],
				},
			}),
			pricingSnapshot,
		});

		expect(primitiveStep?.observation).toEqual({
			results: [{ source_call_id: "call_1", content: "file contents" }],
		});
		expect(actStep?.observation).toEqual({
			results: [{ source_call_id: "call_2", content: "subagent finished" }],
		});
	});

	test("excludes llm_chunk events", () => {
		const step = mapSessionEventToAtifStep({
			stepId: 6,
			event: makeEvent("llm_chunk", { text_delta: "hi" }),
			pricingSnapshot,
		});

		expect(step).toBeNull();
	});

	test("preserves the original event payload in extra", () => {
		const event = makeEvent("warning", { message: "careful now" });
		const step = mapSessionEventToAtifStep({
			stepId: 7,
			event,
			pricingSnapshot,
		});

		expect(step?.extra?.sprout_event).toEqual(event);
	});
});
