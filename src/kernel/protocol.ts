import type { PricingTable } from "./pricing.ts";
import type {
	Command,
	SessionEvent,
	SessionSelectionSnapshot,
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "./types.ts";

/** Server -> Browser: a single live event */
export interface EventServerMessage {
	type: "event";
	event: SessionEvent;
}

/** Server -> Browser: full state snapshot on initial connection */
export interface SnapshotServerMessage {
	type: "snapshot";
	events: SessionEvent[];
	session: {
		id: string;
		status: string;
		availableModels: string[];
		currentModel: string | null;
		currentSelection: SessionSelectionSnapshot;
		pricingTable: PricingTable | null;
	};
	settings: SettingsSnapshot | null;
}

/** Server -> Browser: settings snapshot changed live */
export interface SettingsUpdatedServerMessage {
	type: "settings_updated";
	snapshot: SettingsSnapshot;
}

/** Server -> Browser: result of a settings command */
export interface SettingsResultServerMessage {
	type: "settings_result";
	result: SettingsCommandResult;
}

/** All message types the server sends to the browser */
export type ServerMessage =
	| EventServerMessage
	| SnapshotServerMessage
	| SettingsUpdatedServerMessage
	| SettingsResultServerMessage;

export type BrowserCommand = Command | SettingsCommand;

/** Browser -> Server: a user command */
export interface CommandMessage {
	type: "command";
	command: BrowserCommand;
}

const VALID_COMMAND_KINDS = new Set([
	"submit_goal",
	"steer",
	"interrupt",
	"compact",
	"clear",
	"switch_model",
	"quit",
	"get_settings",
	"create_provider",
	"update_provider",
	"delete_provider",
	"set_provider_secret",
	"delete_provider_secret",
	"set_provider_enabled",
	"test_provider_connection",
	"refresh_provider_models",
	"set_global_tier_default",
	"set_default_provider",
]);

const SETTINGS_COMMAND_KINDS = new Set([
	"get_settings",
	"create_provider",
	"update_provider",
	"delete_provider",
	"set_provider_secret",
	"delete_provider_secret",
	"set_provider_enabled",
	"test_provider_connection",
	"refresh_provider_models",
	"set_global_tier_default",
	"set_default_provider",
]);

const PROVIDER_KINDS = new Set([
	"anthropic",
	"openai",
	"openai-compatible",
	"openrouter",
	"gemini",
]);
const DISCOVERY_STRATEGIES = new Set(["remote-only", "manual-only", "remote-with-manual"]);
const TIERS = new Set(["best", "balanced", "fast"]);
/** Build a command envelope for transport from browser to server. */
export function createCommandMessage(command: BrowserCommand): CommandMessage {
	return { type: "command", command };
}

/**
 * Parse a raw JSON string into a validated CommandMessage.
 * Validates structure and command kind.
 * Throws on invalid JSON, missing fields, or wrong types.
 */
export function parseCommandMessage(raw: string): CommandMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid JSON: ${raw.slice(0, 100)}`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Command message must be a JSON object");
	}

	const obj = parsed as Record<string, unknown>;

	if (obj.type !== "command") {
		throw new Error(`Invalid or missing type: ${JSON.stringify(obj.type)}. Expected "command"`);
	}

	const command = obj.command;
	if (command === null || typeof command !== "object" || Array.isArray(command)) {
		throw new Error("'command' must be an object with kind (string) and data (object)");
	}

	const cmd = command as Record<string, unknown>;

	if (typeof cmd.kind !== "string") {
		throw new Error(`'command.kind' must be a string, got ${JSON.stringify(cmd.kind)}`);
	}
	if (!VALID_COMMAND_KINDS.has(cmd.kind)) {
		throw new Error(`Unknown command kind: ${JSON.stringify(cmd.kind)}`);
	}

	if (cmd.data === null || typeof cmd.data !== "object" || Array.isArray(cmd.data)) {
		throw new Error("'command.data' must be an object");
	}

	if (SETTINGS_COMMAND_KINDS.has(cmd.kind)) {
		validateSettingsCommand(cmd.kind, cmd.data as Record<string, unknown>);
	}

	return obj as unknown as CommandMessage;
}

function validateSettingsCommand(kind: string, data: Record<string, unknown>): void {
	switch (kind) {
		case "get_settings":
			assertOnlyKnownKeys(data, [], "command.data");
			return;
		case "create_provider":
			assertOnlyKnownKeys(
				data,
				["kind", "label", "baseUrl", "nonSecretHeaders", "discoveryStrategy", "manualModels"],
				"command.data",
			);
			assertEnum(data.kind, PROVIDER_KINDS, "command.data.kind");
			assertNonEmptyString(data.label, "command.data.label");
			assertEnum(data.discoveryStrategy, DISCOVERY_STRATEGIES, "command.data.discoveryStrategy");
			assertOptionalString(data.baseUrl, "command.data.baseUrl");
			assertOptionalStringRecord(data.nonSecretHeaders, "command.data.nonSecretHeaders");
			assertOptionalManualModels(data.manualModels, "command.data.manualModels");
			return;
		case "update_provider": {
			assertOnlyKnownKeys(data, ["providerId", "patch"], "command.data");
			assertNonEmptyString(data.providerId, "command.data.providerId");
			assertRecord(data.patch, "command.data.patch");
			const patch = data.patch as Record<string, unknown>;
			assertOnlyKnownKeys(
				patch,
				["label", "baseUrl", "nonSecretHeaders", "discoveryStrategy", "manualModels"],
				"command.data.patch",
			);
			if (patch.label !== undefined) {
				assertNonEmptyString(patch.label, "command.data.patch.label");
			}
			if (patch.baseUrl !== undefined) {
				assertString(patch.baseUrl, "command.data.patch.baseUrl");
			}
			if (patch.discoveryStrategy !== undefined) {
				assertEnum(
					patch.discoveryStrategy,
					DISCOVERY_STRATEGIES,
					"command.data.patch.discoveryStrategy",
				);
			}
			assertOptionalStringRecord(patch.nonSecretHeaders, "command.data.patch.nonSecretHeaders");
			assertOptionalManualModels(patch.manualModels, "command.data.patch.manualModels");
			return;
		}
		case "delete_provider":
		case "delete_provider_secret":
		case "test_provider_connection":
		case "refresh_provider_models":
			assertOnlyKnownKeys(data, ["providerId"], "command.data");
			assertNonEmptyString(data.providerId, "command.data.providerId");
			return;
		case "set_provider_secret":
			assertOnlyKnownKeys(data, ["providerId", "secret"], "command.data");
			assertNonEmptyString(data.providerId, "command.data.providerId");
			assertNonEmptyString(data.secret, "command.data.secret");
			return;
		case "set_provider_enabled":
			assertOnlyKnownKeys(data, ["providerId", "enabled"], "command.data");
			assertNonEmptyString(data.providerId, "command.data.providerId");
			assertBoolean(data.enabled, "command.data.enabled");
			return;
		case "set_global_tier_default":
			assertOnlyKnownKeys(data, ["tier", "model"], "command.data");
			assertEnum(data.tier, TIERS, "command.data.tier");
			assertOptionalModelRef(data.model, "command.data.model");
			return;
		case "set_default_provider":
			assertOnlyKnownKeys(data, ["providerId"], "command.data");
			if (data.providerId !== undefined) {
				assertNonEmptyString(data.providerId, "command.data.providerId");
			}
			return;
	}
}

function assertOnlyKnownKeys(
	value: Record<string, unknown>,
	allowedKeys: string[],
	path: string,
): void {
	const allowedKeySet = new Set(allowedKeys);
	for (const key of Object.keys(value)) {
		if (!allowedKeySet.has(key)) {
			throw new Error(`${path}.${key} is not allowed`);
		}
	}
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
}

function assertString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string") {
		throw new Error(`${path} must be a string`);
	}
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
	assertString(value, path);
	if (!value.trim()) {
		throw new Error(`${path} must be a non-empty string`);
	}
}

function assertOptionalString(value: unknown, path: string): void {
	if (value === undefined) return;
	assertString(value, path);
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${path} must be a boolean`);
	}
}

function assertEnum(value: unknown, valid: Set<string>, path: string): asserts value is string {
	assertString(value, path);
	if (!valid.has(value)) {
		throw new Error(`${path} must be one of: ${[...valid].join(", ")}`);
	}
}

function assertOptionalStringRecord(value: unknown, path: string): void {
	if (value === undefined) return;
	assertRecord(value, path);
	for (const [key, entry] of Object.entries(value)) {
		if (!key.trim()) {
			throw new Error(`${path} keys must be non-empty strings`);
		}
		assertString(entry, `${path}.${key}`);
	}
}

function assertOptionalManualModels(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		throw new Error(`${path} must be an array`);
	}
	for (const [index, item] of value.entries()) {
		assertRecord(item, `${path}[${index}]`);
		assertNonEmptyString(item.id, `${path}[${index}].id`);
		if (item.label !== undefined) {
			assertString(item.label, `${path}[${index}].label`);
		}
	}
}

function assertOptionalModelRef(value: unknown, path: string): void {
	if (value === undefined) return;
	assertRecord(value, path);
	assertNonEmptyString(value.providerId, `${path}.providerId`);
	assertNonEmptyString(value.modelId, `${path}.modelId`);
}
