import { describe, expect, test } from "bun:test";
import { clampWidth } from "../useResizable.ts";

describe("clampWidth", () => {
	test("clamps below minimum", () => {
		expect(clampWidth(100, 200, 400)).toBe(200);
	});

	test("clamps above maximum", () => {
		expect(clampWidth(500, 200, 400)).toBe(400);
	});

	test("returns value within range", () => {
		expect(clampWidth(300, 200, 400)).toBe(300);
	});
});
