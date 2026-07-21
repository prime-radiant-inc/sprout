import { describe, expect, test } from "bun:test";
import { sessionsUrl } from "./useSessions.ts";

describe("sessionsUrl", () => {
	test("plain path when no token is present", () => {
		expect(sessionsUrl("")).toBe("/api/sessions");
		expect(sessionsUrl("?foo=bar")).toBe("/api/sessions");
	});

	test("carries and encodes the page token", () => {
		expect(sessionsUrl("?token=abc123")).toBe("/api/sessions?token=abc123");
		expect(sessionsUrl("?token=a%2Fb+c")).toBe("/api/sessions?token=a%2Fb%20c");
	});
});
