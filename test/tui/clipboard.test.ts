import { describe, expect, test } from "bun:test";
import { readClipboard } from "../../src/tui/clipboard.ts";

describe("readClipboard", () => {
	test("returns a string", async () => {
		const result = await readClipboard();
		expect(typeof result).toBe("string");
	});
});
