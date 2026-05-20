import OpenAI from "openai";
import type { OpenAICodexRuntimeCredentials } from "../host/openai-codex-oauth/service.ts";
import { buildResponsesInput, buildResponsesParams } from "./openai/responses-request.ts";
import { streamResponsesEvents } from "./openai/responses-stream.ts";
import type { ProviderAdapter, ProviderModel, Request, Response, StreamEvent } from "./types.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_CLIENT_VERSION = "0.0.0";
const MISSING_TERMINAL_RESPONSE_ERROR =
	"OpenAI Codex response stream ended without terminal response";

export type OpenAICodexCredentialResolver = (
	providerId: string,
) => Promise<OpenAICodexRuntimeCredentials>;

export interface OpenAICodexAdapterOptions {
	providerId?: string;
	baseURL?: string;
	resolveCredentials: OpenAICodexCredentialResolver;
}

interface CodexModelsResponse {
	models?: Array<{
		slug?: unknown;
		model?: unknown;
		id?: unknown;
		display_name?: unknown;
	}>;
	data?: Array<{
		id?: unknown;
	}>;
}

export class OpenAICodexAdapter implements ProviderAdapter {
	readonly name = "openai-codex";
	readonly kind = "openai-codex" as const;
	readonly providerId: string;
	private readonly baseURL: string;
	private readonly resolveCredentials: OpenAICodexCredentialResolver;

	constructor(options: OpenAICodexAdapterOptions) {
		this.providerId = options.providerId ?? "openai-codex";
		this.baseURL = options.baseURL ?? DEFAULT_CODEX_BASE_URL;
		this.resolveCredentials = options.resolveCredentials;
	}

	async listModels(): Promise<ProviderModel[]> {
		const credentials = this.requestCredentials();
		const payload = await this.clientFor(credentials).get<CodexModelsResponse>("/models", {
			query: { client_version: CODEX_CLIENT_VERSION },
			headers: await this.headersFor(credentials),
		});
		if (
			(payload?.models !== undefined && !Array.isArray(payload.models)) ||
			(payload?.data !== undefined && !Array.isArray(payload.data)) ||
			(payload?.models === undefined && payload?.data === undefined)
		) {
			throw new Error("OpenAI Codex models response was malformed");
		}

		return [
			...(payload.models ?? []).flatMap(parseCodexModel),
			...(payload.data ?? []).flatMap(parseOpenAIDataModel),
		];
	}

	async checkConnection(): Promise<{ ok: true } | { ok: false; message: string }> {
		try {
			await this.listModels();
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async complete(request: Request): Promise<Response> {
		let finalResponse: Response | undefined;
		for await (const event of this.stream(request)) {
			if (event.type === "finish" && event.response) {
				finalResponse = event.response;
			}
		}
		if (!finalResponse) {
			throw new Error("OpenAI Codex response stream ended without a final response");
		}
		return finalResponse;
	}

	async *stream(request: Request): AsyncIterable<StreamEvent> {
		const credentials = this.requestCredentials();
		const stream = await this.createResponsesStream(request, credentials);

		for await (const event of streamResponsesEvents({ stream, request, provider: this.kind })) {
			if (event.type === "finish" && !hasTerminalResponse(event.response)) {
				throw new Error(MISSING_TERMINAL_RESPONSE_ERROR);
			}
			yield event;
		}
	}

	private requestCredentials(): Promise<OpenAICodexRuntimeCredentials> {
		return this.resolveCredentials(this.providerId);
	}

	private clientFor(credentials: Promise<OpenAICodexRuntimeCredentials>): OpenAI {
		return new OpenAI({
			apiKey: async () => (await credentials).accessToken,
			baseURL: this.baseURL,
		});
	}

	private async createResponsesStream(
		request: Request,
		credentials: Promise<OpenAICodexRuntimeCredentials>,
	): Promise<AsyncIterable<unknown>> {
		const resolved = await credentials;
		const response = await fetch(joinUrlPath(this.baseURL, "responses"), {
			method: "POST",
			headers: {
				accept: "text/event-stream",
				authorization: `Bearer ${resolved.accessToken}`,
				"chatgpt-account-id": resolved.accountId,
				"content-type": "application/json",
			},
			body: JSON.stringify(buildCodexResponsesParams(request)),
			signal: request.signal,
		});
		if (!response.ok) {
			throw new Error(await codexResponseErrorMessage("responses", response));
		}
		return readSseJsonEvents(response);
	}

	private async headersFor(
		credentials: Promise<OpenAICodexRuntimeCredentials>,
	): Promise<Record<string, string>> {
		const resolved = await credentials;
		return {
			"ChatGPT-Account-ID": resolved.accountId,
		};
	}
}

function buildCodexResponsesParams(request: Request): Record<string, unknown> {
	const input = buildResponsesInput(request);
	const params = buildResponsesParams(request, input) as Record<string, unknown>;
	// ChatGPT Codex accepts a narrower Responses body than api.openai.com.
	delete params.max_output_tokens;
	delete params.prompt_cache_retention;
	delete params.temperature;
	delete params.top_p;
	const reasoning = params.reasoning;
	return {
		...params,
		tools: params.tools ?? [],
		tool_choice: params.tool_choice ?? "auto",
		parallel_tool_calls: true,
		store: false,
		stream: true,
		include: reasoning ? ["reasoning.encrypted_content"] : [],
	};
}

function parseCodexModel(model: {
	slug?: unknown;
	model?: unknown;
	id?: unknown;
	display_name?: unknown;
}): ProviderModel[] {
	if (!model || typeof model !== "object") return [];
	const id = firstNonEmptyString(model.slug, model.model, model.id);
	if (!id) return [];
	return [
		{
			id,
			label: typeof model.display_name === "string" && model.display_name ? model.display_name : id,
			source: "remote",
		},
	];
}

function parseOpenAIDataModel(model: { id?: unknown }): ProviderModel[] {
	if (!model || typeof model !== "object") return [];
	const id = firstNonEmptyString(model.id);
	if (!id) return [];
	return [{ id, label: id, source: "remote" }];
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function hasTerminalResponse(response: Response | undefined): boolean {
	return Boolean(response?.id);
}

function joinUrlPath(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function codexResponseErrorMessage(
	endpoint: string,
	response: globalThis.Response,
): Promise<string> {
	const bodyText = await response.text().catch(() => "");
	const detail = codexErrorDetail(bodyText) ?? response.statusText;
	const suffix = detail ? ` ${detail}` : "";
	return `OpenAI Codex ${endpoint} request failed: ${response.status}${suffix}`;
}

function codexErrorDetail(bodyText: string): string | undefined {
	if (!bodyText.trim()) return undefined;
	try {
		const payload = JSON.parse(bodyText) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return bodyText;
		const record = payload as Record<string, unknown>;
		if (typeof record.detail === "string") return record.detail;
		const error = record.error;
		if (error && typeof error === "object" && !Array.isArray(error)) {
			const message = (error as Record<string, unknown>).message;
			if (typeof message === "string") return message;
		}
		return JSON.stringify(payload);
	} catch {
		return bodyText;
	}
}

async function* readSseJsonEvents(response: globalThis.Response): AsyncIterable<unknown> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const events = drainCompleteSseEvents(buffer);
			buffer = events.remainder;
			for (const data of events.data) {
				if (data === "[DONE]") return;
				yield parseSseJson(data);
			}
		}
		buffer += decoder.decode();
		const events = drainCompleteSseEvents(`${buffer}\n\n`);
		for (const data of events.data) {
			if (data === "[DONE]") return;
			yield parseSseJson(data);
		}
	} finally {
		reader.releaseLock();
	}
}

function drainCompleteSseEvents(buffer: string): { data: string[]; remainder: string } {
	const data: string[] = [];
	let remainder = buffer;
	while (true) {
		const boundary = nextSseBoundary(remainder);
		if (!boundary) break;
		const rawEvent = remainder.slice(0, boundary.index);
		remainder = remainder.slice(boundary.index + boundary.length);
		const eventData = parseSseData(rawEvent);
		if (eventData !== undefined) {
			data.push(eventData);
		}
	}
	return { data, remainder };
}

function nextSseBoundary(buffer: string): { index: number; length: number } | undefined {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf === -1 && crlf === -1) return undefined;
	if (lf === -1) return { index: crlf, length: 4 };
	if (crlf === -1 || lf < crlf) return { index: lf, length: 2 };
	return { index: crlf, length: 4 };
}

function parseSseData(rawEvent: string): string | undefined {
	const lines = rawEvent.split(/\r?\n/);
	const dataLines = lines
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trimStart());
	if (dataLines.length === 0) return undefined;
	return dataLines.join("\n");
}

function parseSseJson(data: string): unknown {
	try {
		return JSON.parse(data);
	} catch {
		throw new Error(`OpenAI Codex response stream emitted invalid JSON: ${data}`);
	}
}
