import { describe, expect, test } from "bun:test";
import { repairJson, stripCodeFence } from "../../src/genome/llm-json.ts";

describe("stripCodeFence", () => {
	test("unwraps a ```json fenced block", () => {
		expect(stripCodeFence('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
	});

	test("unwraps a bare ``` fenced block", () => {
		expect(stripCodeFence("```\n[1, 2]\n```")).toBe("[1, 2]");
	});

	test("returns unfenced text unchanged", () => {
		expect(stripCodeFence('{"a": 1}')).toBe('{"a": 1}');
	});
});

describe("repairJson", () => {
	test("replaces smart double quotes", () => {
		expect(repairJson("{“a”: “b”}")).toBe('{"a": "b"}');
	});

	test("replaces smart single quotes", () => {
		expect(repairJson("‘x’")).toBe("'x'");
	});

	test("removes trailing commas before } and ]", () => {
		expect(repairJson('{"a": [1, 2, ], }')).toBe('{"a": [1, 2]}');
		expect(repairJson("[1, 2, ]")).toBe("[1, 2]");
		expect(repairJson('{"a": 1, }')).toBe('{"a": 1}');
	});
});
