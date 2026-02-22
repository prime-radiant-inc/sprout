import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/index.ts";

describe("smoke", () => {
	test("module loads", () => {
		expect(VERSION).toBe("0.1.0");
	});
});
