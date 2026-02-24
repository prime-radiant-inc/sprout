import { describe, expect, test } from "bun:test";
import { getContextWindowSize } from "../../src/agents/context-window.ts";

describe("getContextWindowSize", () => {
	test("returns known size for claude models", () => {
		expect(getContextWindowSize("claude-sonnet-4-20250514")).toBe(200_000);
	});
	test("returns known size for gpt models", () => {
		expect(getContextWindowSize("gpt-4o")).toBe(128_000);
	});
	test("returns default for unknown models", () => {
		expect(getContextWindowSize("unknown-model-v1")).toBe(128_000);
	});
	test("matches partial model names", () => {
		expect(getContextWindowSize("claude-sonnet-4-6")).toBe(200_000);
		expect(getContextWindowSize("gpt-4o-mini")).toBe(128_000);
	});
});
