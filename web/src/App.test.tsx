import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "@shared/slash-commands.ts";
import {
	computeActiveWorkForStatus,
	createCommandFromSlashCommand,
	createSwitchModelCommand,
	getSettingsProviderFromSearch,
	shouldOpenSettingsFromSearch,
} from "./App.tsx";
import type { SessionEvent } from "@kernel/types.ts";
import type { SessionStatus } from "./hooks/useEvents.ts";

function makeEvent(kind: SessionEvent["kind"], data: Record<string, unknown>): SessionEvent {
	return {
		kind,
		timestamp: Date.now(),
		agent_id: "session",
		depth: 0,
		data,
	};
}

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
	return {
		status: "idle",
		model: "",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		sessionId: "new-session",
		availableModels: [],
		currentSelection: {
			selection: { kind: "inherit" },
			source: "runtime-fallback",
		},
		sessionStartedAt: null,
		pricingTable: null,
		...overrides,
	};
}

describe("App session model helpers", () => {
	test("active work derivation ignores stale retained memory lifecycle events", () => {
		const activeWork = computeActiveWorkForStatus(
			[
				makeEvent("context_update", {
					memory_collapse: "started",
					session_id: "old-session",
				}),
			],
			makeStatus({ status: "running", sessionId: "new-session" }),
		);

		expect(activeWork).toBeNull();
	});

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

describe("shouldOpenSettingsFromSearch", () => {
	test("opens provider settings after an OAuth callback return", () => {
		expect(shouldOpenSettingsFromSearch("?settings=providers&provider=openai-codex")).toBe(
			true,
		);
		expect(shouldOpenSettingsFromSearch("?token=nonce&settings=providers")).toBe(true);
		expect(shouldOpenSettingsFromSearch("?token=nonce")).toBe(false);
		expect(getSettingsProviderFromSearch("?settings=providers&provider=openai-codex")).toBe(
			"openai-codex",
		);
		expect(getSettingsProviderFromSearch("?settings=providers&provider=")).toBeUndefined();
	});
});
