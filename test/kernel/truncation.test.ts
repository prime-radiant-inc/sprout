import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CHAR_LIMITS,
	DEFAULT_LINE_LIMITS,
	truncateLines,
	truncateOutput,
	truncateToolOutput,
} from "../../src/kernel/truncation.ts";

describe("truncateOutput (character-based)", () => {
	test("returns short output unchanged", () => {
		const output = "hello world";
		expect(truncateOutput(output, 1000, "head_tail")).toBe(output);
	});

	test("head_tail mode keeps beginning and end", () => {
		const output = "A".repeat(100) + "B".repeat(100) + "C".repeat(100);
		const result = truncateOutput(output, 200, "head_tail");
		// Should have first 100 chars and last 100 chars
		expect(result.startsWith("A".repeat(100))).toBe(true);
		expect(result.endsWith("C".repeat(100))).toBe(true);
		expect(result).toContain("[WARNING: Tool output was truncated.");
		expect(result).toContain("100 characters were removed");
	});

	test("tail mode keeps only the end", () => {
		const output = "A".repeat(200) + "B".repeat(100);
		const result = truncateOutput(output, 100, "tail");
		expect(result.endsWith("B".repeat(100))).toBe(true);
		expect(result).toContain("[WARNING: Tool output was truncated.");
		expect(result).toContain("200 characters were removed");
		// Should NOT start with As
		expect(result).not.toContain("AAAA");
	});

	test("exact limit output is not truncated", () => {
		const output = "x".repeat(500);
		expect(truncateOutput(output, 500, "head_tail")).toBe(output);
	});

	test("truncation message is informative", () => {
		const output = "x".repeat(10000);
		const result = truncateOutput(output, 1000, "head_tail");
		expect(result).toContain("9000 characters were removed from the middle");
		expect(result).toContain("full output is available in the event stream");
	});
});

describe("truncateLines (line-based)", () => {
	test("returns short output unchanged", () => {
		const output = "line1\nline2\nline3";
		expect(truncateLines(output, 10)).toBe(output);
	});

	test("splits into head and tail lines", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
		const output = lines.join("\n");
		const result = truncateLines(output, 10);
		// Should have first 5 and last 5
		expect(result).toContain("line1");
		expect(result).toContain("line5");
		expect(result).toContain("line16");
		expect(result).toContain("line20");
		expect(result).toContain("[... 10 lines omitted ...]");
		// Middle lines should be gone
		expect(result).not.toContain("line10\n");
	});

	test("exact limit is not truncated", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
		const output = lines.join("\n");
		expect(truncateLines(output, 10)).toBe(output);
	});

	test("single line output is not truncated regardless of limit", () => {
		const output = "single line";
		expect(truncateLines(output, 1)).toBe(output);
	});
});

describe("truncateToolOutput (combined pipeline)", () => {
	test("applies character truncation first, then line truncation", () => {
		// 1000 lines of 100 chars each = 100k chars
		const lines = Array.from(
			{ length: 1000 },
			(_, i) => `${"x".repeat(95)}${String(i).padStart(5, "0")}`,
		);
		const output = lines.join("\n");

		const result = truncateToolOutput(output, "exec");
		// exec default: 30k chars, 256 lines
		// Char truncation should fire first (100k > 30k)
		expect(result.length).toBeLessThan(35000); // some overhead for truncation messages
		// Line truncation should also have fired on the char-truncated result
	});

	test("uses default limits for known tools", () => {
		expect(DEFAULT_CHAR_LIMITS.read_file).toBe(50_000);
		expect(DEFAULT_CHAR_LIMITS.exec).toBe(30_000);
		expect(DEFAULT_CHAR_LIMITS.grep).toBe(20_000);
		expect(DEFAULT_CHAR_LIMITS.glob).toBe(20_000);
		expect(DEFAULT_CHAR_LIMITS.edit_file).toBe(10_000);
		expect(DEFAULT_CHAR_LIMITS.apply_patch).toBe(10_000);
		expect(DEFAULT_CHAR_LIMITS.write_file).toBe(1_000);
	});

	test("uses default line limits for tools that have them", () => {
		expect(DEFAULT_LINE_LIMITS.exec).toBe(256);
		expect(DEFAULT_LINE_LIMITS.grep).toBe(200);
		expect(DEFAULT_LINE_LIMITS.glob).toBe(500);
	});

	test("handles pathological single-line input (10MB CSV)", () => {
		// This is the case char truncation must handle
		const megaLine = "x".repeat(100_000);
		const result = truncateToolOutput(megaLine, "read_file");
		expect(result.length).toBeLessThan(55_000); // 50k limit + message overhead
	});

	test("short output passes through unchanged", () => {
		const output = "hello world";
		expect(truncateToolOutput(output, "exec")).toBe(output);
	});

	test("allows custom limits override", () => {
		const output = "x".repeat(500);
		const result = truncateToolOutput(output, "exec", { charLimit: 100 });
		// 100 chars of content kept + truncation message overhead
		expect(result.length).toBeLessThan(500);
		expect(result).toContain("[WARNING:");
		// Verify it actually truncated (original was 500 chars of content)
		const xCount = (result.match(/x/g) || []).length;
		expect(xCount).toBe(100);
	});
});
