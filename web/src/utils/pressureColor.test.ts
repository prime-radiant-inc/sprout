import { describe, expect, test } from "bun:test";
import { pressureColor } from "./pressureColor.ts";

describe("pressureColor", () => {
	test("returns success color below 60%", () => {
		expect(pressureColor(0)).toBe("var(--color-success)");
		expect(pressureColor(30)).toBe("var(--color-success)");
		expect(pressureColor(59)).toBe("var(--color-success)");
	});

	test("returns warning color at 60%", () => {
		expect(pressureColor(60)).toBe("var(--color-warning)");
	});

	test("returns warning color between 60% and 84%", () => {
		expect(pressureColor(70)).toBe("var(--color-warning)");
		expect(pressureColor(84)).toBe("var(--color-warning)");
	});

	test("returns error color at 85%", () => {
		expect(pressureColor(85)).toBe("var(--color-error)");
	});

	test("returns error color above 85%", () => {
		expect(pressureColor(90)).toBe("var(--color-error)");
		expect(pressureColor(100)).toBe("var(--color-error)");
	});
});
