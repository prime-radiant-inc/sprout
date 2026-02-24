import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "../../src/tui/slash-commands.ts";

describe("parseSlashCommand", () => {
	test("returns null for non-slash input", () => {
		expect(parseSlashCommand("hello")).toBeNull();
	});

	test("parses /help", () => {
		expect(parseSlashCommand("/help")).toEqual({ kind: "help" });
	});

	test("parses /quit", () => {
		expect(parseSlashCommand("/quit")).toEqual({ kind: "quit" });
	});

	test("parses /model with argument", () => {
		expect(parseSlashCommand("/model claude-sonnet-4-6")).toEqual({
			kind: "switch_model",
			model: "claude-sonnet-4-6",
		});
	});

	test("parses /model without argument", () => {
		expect(parseSlashCommand("/model")).toEqual({ kind: "switch_model", model: undefined });
	});

	test("parses /compact", () => {
		expect(parseSlashCommand("/compact")).toEqual({ kind: "compact" });
	});

	test("parses /clear", () => {
		expect(parseSlashCommand("/clear")).toEqual({ kind: "clear" });
	});

	test("parses /status", () => {
		expect(parseSlashCommand("/status")).toEqual({ kind: "status" });
	});

	test("returns unknown for unrecognized slash command", () => {
		expect(parseSlashCommand("/foobar")).toEqual({ kind: "unknown", raw: "/foobar" });
	});
});
