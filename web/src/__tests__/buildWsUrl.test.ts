import { describe, expect, test } from "bun:test";
import { buildWsUrl } from "../hooks/buildWsUrl.ts";

describe("buildWsUrl", () => {
	test("returns ws:// for http: protocol", () => {
		expect(buildWsUrl("http:", "localhost:3000")).toBe("ws://localhost:3000");
	});

	test("returns wss:// for https: protocol", () => {
		expect(buildWsUrl("https:", "example.com")).toBe("wss://example.com");
	});

	test("returns env override when provided", () => {
		expect(buildWsUrl("https:", "example.com", "ws://custom:9999")).toBe("ws://custom:9999");
	});

	test("ignores empty env override", () => {
		expect(buildWsUrl("https:", "example.com", "")).toBe("wss://example.com");
	});

	test("forwards token from URL search params", () => {
		expect(buildWsUrl("https:", "example.com", undefined, "?token=abc123")).toBe(
			"wss://example.com/?token=abc123",
		);
	});

	test("does not override token already present in env override", () => {
		expect(
			buildWsUrl("https:", "example.com", "wss://remote.example/ws?token=existing", "?token=new"),
		).toBe("wss://remote.example/ws?token=existing");
	});
});
