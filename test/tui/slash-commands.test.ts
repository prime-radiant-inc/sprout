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
			selection: { kind: "unqualified_model", modelId: "claude-sonnet-4-6" },
		});
	});

	test("parses /model without argument", () => {
		expect(parseSlashCommand("/model")).toEqual({ kind: "switch_model", selection: undefined });
	});

	test("parses /model inherit", () => {
		expect(parseSlashCommand("/model inherit")).toEqual({
			kind: "switch_model",
			selection: { kind: "inherit" },
		});
	});

	test("parses /model provider-qualified selection", () => {
		expect(parseSlashCommand("/model openrouter:gpt-4.1")).toEqual({
			kind: "switch_model",
			selection: {
				kind: "model",
				model: {
					providerId: "openrouter",
					modelId: "gpt-4.1",
				},
			},
		});
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

	test("parses /collapse-tools", () => {
		expect(parseSlashCommand("/collapse-tools")).toEqual({ kind: "collapse_tools" });
	});

	test("parses /terminal-setup", () => {
		expect(parseSlashCommand("/terminal-setup")).toEqual({ kind: "terminal_setup" });
	});

	test("parses /web", () => {
		expect(parseSlashCommand("/web")).toEqual({ kind: "web" });
	});

	test("parses /web stop", () => {
		expect(parseSlashCommand("/web stop")).toEqual({ kind: "web_stop" });
	});

	test("parses /web stop with extra whitespace", () => {
		expect(parseSlashCommand("  /web   stop  ")).toEqual({ kind: "web_stop" });
	});

	test("returns unknown for unrecognized slash command", () => {
		expect(parseSlashCommand("/foobar")).toEqual({ kind: "unknown", raw: "/foobar" });
	});
});
