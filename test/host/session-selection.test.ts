import { describe, expect, test } from "bun:test";
import {
	formatSessionSelectionRequest,
	parseAgentModelInput,
	parseSessionSelectionRequest,
} from "../../src/shared/session-selection.ts";

describe("parseSessionSelectionRequest", () => {
	test("parses inherit without provider context", () => {
		expect(parseSessionSelectionRequest("inherit")).toEqual({ kind: "inherit" });
	});

	test("parses tier names without provider context", () => {
		expect(parseSessionSelectionRequest("fast")).toEqual({ kind: "tier", tier: "fast" });
	});

	test("parses provider-qualified model refs", () => {
		expect(parseSessionSelectionRequest("openrouter:gpt-4.1")).toEqual({
			kind: "model",
			model: {
				providerId: "openrouter",
				modelId: "gpt-4.1",
			},
		});
	});

	test("rejects bare exact model ids", () => {
		expect(() => parseSessionSelectionRequest("claude-sonnet-4-6")).toThrow(/provider-qualified/i);
	});
});

describe("parseAgentModelInput", () => {
	test("accepts tier names", () => {
		expect(parseAgentModelInput("balanced")).toEqual({ kind: "tier", tier: "balanced" });
	});

	test("accepts bare model ids", () => {
		expect(parseAgentModelInput("claude-sonnet-4-6")).toEqual({
			kind: "unqualified_model",
			modelId: "claude-sonnet-4-6",
		});
	});

	test("rejects inherit", () => {
		expect(() => parseAgentModelInput("inherit")).toThrow(/inherit/);
	});

	test("rejects provider-qualified model refs", () => {
		expect(() => parseAgentModelInput("openai:gpt-4.1")).toThrow(/provider-qualified/);
	});
});

describe("formatSessionSelectionRequest", () => {
	test("formats canonical selections", () => {
		expect(formatSessionSelectionRequest({ kind: "inherit" })).toBe("inherit");
		expect(formatSessionSelectionRequest({ kind: "tier", tier: "best" })).toBe("best");
		expect(
			formatSessionSelectionRequest({
				kind: "model",
				model: { providerId: "openrouter", modelId: "gpt-4.1" },
			}),
		).toBe("openrouter:gpt-4.1");
	});
});
