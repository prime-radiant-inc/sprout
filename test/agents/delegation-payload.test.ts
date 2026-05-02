import { describe, expect, test } from "bun:test";
import { formatDelegationGoal, normalizeTaskPayload } from "../../src/agents/delegation-payload.ts";

describe("normalizeTaskPayload", () => {
	test("canonicalizes object keys and reports byte metadata", () => {
		const result = normalizeTaskPayload({ z: 1, a: { b: "two", a: "one" } }, "test");

		expect(result.canonicalJson).toBe('{"a":{"a":"one","b":"two"},"z":1}');
		expect(result.metadata).toEqual({
			present: true,
			bytes: new TextEncoder().encode(result.canonicalJson).byteLength,
			key_count: 2,
		});
	});

	test("rejects unsupported payload values without echoing content", () => {
		expect(() => normalizeTaskPayload({ bad: Number.POSITIVE_INFINITY }, "test")).toThrow(
			/payload\.bad.*finite number/,
		);
	});

	test("rejects non-object payloads", () => {
		expect(() => normalizeTaskPayload(["not", "object"], "test")).toThrow(/payload.*plain object/);
	});

	test("rejects oversized payloads", () => {
		expect(() => normalizeTaskPayload({ text: "x".repeat(65 * 1024) }, "test")).toThrow(
			/payload.*64 KiB/,
		);
	});

	test("rejects too-deep payloads", () => {
		const payload = { a: { b: { c: { d: { e: { f: { g: { h: { i: "too deep" } } } } } } } } };
		expect(() => normalizeTaskPayload(payload, "test")).toThrow(/payload.*depth/);
	});

	test("rejects cyclic payloads", () => {
		const payload: Record<string, unknown> = {};
		payload.self = payload;
		expect(() => normalizeTaskPayload(payload, "test")).toThrow(/payload.*cycles/);
	});
});

describe("formatDelegationGoal", () => {
	test("renders hints and canonical task payload", () => {
		const payload = normalizeTaskPayload({ old_string: "b", path: "a.ts" }, "test");

		expect(
			formatDelegationGoal({
				goal: "Apply exact edit.",
				hints: ["Use edit_file."],
				payload,
			}),
		).toBe(
			'Apply exact edit.\n\nHints:\n- Use edit_file.\n\n<task_payload type="json">\n{"old_string":"b","path":"a.ts"}\n</task_payload>',
		);
	});
});
