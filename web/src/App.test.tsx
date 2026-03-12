import { describe, expect, test } from "bun:test";
import type { SettingsSnapshot } from "@kernel/types.ts";
import { parseSlashCommand } from "@shared/slash-commands.ts";
import {
	createCommandFromSlashCommand,
	createSwitchModelCommand,
	normalizeWebSessionSelection,
} from "./App.tsx";

function makeSettings(): SettingsSnapshot {
	return {
		runtime: {
			secretBackend: {
				backend: "memory",
				available: true,
			},
			warnings: [],
		},
		settings: {
			version: 1,
			providers: [
				{
					id: "anthropic-main",
					kind: "anthropic",
					label: "Anthropic",
					enabled: true,
					discoveryStrategy: "remote-with-manual",
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
			],
			defaults: { selection: { kind: "none" } },
			routing: {
				providerPriority: ["anthropic-main"],
				tierOverrides: {},
			},
		},
		providers: [
			{
				providerId: "anthropic-main",
				hasSecret: true,
				validationErrors: [],
				connectionStatus: "ok",
				catalogStatus: "current",
			},
		],
		catalog: [
			{
				providerId: "anthropic-main",
				models: [
					{
						id: "claude-sonnet-4-6",
						label: "Claude Sonnet 4.6",
						tierHint: "balanced",
						rank: 10,
						source: "remote",
					},
				],
			},
		],
	};
}

describe("App session model helpers", () => {
	test("normalizes raw slash-command model input to a canonical model selection", () => {
		const selection = normalizeWebSessionSelection(
			{ kind: "unqualified_model", modelId: "claude-sonnet-4-6" },
			makeSettings(),
		);
		expect(selection).toEqual({
			kind: "model",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		});
	});

	test("slash-command path emits canonical selection payloads", () => {
		const slashCommand = parseSlashCommand("/model claude-sonnet-4-6");
		if (!slashCommand || slashCommand.kind !== "switch_model") {
			throw new Error("Expected /model slash command");
		}

		expect(createCommandFromSlashCommand(slashCommand, makeSettings())).toEqual({
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

		expect(createCommandFromSlashCommand(slashCommand, makeSettings())).toEqual({
			kind: "switch_model",
			data: {
				selection: {
					kind: "inherit",
				},
			},
		});
	});
});
