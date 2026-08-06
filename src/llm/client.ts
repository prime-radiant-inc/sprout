import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenAIAdapter } from "./openai.ts";
import { DEFAULT_STREAM_READ_TIMEOUT_MS, withStreamReadTimeout } from "./stream-timeout.ts";
import type { ProviderAdapter, ProviderModel, Request, Response, StreamEvent } from "./types.ts";

export type Middleware = (
	request: Request,
	next: (request: Request) => Promise<Response>,
) => Promise<Response>;

/**
 * Observes the outgoing request at the moment it is dispatched to the adapter —
 * on BOTH the complete() and stream() paths, unlike middleware which only wraps
 * complete(). Purely read-only: the return value is ignored and the request/
 * response are never altered, so observers cannot change production behavior.
 */
export type RequestObserver = (request: Request) => void;

export interface ClientOptions {
	providers?: Record<string, ProviderAdapter>;
	defaultProvider?: string;
	middleware?: Middleware[];
	requestObservers?: RequestObserver[];
	/** Max time (ms) between consecutive stream chunks. 0 to disable. */
	streamReadTimeoutMs?: number;
}

export function parseStreamReadTimeoutFromEnv(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error("SPROUT_STREAM_READ_TIMEOUT_MS must be >= 0 and finite (0 to disable)");
	}
	return parsed;
}

export function resolveStreamReadTimeoutOverride(explicit?: number): number | undefined {
	return explicit ?? parseStreamReadTimeoutFromEnv(process.env.SPROUT_STREAM_READ_TIMEOUT_MS);
}

/**
 * Unified LLM client that routes requests to provider adapters.
 * Supports middleware for cross-cutting concerns.
 */
export class Client {
	private adapters: Map<string, ProviderAdapter>;
	private defaultProvider: string | undefined;
	private middlewareChain: Middleware[];
	private requestObservers: RequestObserver[];
	private streamReadTimeoutMs: number;

	constructor(options: ClientOptions = {}) {
		this.adapters = new Map(Object.entries(options.providers ?? {}));
		this.defaultProvider = options.defaultProvider;
		this.middlewareChain = options.middleware ?? [];
		this.requestObservers = options.requestObservers ?? [];
		this.streamReadTimeoutMs = options.streamReadTimeoutMs ?? DEFAULT_STREAM_READ_TIMEOUT_MS;
		if (
			this.streamReadTimeoutMs !== 0 &&
			(!Number.isFinite(this.streamReadTimeoutMs) || this.streamReadTimeoutMs < 0)
		) {
			throw new Error("streamReadTimeoutMs must be >= 0 and finite (0 to disable)");
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
	static fromEnv(
		options: { middleware?: Middleware[]; streamReadTimeoutMs?: number } = {},
	): Client {
		const providers: Record<string, ProviderAdapter> = {};
		const streamReadTimeoutMs = resolveStreamReadTimeoutOverride(options.streamReadTimeoutMs);

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
			streamReadTimeoutMs,
		});
	}

	static fromProviders(
		providers: Record<string, ProviderAdapter>,
		options: {
			defaultProvider?: string;
			middleware?: Middleware[];
			streamReadTimeoutMs?: number;
		} = {},
	): Client {
		return new Client({
			providers,
			defaultProvider: options.defaultProvider,
			middleware: options.middleware,
			streamReadTimeoutMs: resolveStreamReadTimeoutOverride(options.streamReadTimeoutMs),
		});
	}

	/**
	 * Register a request observer invoked with the request as it is dispatched to
	 * the adapter, on both the complete() and stream() paths. Returns a function
	 * that removes the observer.
	 */
	onRequest(observer: RequestObserver): () => void {
		this.requestObservers.push(observer);
		return () => {
			const i = this.requestObservers.indexOf(observer);
			if (i !== -1) this.requestObservers.splice(i, 1);
		};
	}

	private notifyRequestObservers(request: Request): void {
		for (const observer of this.requestObservers) observer(request);
	}

	/** List registered provider names */
	providers(): string[] {
		return [...this.adapters.keys()];
	}

	/** Replace the active provider set without rebuilding the client instance. */
	replaceProviders(providers: Record<string, ProviderAdapter>, defaultProvider?: string): void {
		this.adapters = new Map(Object.entries(providers));
		if (defaultProvider && this.adapters.has(defaultProvider)) {
			this.defaultProvider = defaultProvider;
			return;
		}
		this.defaultProvider = this.adapters.keys().next().value;
	}

	/** Query all providers for their available models. */
	async listModelsByProvider(): Promise<Map<string, ProviderModel[]>> {
		const result = new Map<string, ProviderModel[]>();
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

		// Build the middleware chain. The observer fires at the adapter-dispatch
		// seam so it sees the exact request bytes handed to the provider, after any
		// middleware transform.
		const baseCall = (req: Request) => {
			this.notifyRequestObservers(req);
			return adapter.complete(req);
		};
		const chain = this.middlewareChain.reduceRight<(req: Request) => Promise<Response>>(
			(next, mw) => (req) => mw(req, next),
			baseCall,
		);

		return chain(request);
	}

	/** Send a request and return an async iterator of stream events. */
	async *stream(request: Request): AsyncIterable<StreamEvent> {
		const adapter = this.resolveAdapter(request);
		this.notifyRequestObservers(request);
		const rawStream = adapter.stream(request);

		if (this.streamReadTimeoutMs > 0) {
			yield* withStreamReadTimeout(rawStream, this.streamReadTimeoutMs, request.signal);
		} else {
			yield* rawStream;
		}
	}
}
