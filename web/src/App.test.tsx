import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "@shared/slash-commands.ts";
import {
	createCommandFromSlashCommand,
	createSwitchModelCommand,
} from "./App.tsx";

describe("App session model helpers", () => {
	test("slash-command path emits canonical selection payloads", () => {
		const slashCommand = parseSlashCommand("/model anthropic-main:claude-sonnet-4-6");
		if (!slashCommand || slashCommand.kind !== "switch_model") {
			throw new Error("Expected /model slash command");
		}

		expect(createCommandFromSlashCommand(slashCommand)).toEqual({
			kind: "switch_model",
			data: {
				selection: {
					kind: "model",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
			},
		});
	});

	test("status-bar path emits canonical session model selections directly", () => {
		expect(
			createSwitchModelCommand({
				kind: "model",
				model: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
			}),
		).toEqual({
			kind: "switch_model",
			data: {
				selection: {
					kind: "model",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
			},
		});
	});

	test("inherit slash-command stays canonical", () => {
		const slashCommand = parseSlashCommand("/model inherit");
		if (!slashCommand || slashCommand.kind !== "switch_model") {
			throw new Error("Expected /model slash command");
		}

		expect(createCommandFromSlashCommand(slashCommand)).toEqual({
			kind: "switch_model",
			data: {
				selection: {
					kind: "inherit",
				},
			},
		});
	});
});
