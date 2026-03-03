import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenAIAdapter } from "./openai.ts";
import { DEFAULT_STREAM_READ_TIMEOUT_MS, withStreamReadTimeout } from "./stream-timeout.ts";
import type { ProviderAdapter, Request, Response, StreamEvent } from "./types.ts";

export type Middleware = (
	request: Request,
	next: (request: Request) => Promise<Response>,
) => Promise<Response>;

export interface ClientOptions {
	providers?: Record<string, ProviderAdapter>;
	defaultProvider?: string;
	middleware?: Middleware[];
	/** Max time (ms) between consecutive stream chunks. 0 to disable. Default: 30s. */
	streamReadTimeoutMs?: number;
}

/**
 * Unified LLM client that routes requests to provider adapters.
 * Supports middleware for cross-cutting concerns.
 */
export class Client {
	private adapters: Map<string, ProviderAdapter>;
	private defaultProvider: string | undefined;
	private middlewareChain: Middleware[];
	private streamReadTimeoutMs: number;

	constructor(options: ClientOptions = {}) {
		this.adapters = new Map(Object.entries(options.providers ?? {}));
		this.defaultProvider = options.defaultProvider;
		this.middlewareChain = options.middleware ?? [];
		this.streamReadTimeoutMs = options.streamReadTimeoutMs ?? DEFAULT_STREAM_READ_TIMEOUT_MS;
		if (this.streamReadTimeoutMs < 0 || Number.isNaN(this.streamReadTimeoutMs)) {
			throw new Error("streamReadTimeoutMs must be >= 0 (0 to disable)");
		}

		// Auto-set default if not specified
		if (!this.defaultProvider && this.adapters.size > 0) {
			this.defaultProvider = this.adapters.keys().next().value;
		}
	}

	/**
	 * Create a client from environment variables.
	 * Only providers with keys present are registered.
	 * The first registered provider becomes the default.
	 */
	static fromEnv(options: { middleware?: Middleware[]; streamReadTimeoutMs?: number } = {}): Client {
		const providers: Record<string, ProviderAdapter> = {};

		const anthropicKey = process.env.ANTHROPIC_API_KEY;
		if (anthropicKey) {
			providers.anthropic = new AnthropicAdapter(anthropicKey);
		}

		const openaiKey = process.env.OPENAI_API_KEY;
		if (openaiKey) {
			providers.openai = new OpenAIAdapter(openaiKey);
		}

		const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
		if (geminiKey) {
			providers.gemini = new GeminiAdapter(geminiKey);
		}

		if (Object.keys(providers).length === 0) {
			console.warn(
				"[LLM] No LLM API keys found in environment. " +
					"Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY. " +
					"Check that your .env file is in the working directory or export the variables directly.",
			);
		}

		return new Client({
			providers,
			middleware: options.middleware,
			streamReadTimeoutMs: options.streamReadTimeoutMs,
		});
	}

	/** List registered provider names */
	providers(): string[] {
		return [...this.adapters.keys()];
	}

	/** Query all providers for their available models. */
	async listModelsByProvider(): Promise<Map<string, string[]>> {
		const result = new Map<string, string[]>();
		for (const [name, adapter] of this.adapters) {
			try {
				result.set(name, await adapter.listModels());
			} catch {
				result.set(name, []);
			}
		}
		return result;
	}

	/** Get a specific adapter */
	adapter(name: string): ProviderAdapter | undefined {
		return this.adapters.get(name);
	}

	private resolveAdapter(request: Request): ProviderAdapter {
		const providerName = request.provider ?? this.defaultProvider;
		if (!providerName) {
			throw new Error(
				"No provider specified and no default provider configured. " +
					"Set the 'provider' field on the request or configure a default.",
			);
		}
		const adapter = this.adapters.get(providerName);
		if (!adapter) {
			throw new Error(
				`Provider '${providerName}' is not registered. ` +
					`Available providers: ${[...this.adapters.keys()].join(", ")}`,
			);
		}
		return adapter;
	}

	/** Send a request and block until the model finishes */
	async complete(request: Request): Promise<Response> {
		const adapter = this.resolveAdapter(request);

		// Build the middleware chain
		const baseCall = (req: Request) => adapter.complete(req);
		const chain = this.middlewareChain.reduceRight<(req: Request) => Promise<Response>>(
			(next, mw) => (req) => mw(req, next),
			baseCall,
		);

		return chain(request);
	}

	/** Send a request and return an async iterator of stream events.
	 * NOTE: Only request-transforming middleware is applied for streaming.
	 * Middleware that wraps or modifies the response will not take effect here. */
	async *stream(request: Request): AsyncIterable<StreamEvent> {
		// Apply middleware to transform the request, then stream with the result.
		let finalRequest = request;

		if (this.middlewareChain.length > 0) {
			// Build a chain that captures the final transformed request
			// instead of actually calling the adapter
			const captureRequest = async (req: Request): Promise<Response> => {
				finalRequest = req;
				// Return a dummy response — we only need the request transformation
				return {
					id: "",
					model: req.model,
					provider: "",
					message: { role: "assistant", content: [] },
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				};
			};

			const chain = this.middlewareChain.reduceRight<(req: Request) => Promise<Response>>(
				(next, mw) => (req) => mw(req, next),
				captureRequest,
			);
			await chain(request);
		}

		const adapter = this.resolveAdapter(finalRequest);
		const rawStream = adapter.stream(finalRequest);

		if (this.streamReadTimeoutMs > 0) {
			yield* withStreamReadTimeout(rawStream, this.streamReadTimeoutMs, finalRequest.signal);
		} else {
			yield* rawStream;
		}
	}
}
