import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenAIAdapter } from "./openai.ts";
import type { ProviderAdapter, Request, Response, StreamEvent } from "./types.ts";

export type Middleware = (
	request: Request,
	next: (request: Request) => Promise<Response>,
) => Promise<Response>;

export interface ClientOptions {
	providers?: Record<string, ProviderAdapter>;
	defaultProvider?: string;
	middleware?: Middleware[];
}

/**
 * Unified LLM client that routes requests to provider adapters.
 * Supports middleware for cross-cutting concerns.
 */
export class Client {
	private adapters: Map<string, ProviderAdapter>;
	private defaultProvider: string | undefined;
	private middlewareChain: Middleware[];

	constructor(options: ClientOptions = {}) {
		this.adapters = new Map(Object.entries(options.providers ?? {}));
		this.defaultProvider = options.defaultProvider;
		this.middlewareChain = options.middleware ?? [];

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
	static fromEnv(options: { middleware?: Middleware[] } = {}): Client {
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

		return new Client({
			providers,
			middleware: options.middleware,
		});
	}

	/** List registered provider names */
	providers(): string[] {
		return [...this.adapters.keys()];
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

	/** Send a request and return an async iterator of stream events */
	async *stream(request: Request): AsyncIterable<StreamEvent> {
		const adapter = this.resolveAdapter(request);
		yield* adapter.stream(request);
	}
}
