import OpenAI from "openai";
import type { OpenAICodexRuntimeCredentials } from "../host/openai-codex-oauth/service.ts";
import { buildResponsesInput, buildResponsesParams } from "./openai/responses-request.ts";
import { streamResponsesEvents } from "./openai/responses-stream.ts";
import type { ProviderAdapter, ProviderModel, Request, Response, StreamEvent } from "./types.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_CLIENT_VERSION = "0.0.0";

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
		display_name?: unknown;
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

		return (payload.models ?? []).flatMap((model) => {
			if (typeof model.slug !== "string" || !model.slug) return [];
			return [
				{
					id: model.slug,
					label:
						typeof model.display_name === "string" && model.display_name
							? model.display_name
							: model.slug,
					source: "remote" as const,
				},
			];
		});
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

		yield* streamResponsesEvents({ stream, request, provider: this.kind });
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
			Authorization: `Bearer ${resolved.accessToken}`,
			"ChatGPT-Account-ID": resolved.accountId,
		};
	}
}
