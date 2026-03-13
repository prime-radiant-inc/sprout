import { describe, expect, test } from "bun:test";
import type { SessionSelectionSnapshot } from "../../src/host/session-selection.ts";
import type { SettingsCommand, SettingsSnapshot } from "../../src/host/settings/control-plane.ts";
import { createEmptySettings } from "../../src/host/settings/types.ts";
import type {
	CommandMessage as CanonicalCommandMessage,
	ServerMessage as CanonicalServerMessage,
} from "../../src/kernel/protocol.ts";
import {
	createCommandMessage,
	parseCommandMessage as parseCanonicalCommandMessage,
} from "../../src/kernel/protocol.ts";
import type { Command, SessionEvent } from "../../src/kernel/types.ts";
import type { CommandMessage, ServerMessage } from "../../src/web/protocol.ts";
import { parseCommandMessage as parseLegacyCommandMessage } from "../../src/web/protocol.ts";

function makeSettingsSnapshot(): SettingsSnapshot {
	return {
		runtime: {
			secretBackend: {
				backend: "memory",
				available: true,
			},
			warnings: [],
		},
		settings: createEmptySettings(),
		providers: [],
		catalog: [],
	};
}

function makeCurrentSelection(): SessionSelectionSnapshot {
	return {
		selection: {
			kind: "model",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		},
		resolved: {
			providerId: "anthropic-main",
			modelId: "claude-sonnet-4-6",
		},
		source: "session",
	};
}

describe("web protocol types", () => {
	test("ServerMessage event variant wraps a SessionEvent", () => {
		const event: SessionEvent = {
			kind: "plan_start",
			timestamp: Date.now(),
			agent_id: "root",
			depth: 0,
			data: { model: "claude-sonnet-4-6" },
		};
		const msg: ServerMessage = { type: "event", event };
		expect(msg.type).toBe("event");
		expect(msg.event.kind).toBe("plan_start");
		expect(msg.event.agent_id).toBe("root");
	});

	test("ServerMessage snapshot variant carries events and session info", () => {
		const events: SessionEvent[] = [
			{
				kind: "session_start",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: {},
			},
			{
				kind: "perceive",
				timestamp: 1001,
				agent_id: "root",
				depth: 0,
				data: { goal: "fix bug" },
			},
		];
		const msg: ServerMessage = {
			type: "snapshot",
			events,
			session: {
				id: "sess-1",
				status: "running",
				availableModels: [],
				currentModel: null,
				currentSelection: makeCurrentSelection(),
				pricingTable: null,
			},
			settings: makeSettingsSnapshot(),
		} as ServerMessage;
		expect(msg.type).toBe("snapshot");
		if (msg.type !== "snapshot") throw new Error("Expected snapshot");
		expect(msg.events).toHaveLength(2);
		expect(msg.session.id).toBe("sess-1");
		expect(msg.session.status).toBe("running");
		expect(msg.session.currentSelection).toEqual(makeCurrentSelection());
		expect(msg.settings).toEqual(makeSettingsSnapshot());
	});

	test("CommandMessage wraps a Command", () => {
		const command: Command = {
			kind: "submit_goal",
			data: { goal: "Write tests" },
		};
		const msg: CommandMessage = { type: "command", command };
		expect(msg.type).toBe("command");
		expect(msg.command.kind).toBe("submit_goal");
		if (msg.command.kind !== "submit_goal") throw new Error("Expected submit_goal");
		expect(msg.command.data.goal).toBe("Write tests");
	});
});

describe("canonical protocol module", () => {
	test("createCommandMessage produces a valid command envelope", () => {
		const command: Command = { kind: "interrupt", data: {} };
		const msg = createCommandMessage(command);
		expect(msg).toEqual({
			type: "command",
			command,
		});
	});

	test("canonical and legacy protocol types are structurally compatible", () => {
		const command: Command = { kind: "quit", data: {} };
		const canonicalCommandMessage: CanonicalCommandMessage = createCommandMessage(command);
		const legacyCommandMessage: CommandMessage = canonicalCommandMessage;
		expect(legacyCommandMessage.type).toBe("command");

		const event: SessionEvent = {
			kind: "plan_start",
			timestamp: Date.now(),
			agent_id: "root",
			depth: 0,
			data: {},
		};
		const canonicalServerMessage: CanonicalServerMessage = { type: "event", event };
		const legacyServerMessage: ServerMessage = canonicalServerMessage;
		expect(legacyServerMessage.type).toBe("event");
	});

	test("canonical parser accepts the same valid payloads as legacy parser", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "submit_goal", data: { goal: "Fix the bug" } },
		});
		expect(parseCanonicalCommandMessage(raw)).toEqual(parseLegacyCommandMessage(raw));
	});

	test("canonical parser accepts settings control-plane commands", () => {
		const commands: SettingsCommand[] = [
			{ kind: "get_settings", data: {} },
			{
				kind: "create_provider",
				data: {
					kind: "openrouter",
					label: "OpenRouter",
					discoveryStrategy: "remote-only",
					tierDefaults: {
						fast: "openai/gpt-4.1-mini",
					},
				},
			},
			{
				kind: "update_provider",
				data: {
					providerId: "openrouter-main",
					patch: {
						label: "Primary OpenRouter",
						tierDefaults: {
							balanced: "openai/gpt-4.1",
						},
					},
				},
			},
			{ kind: "delete_provider", data: { providerId: "openrouter-main" } },
			{
				kind: "set_provider_secret",
				data: { providerId: "openrouter-main", secret: "sk-test" },
			},
			{ kind: "delete_provider_secret", data: { providerId: "openrouter-main" } },
			{
				kind: "set_provider_enabled",
				data: { providerId: "openrouter-main", enabled: true },
			},
			{ kind: "test_provider_connection", data: { providerId: "openrouter-main" } },
			{ kind: "refresh_provider_models", data: { providerId: "openrouter-main" } },
			{ kind: "set_default_provider", data: { providerId: "openrouter-main" } },
		];

		for (const command of commands) {
			const raw = JSON.stringify({ type: "command", command });
			expect(parseCanonicalCommandMessage(raw)).toEqual(parseLegacyCommandMessage(raw));
		}
	});

	test("canonical parser rejects malformed settings control-plane payloads", () => {
		expect(() =>
			parseCanonicalCommandMessage(
				JSON.stringify({
					type: "command",
					command: {
						kind: "create_provider",
						data: {
							kind: "openrouter",
							label: "",
							discoveryStrategy: "remote-only",
						},
					},
				}),
			),
		).toThrow("label");

		expect(() =>
			parseCanonicalCommandMessage(
				JSON.stringify({
					type: "command",
					command: {
						kind: "create_provider",
						data: {
							kind: "openrouter",
							label: "OpenRouter",
							discoveryStrategy: "remote-only",
							manualModels: [{ id: 42 }],
						},
					},
				}),
			),
		).toThrow("manualModels");

		expect(() =>
			parseCanonicalCommandMessage(
				JSON.stringify({
					type: "command",
					command: {
						kind: "update_provider",
						data: {
							providerId: "openrouter-main",
							patch: "bad-patch",
						},
					},
				}),
			),
		).toThrow("patch");

		expect(() =>
			parseCanonicalCommandMessage(
				JSON.stringify({
					type: "command",
					command: {
						kind: "update_provider",
						data: {
							providerId: "openrouter-main",
							patch: {
								tierDefaults: {
									best: 42,
								},
							},
						},
					},
				}),
			),
		).toThrow("tierDefaults");

		expect(() =>
			parseCanonicalCommandMessage(
				JSON.stringify({
					type: "command",
					command: {
						kind: "set_default_provider",
						data: {
							providerId: 42,
						},
					},
				}),
			),
		).toThrow("providerId");
	});
});

describe("parseCommandMessage", () => {
	test("parses a valid submit_goal command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "submit_goal", data: { goal: "Fix the bug" } },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.type).toBe("command");
		expect(msg.command.kind).toBe("submit_goal");
		if (msg.command.kind !== "submit_goal") throw new Error("Expected submit_goal");
		expect(msg.command.data.goal).toBe("Fix the bug");
	});

	test("parses a valid steer command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "steer", data: { message: "Focus on auth" } },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.command.kind).toBe("steer");
		if (msg.command.kind !== "steer") throw new Error("Expected steer");
		expect(msg.command.data.message).toBe("Focus on auth");
	});

	test("parses a valid interrupt command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "interrupt", data: {} },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.command.kind).toBe("interrupt");
	});

	test("parses a valid quit command", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit", data: {} },
		});
		const msg = parseLegacyCommandMessage(raw);
		expect(msg.command.kind).toBe("quit");
	});

	test("throws when command.kind is unknown", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "custom_thing", data: { foo: "bar" } },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("Unknown command kind");
	});

	test("throws on invalid JSON", () => {
		expect(() => parseLegacyCommandMessage("not json{")).toThrow("Invalid JSON");
	});

	test("throws on non-object JSON (string)", () => {
		expect(() => parseLegacyCommandMessage('"just a string"')).toThrow("must be a JSON object");
	});

	test("throws on non-object JSON (array)", () => {
		expect(() => parseLegacyCommandMessage("[1, 2, 3]")).toThrow("must be a JSON object");
	});

	test("throws on null JSON", () => {
		expect(() => parseLegacyCommandMessage("null")).toThrow("must be a JSON object");
	});

	test("throws on missing type field", () => {
		const raw = JSON.stringify({
			command: { kind: "quit", data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("type");
	});

	test("throws on wrong type field value", () => {
		const raw = JSON.stringify({
			type: "event",
			command: { kind: "quit", data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("type");
	});

	test("throws on missing command field", () => {
		const raw = JSON.stringify({ type: "command" });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is not an object", () => {
		const raw = JSON.stringify({ type: "command", command: "quit" });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is null", () => {
		const raw = JSON.stringify({ type: "command", command: null });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command is an array", () => {
		const raw = JSON.stringify({ type: "command", command: [1, 2] });
		expect(() => parseLegacyCommandMessage(raw)).toThrow("command");
	});

	test("throws when command.kind is missing", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("kind");
	});

	test("throws when command.kind is not a string", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: 42, data: {} },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("kind");
	});

	test("throws when command.data is missing", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit" },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("data");
	});

	test("throws when command.data is not an object", () => {
		const raw = JSON.stringify({
			type: "command",
			command: { kind: "quit", data: "not-an-object" },
		});
		expect(() => parseLegacyCommandMessage(raw)).toThrow("data");
	});
});
