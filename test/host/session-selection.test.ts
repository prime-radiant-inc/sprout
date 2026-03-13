import { describe, expect, test } from "bun:test";
import {
	formatSessionSelectionRequest,
	parseAgentModelInput,
	parseSessionSelectionRequest,
} from "../../src/shared/session-selection.ts";

describe("parseSessionSelectionRequest", () => {
	test("parses inherit with an optional provider context", () => {
		expect(parseSessionSelectionRequest("inherit")).toEqual({ kind: "inherit" });
		expect(parseSessionSelectionRequest("inherit", "openrouter-main")).toEqual({
			kind: "inherit",
			providerId: "openrouter-main",
		});
	});

	test("parses tier names with an optional provider context", () => {
		expect(parseSessionSelectionRequest("fast")).toEqual({ kind: "tier", tier: "fast" });
		expect(parseSessionSelectionRequest("fast", "lmstudio")).toEqual({
			kind: "tier",
			providerId: "lmstudio",
			tier: "fast",
		});
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
	test("formats provider-relative selections", () => {
		expect(formatSessionSelectionRequest({ kind: "inherit" })).toBe("inherit");
		expect(
			formatSessionSelectionRequest({
				kind: "inherit",
				providerId: "openrouter-main",
			}),
		).toBe("inherit:openrouter-main");
		expect(
			formatSessionSelectionRequest({
				kind: "tier",
				providerId: "openrouter-main",
				tier: "best",
			}),
		).toBe("tier:openrouter-main:best");
		expect(
			formatSessionSelectionRequest({
				kind: "model",
				model: { providerId: "openrouter", modelId: "gpt-4.1" },
			}),
		).toBe("openrouter:gpt-4.1");
	});
});
