import { readFile } from "node:fs/promises";
import { Msg, type Request, type Response } from "../src/llm/types.ts";
import type { ProviderAdapter } from "../src/llm/types.ts";
import { Client } from "../src/llm/client.ts";
import { ProviderRegistry } from "../src/llm/provider-registry.ts";
import { resolveReplayPath } from "../src/replay/paths.ts";
import { REPLAY_SCHEMA_VERSION, type ReplayTurnRecord } from "../src/shared/replay.ts";
import { importSettingsFromEnv } from "../src/host/settings/env-import.ts";
import { createSecretStoreRuntime } from "../src/host/settings/secret-store.ts";
import { SettingsStore } from "../src/host/settings/store.ts";

export interface ReplayTurnSummary {
	turn: number;
	depth: number;
	agentId: string;
	provider: string;
	model: string;
	finishReason: string;
	inputTokens: number;
	outputTokens: number;
}

export interface ReplayTurnOptions {
	turn: number;
	systemPromptPrepend?: string;
	systemPromptAppend?: string;
	modelOverride?: string;
}

export interface ReplayTurnResult {
	request: Omit<Request, "signal">;
	response: Response;
}

export interface ReplayWorkshopDeps {
	loadClient?: () => Promise<Pick<Client, "complete">>;
}

export async function loadReplayLog(inputPath: string): Promise<ReplayTurnRecord[]> {
	const replayPath = resolveReplayPath(inputPath);
	const raw = await readFile(replayPath, "utf-8");
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	return lines.map((line, index) => parseReplayRecord(line, index + 1));
}

export async function listReplayTurns(inputPath: string): Promise<ReplayTurnSummary[]> {
	const records = await loadReplayLog(inputPath);
	return records.map((record) => ({
		turn: record.turn,
		depth: record.depth,
		agentId: record.agent_id,
		provider: record.request.provider ?? record.response.provider,
		model: record.request.model,
		finishReason: record.response.finish_reason.reason,
		inputTokens: record.response.usage?.input_tokens ?? 0,
		outputTokens: record.response.usage?.output_tokens ?? 0,
	}));
}

export async function showReplayTurn(inputPath: string, turn: number): Promise<ReplayTurnRecord> {
	const record = (await loadReplayLog(inputPath)).find((candidate) => candidate.turn === turn);
	if (!record) {
		throw new Error(`No replay turn ${turn} found in ${resolveReplayPath(inputPath)}`);
	}
	return record;
}

export async function replayTurn(
	inputPath: string,
	options: ReplayTurnOptions,
	deps: ReplayWorkshopDeps = {},
): Promise<ReplayTurnResult> {
	const record = await showReplayTurn(inputPath, options.turn);
	const request = buildReplayRequest(record, options);
	const client = await (deps.loadClient ?? loadWorkshopClient)();
	const response = await client.complete(request);
	return { request, response };
}

function parseReplayRecord(line: string, lineNumber: number): ReplayTurnRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(
			`Malformed replay JSONL at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Replay record at line ${lineNumber} must be an object`);
	}
	const record = parsed as Partial<ReplayTurnRecord>;
	if (record.schema_version !== REPLAY_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported replay schema version at line ${lineNumber}: ${String(record.schema_version)}`,
		);
	}
	if (
		typeof record.timestamp !== "string" ||
		typeof record.session_id !== "string" ||
		typeof record.agent_id !== "string" ||
		typeof record.depth !== "number" ||
		typeof record.turn !== "number" ||
		!record.request_context ||
		!record.request ||
		!record.response
	) {
		throw new Error(`Replay record at line ${lineNumber} is missing required fields`);
	}
	if (
		typeof record.request.model !== "string" ||
		typeof record.request.provider !== "string" ||
		!Array.isArray(record.request.messages)
	) {
		throw new Error(`Replay record at line ${lineNumber} has an invalid request shape`);
	}
	if (
		typeof record.response.model !== "string" ||
		typeof record.response.provider !== "string" ||
		!record.response.finish_reason ||
		typeof record.response.finish_reason.reason !== "string"
	) {
		throw new Error(`Replay record at line ${lineNumber} has an invalid response shape`);
	}
	return record as ReplayTurnRecord;
}

function buildReplayRequest(
	record: ReplayTurnRecord,
	options: ReplayTurnOptions,
): Omit<Request, "signal"> {
	const request = structuredClone(record.request) as Omit<Request, "signal">;
	const systemPrompt = `${options.systemPromptPrepend ?? ""}${record.request_context.system_prompt}${options.systemPromptAppend ?? ""}`;
	if (request.messages[0]?.role === "system") {
		request.messages[0] = Msg.system(systemPrompt);
	} else {
		request.messages.unshift(Msg.system(systemPrompt));
	}
	if (options.modelOverride) {
		const separator = options.modelOverride.indexOf(":");
		if (separator > 0) {
			request.provider = options.modelOverride.slice(0, separator);
			request.model = options.modelOverride.slice(separator + 1);
		} else {
			request.model = options.modelOverride;
		}
	}
	return request;
}

async function loadWorkshopClient(): Promise<Pick<Client, "complete">> {
	const settingsStore = new SettingsStore();
	const settingsLoadResult = await settingsStore.load();
	const { secretRefBackend, secretBackendState, secretStore } = createSecretStoreRuntime({
		env: process.env,
	});

	let settings = settingsLoadResult.settings;
	if (settingsLoadResult.source === "missing") {
		const imported = await importSettingsFromEnv({
			env: process.env,
			secretStore,
			secretBackend: secretRefBackend,
		});
		if (imported.settings.providers.length > 0) {
			settings = imported.settings;
		}
	}

	const registry = new ProviderRegistry({
		settings,
		secretStore,
		secretBackend: secretRefBackend,
		secretBackendState,
	});
	const providers: Record<string, ProviderAdapter> = {};
	for (const entry of await registry.getEntries()) {
		if (!entry.adapter || !entry.provider.enabled || entry.validationErrors.length > 0) {
			continue;
		}
		providers[entry.provider.id] = entry.adapter;
	}
	return Client.fromProviders(providers);
}
