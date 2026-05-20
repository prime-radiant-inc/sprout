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
		const input = buildResponsesInput(request);
		const params = buildResponsesParams(request, input);
		const stream = await this.clientFor(credentials).responses.create(
			{ ...params, stream: true },
			{
				headers: await this.headersFor(credentials),
				signal: request.signal,
			},
		);

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

	private async headersFor(
		credentials: Promise<OpenAICodexRuntimeCredentials>,
	): Promise<Record<string, string>> {
		const resolved = await credentials;
		return {
			"ChatGPT-Account-ID": resolved.accountId,
		};
	}
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
