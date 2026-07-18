import { describe, expect, test } from "bun:test";
import {
	computePreview,
	type ValueMetadata,
	type ValueType,
	validateValueName,
} from "../../src/store/value.ts";

const RESERVED = new Set(["programs", "peek", "bind", "exec"]);

describe("validateValueName", () => {
	test("accepts a simple lowercase name", () => {
		expect(validateValueName("failing_tests", RESERVED)).toEqual({ ok: true });
	});

	test("accepts digits and underscores after the first character", () => {
		expect(validateValueName("cell_2_output", RESERVED)).toEqual({ ok: true });
	});

	test("accepts a leading underscore", () => {
		expect(validateValueName("_scratch", RESERVED)).toEqual({ ok: true });
	});

	test("accepts a name of exactly 64 characters", () => {
		expect(validateValueName("a".repeat(64), RESERVED)).toEqual({ ok: true });
	});

	test("rejects the empty name", () => {
		const result = validateValueName("", RESERVED);
		expect(result.ok).toBe(false);
	});

	test("rejects a 65-character name", () => {
		const result = validateValueName("a".repeat(65), RESERVED);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("64");
	});

	test("rejects a leading digit", () => {
		const result = validateValueName("2fast", RESERVED);
		expect(result.ok).toBe(false);
	});

	test("rejects uppercase letters", () => {
		const result = validateValueName("Schema", RESERVED);
		expect(result.ok).toBe(false);
	});

	test("rejects hyphens and spaces", () => {
		expect(validateValueName("my-name", RESERVED).ok).toBe(false);
		expect(validateValueName("my name", RESERVED).ok).toBe(false);
	});

	test("rejects unicode letters", () => {
		expect(validateValueName("café", RESERVED).ok).toBe(false);
		expect(validateValueName("名前", RESERVED).ok).toBe(false);
	});

	test("rejects reserved names", () => {
		const result = validateValueName("programs", RESERVED);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("reserved");
	});

	test("accepts a name that is not in the reserved set", () => {
		expect(validateValueName("programs_copy", RESERVED)).toEqual({ ok: true });
	});

	test("every failure carries a human-readable reason", () => {
		for (const bad of ["", "2x", "X", "a".repeat(65), "programs"]) {
			const result = validateValueName(bad, RESERVED);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
		}
	});
});

/** Max chars a preview may exceed the budget by (structural margin). */
const MARGIN = 40;

describe("computePreview", () => {
	test("is deterministic — same input yields the identical string", () => {
		const content = "line one\nline two\nline three";
		expect(computePreview(content, "text")).toBe(computePreview(content, "text"));
	});

	test("text preview includes type, byte size, and line count", () => {
		const preview = computePreview("alpha\nbeta\ngamma", "text");
		expect(preview).toContain("text");
		expect(preview).toContain("16");
		expect(preview).toContain("3 lines");
	});

	test("byte size counts utf8 bytes, not characters", () => {
		// "é" is 2 bytes in utf8.
		const preview = computePreview("é", "text");
		expect(preview).toContain("2 bytes");
	});

	test("short text is excerpted in full", () => {
		const preview = computePreview("hello world", "text");
		expect(preview).toContain("hello world");
	});

	test("empty text value previews without an excerpt", () => {
		const preview = computePreview("", "text");
		expect(preview).toContain("text");
		expect(preview).toContain("0 bytes");
		expect(preview.length).toBeLessThanOrEqual(300 + MARGIN);
	});

	test("long multi-line text shows head and tail", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line number ${i}`);
		const preview = computePreview(lines.join("\n"), "text");
		expect(preview).toContain("line number 0");
		expect(preview).toContain("line number 199");
		expect(preview.length).toBeLessThanOrEqual(300 + MARGIN);
	});

	test("a single enormous line stays within budget", () => {
		const content = "x".repeat(1_000_000);
		const preview = computePreview(content, "text");
		expect(preview.length).toBeLessThanOrEqual(300 + MARGIN);
		expect(preview).toContain("1 line");
	});

	test("respects a custom character budget", () => {
		const content = "y".repeat(10_000);
		const preview = computePreview(content, "text", { charBudget: 100 });
		expect(preview.length).toBeLessThanOrEqual(100 + MARGIN);
	});

	test("CRLF line endings count as single line breaks", () => {
		const preview = computePreview("a\r\nb\r\nc", "text");
		expect(preview).toContain("3 lines");
	});

	test("json object preview includes top-level keys", () => {
		const preview = computePreview(JSON.stringify({ alpha: 1, beta: [1, 2], gamma: "x" }), "json");
		expect(preview).toContain("json");
		expect(preview).toContain("alpha");
		expect(preview).toContain("beta");
		expect(preview).toContain("gamma");
		expect(preview).not.toContain("unparsed");
	});

	test("json array preview includes the array length", () => {
		const preview = computePreview(JSON.stringify([1, 2, 3, 4, 5]), "json");
		expect(preview).toContain("array");
		expect(preview).toContain("5");
	});

	test("json shape with many keys stays within budget", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 500; i++) obj[`key_number_${i}`] = i;
		const preview = computePreview(JSON.stringify(obj), "json");
		expect(preview.length).toBeLessThanOrEqual(300 + MARGIN);
	});

	test("json over the parse budget is not parsed — falls back with unparsed note", () => {
		const content = JSON.stringify({ big: "value" });
		const preview = computePreview(content, "json", { jsonParseBudgetBytes: 4 });
		expect(preview).toContain("json (unparsed)");
		// Head/tail excerpt still present.
		expect(preview).toContain("big");
	});

	test("invalid json falls back with unparsed note and excerpt", () => {
		const preview = computePreview("{not valid json", "json");
		expect(preview).toContain("json (unparsed)");
		expect(preview).toContain("{not valid json");
	});

	test("json fallback determinism", () => {
		const content = "{broken";
		expect(computePreview(content, "json")).toBe(computePreview(content, "json"));
	});

	test("bytes preview has type, size, and hex head but no text excerpt", () => {
		const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x41, 0x42]);
		const preview = computePreview(bytes, "bytes");
		expect(preview).toContain("bytes");
		expect(preview).toContain("6");
		expect(preview).toContain("deadbeef");
		// The printable ASCII in the payload must not appear as text.
		expect(preview).not.toContain("AB");
	});

	test("empty bytes value previews cleanly", () => {
		const preview = computePreview(new Uint8Array(0), "bytes");
		expect(preview).toContain("0 bytes");
		expect(preview.length).toBeLessThanOrEqual(300 + MARGIN);
	});

	test("large bytes value stays within budget", () => {
		const bytes = new Uint8Array(100_000).fill(0xab);
		const preview = computePreview(bytes, "bytes");
		expect(preview.length).toBeLessThanOrEqual(300 + MARGIN);
	});

	test("Uint8Array text content is decoded for text previews", () => {
		const bytes = new TextEncoder().encode("hello\nworld");
		const preview = computePreview(bytes, "text");
		expect(preview).toContain("hello");
		expect(preview).toContain("2 lines");
	});
});

describe("ValueMetadata", () => {
	test("models the spec's metadata fields", () => {
		const metadata: ValueMetadata = {
			ulid: "01J0000000000000000000000",
			name: "failing_tests",
			scopeId: "scope-1",
			type: "text" satisfies ValueType,
			size: 42,
			provenance: {
				agentHandleId: "agent-1",
				origin: { kind: "primitive", name: "exec", argsSummary: "bun test" },
			},
			preview: "text · 42 bytes · 1 line\nhello",
			createdAt: 1_700_000_000_000,
		};
		expect(metadata.provenance.origin.kind).toBe("primitive");
	});

	test("cell and delegation origins need no primitive fields", () => {
		const cell: ValueMetadata["provenance"]["origin"] = { kind: "cell" };
		const delegation: ValueMetadata["provenance"]["origin"] = { kind: "delegation" };
		expect(cell.kind).toBe("cell");
		expect(delegation.kind).toBe("delegation");
	});
});
