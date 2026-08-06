import { describe, expect, test } from "bun:test";
import {
	captureMarker,
	DEFAULT_PREVIEW_BUDGETS,
	resolvePreviewBudgets,
} from "../../src/kernel/truncation";

/**
 * The capture-all budget record (spec v10 §Budgets): one svelte, configurable
 * table all three gates read. Chars, not bytes.
 */
describe("DEFAULT_PREVIEW_BUDGETS", () => {
	test("carries the spec's rows", () => {
		expect(DEFAULT_PREVIEW_BUDGETS.default).toBe(2_000);
		expect(DEFAULT_PREVIEW_BUDGETS.read_file).toBe(4_000);
		expect(DEFAULT_PREVIEW_BUDGETS.delegate).toBe(4_000);
		expect(DEFAULT_PREVIEW_BUDGETS.cell).toBe(2_000);
	});
});

describe("resolvePreviewBudgets", () => {
	test("no env var → defaults", () => {
		const budgets = resolvePreviewBudgets({});
		expect(budgets).toEqual(DEFAULT_PREVIEW_BUDGETS);
	});

	test("env JSON map merges over defaults", () => {
		const budgets = resolvePreviewBudgets({
			SPROUT_PREVIEW_BUDGETS: '{"default": 8000, "read_file": 16000}',
		});
		expect(budgets.default).toBe(8_000);
		expect(budgets.read_file).toBe(16_000);
		// Unmentioned rows keep their defaults.
		expect(budgets.delegate).toBe(4_000);
		expect(budgets.cell).toBe(2_000);
	});

	test("an explicit cell row is required to move the cell gate — default does not leak", () => {
		const budgets = resolvePreviewBudgets({ SPROUT_PREVIEW_BUDGETS: '{"default": 9000}' });
		expect(budgets.cell).toBe(2_000);
		expect(budgets.delegate).toBe(4_000);
	});

	test("invalid JSON warns and falls back to defaults (never crashes a session)", () => {
		const warnings: string[] = [];
		const budgets = resolvePreviewBudgets({ SPROUT_PREVIEW_BUDGETS: "not json" }, (m) =>
			warnings.push(m),
		);
		expect(budgets).toEqual(DEFAULT_PREVIEW_BUDGETS);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("SPROUT_PREVIEW_BUDGETS");
	});

	test("non-positive or non-numeric rows warn and fall back wholesale", () => {
		const warnings: string[] = [];
		expect(
			resolvePreviewBudgets({ SPROUT_PREVIEW_BUDGETS: '{"default": -5}' }, (m) => warnings.push(m)),
		).toEqual(DEFAULT_PREVIEW_BUDGETS);
		expect(
			resolvePreviewBudgets({ SPROUT_PREVIEW_BUDGETS: '{"default": "big"}' }, (m) =>
				warnings.push(m),
			),
		).toEqual(DEFAULT_PREVIEW_BUDGETS);
		expect(warnings).toHaveLength(2);
	});
});

/**
 * The one marker helper (spec v10 §The marker): prefix + tail, five canonical
 * forms, captured markers always report chars.
 */
describe("captureMarker", () => {
	test("ref form", () => {
		expect(captureMarker("1234 chars", " — full content: ⟦server_log⟧")).toBe(
			"[... 1234 chars truncated — full content: ⟦server_log⟧]",
		);
	});

	test("fetch body form", () => {
		expect(captureMarker("70 chars", " — full body: ⟦fetch_output⟧")).toBe(
			"[... 70 chars truncated — full body: ⟦fetch_output⟧]",
		);
	});

	test("stderr companion form", () => {
		expect(
			captureMarker("9 chars", " — full content: ⟦exec_output⟧, stderr: ⟦exec_output_stderr⟧"),
		).toBe("[... 9 chars truncated — full content: ⟦exec_output⟧, stderr: ⟦exec_output_stderr⟧]");
	});

	test("degradation forms", () => {
		expect(captureMarker("12 lines", "; store full — content not captured")).toBe(
			"[... 12 lines truncated; store full — content not captured]",
		);
		expect(captureMarker("40 chars", "; capture failed — content not captured")).toBe(
			"[... 40 chars truncated; capture failed — content not captured]",
		);
	});
});
