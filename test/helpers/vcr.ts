import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "../../src/llm/client.ts";
import type { ProviderAdapter, Request, Response, StreamEvent } from "../../src/llm/types.ts";

type VcrMode = "record" | "replay" | "off";

// ---------------------------------------------------------------------------
// Cassette entry types
// ---------------------------------------------------------------------------

interface VcrCompleteEntry {
	type: "complete";
	request: Request;
	response: Response;
}

interface VcrStreamEntry {
	type: "stream";
	request: Request;
	events: StreamEvent[];
}

type VcrEntry = VcrCompleteEntry | VcrStreamEntry;

/** Legacy format: no type field, always a complete call */
interface VcrLegacyEntry {
	request: Request;
	response: Response;
}

interface VcrCassette {
	recordings: (VcrEntry | VcrLegacyEntry)[];
	metadata: {
		recordedAt: string;
		testName: string;
		providers: string[];
		/** Adapter name, stored for adapter-level VCR replay */
		adapterName?: string;
	};
}

/** Normalize a legacy entry (no type field) to a VcrCompleteEntry */
function normalizeEntry(entry: VcrEntry | VcrLegacyEntry): VcrEntry {
	if ("type" in entry) return entry;
	return { type: "complete", request: entry.request, response: entry.response };
}

// ---------------------------------------------------------------------------
// Client VCR options
// ---------------------------------------------------------------------------

/** Minimal interface for record mode — stream() is optional for backward compat */
interface VcrRealClient {
	complete(request: Request): Promise<Response>;
	stream?: (request: Request) => AsyncIterable<StreamEvent>;
	providers(): string[];
}

interface VcrOptions {
	fixtureDir: string;
	testName: string;
	mode?: VcrMode;
	substitutions?: Record<string, string>;
	/** Required for record mode. Not needed for replay. */
	realClient?: VcrRealClient;
}

// ---------------------------------------------------------------------------
// Adapter VCR options
// ---------------------------------------------------------------------------

interface AdapterVcrOptions {
	fixtureDir: string;
	testName: string;
	mode?: VcrMode;
	/** Required for record/off mode. Not needed for replay. */
	realAdapter?: ProviderAdapter;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Sort substitution entries so longer values are replaced first.
 * Prevents partial matches when one path is a prefix of another.
 */
function sortedSubstitutions(subs: Record<string, string>): [string, string][] {
	return Object.entries(subs).sort(([, a], [, b]) => b.length - a.length);
}

function substituteForRecording(obj: unknown, subs: Record<string, string>): unknown {
	let json = JSON.stringify(obj);
	for (const [placeholder, realValue] of sortedSubstitutions(subs)) {
		json = json.replaceAll(realValue, placeholder);
	}
	return JSON.parse(json);
}

function substituteForReplay(obj: unknown, subs: Record<string, string>): unknown {
	let json = JSON.stringify(obj);
	for (const [placeholder, realValue] of sortedSubstitutions(subs)) {
		json = json.replaceAll(placeholder, realValue);
	}
	return JSON.parse(json);
}

function stripRaw(response: Response): Response {
	const { raw: _, ...clean } = response;
	return clean;
}

function fixturePath(fixtureDir: string, testName: string): string {
	return join(fixtureDir, `${testName}.json`);
}

function resolveMode(opts: { mode?: VcrMode; fixtureDir: string; testName: string }): VcrMode {
	// Explicit mode takes precedence (important for VCR's own unit tests)
	if (opts.mode) return opts.mode;
	const envMode = process.env.VCR_MODE;
	if (envMode) return envMode as VcrMode;
	// Default: replay if fixture exists, error if not
	if (existsSync(fixturePath(opts.fixtureDir, opts.testName))) return "replay";
	return "replay"; // Will error when trying to load
}

function loadCassette(path: string): VcrCassette {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function saveCassette(path: string, cassette: VcrCassette): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cassette, null, 2));
}

function nextEntry(
	cassette: VcrCassette,
	callIndex: number,
	testName: string,
): { entry: VcrEntry; nextIndex: number } {
	if (callIndex >= cassette.recordings.length) {
		throw new Error(
			`VCR recordings exhausted for '${testName}': ` +
				`only ${cassette.recordings.length} recorded calls, ` +
				`but call #${callIndex + 1} was attempted.`,
		);
	}
	const entry = normalizeEntry(cassette.recordings[callIndex]!);
	return { entry, nextIndex: callIndex + 1 };
}

// ---------------------------------------------------------------------------
// Client VCR
// ---------------------------------------------------------------------------

/**
 * Create a VCR client for an integration test.
 *
 * In record mode, delegates to a real LLM client and captures responses.
 * In replay mode, returns previously recorded responses sequentially.
 * Supports both complete() and stream() calls.
 */
export function createVcr(opts: VcrOptions): {
	client: Client;
	afterTest: () => Promise<void>;
} {
	const mode = resolveMode(opts);
	const subs = opts.substitutions ?? {};

	if (mode === "off") {
		return createClientPassthrough(opts);
	}
	if (mode === "record") {
		return createClientRecorder(opts, subs);
	}
	return createClientReplayer(opts, subs);
}

function createClientPassthrough(opts: VcrOptions): {
	client: Client;
	afterTest: () => Promise<void>;
} {
	const realClient = opts.realClient;
	if (!realClient) {
		throw new Error("VCR off mode requires a realClient");
	}
	return {
		client: realClient as Client,
		afterTest: async () => {},
	};
}

function createClientRecorder(
	opts: VcrOptions,
	subs: Record<string, string>,
): { client: Client; afterTest: () => Promise<void> } {
	const realClient = opts.realClient;
	if (!realClient) {
		throw new Error("VCR record mode requires a realClient");
	}

	const entries: VcrEntry[] = [];

	const client = {
		complete: async (request: Request): Promise<Response> => {
			const response = await realClient.complete(request);
			const cleanResponse = stripRaw(response);

			entries.push({
				type: "complete",
				request: substituteForRecording(request, subs) as Request,
				response: substituteForRecording(cleanResponse, subs) as Response,
			});

			return response;
		},
		stream: async function* (request: Request): AsyncIterable<StreamEvent> {
			if (!realClient.stream) {
				throw new Error("VCR record mode: realClient does not support stream()");
			}
			const events: StreamEvent[] = [];
			for await (const event of realClient.stream(request)) {
				events.push(event);
				yield event;
			}

			entries.push({
				type: "stream",
				request: substituteForRecording(request, subs) as Request,
				events: substituteForRecording(events, subs) as StreamEvent[],
			});
		},
		providers: () => realClient.providers(),
	} as Client;

	const afterTest = async () => {
		const path = fixturePath(opts.fixtureDir, opts.testName);

		const cassette: VcrCassette = {
			recordings: entries,
			metadata: {
				recordedAt: new Date().toISOString(),
				testName: opts.testName,
				providers: realClient.providers(),
			},
		};

		saveCassette(path, cassette);
	};

	return { client, afterTest };
}

function createClientReplayer(
	opts: VcrOptions,
	subs: Record<string, string>,
): { client: Client; afterTest: () => Promise<void> } {
	const path = fixturePath(opts.fixtureDir, opts.testName);

	if (!existsSync(path)) {
		throw new Error(`VCR fixture not found: ${path}. Run with VCR_MODE=record to create it.`);
	}

	const cassette = loadCassette(path);
	let callIndex = 0;

	const client = {
		complete: async (_request: Request): Promise<Response> => {
			const { entry, nextIndex } = nextEntry(cassette, callIndex, opts.testName);
			callIndex = nextIndex;

			if (entry.type !== "complete") {
				throw new Error(
					`VCR type mismatch for '${opts.testName}' call #${callIndex}: ` +
						`expected 'complete' but recording is '${entry.type}'.`,
				);
			}

			return substituteForReplay(entry.response, subs) as Response;
		},
		stream: async function* (_request: Request): AsyncIterable<StreamEvent> {
			const { entry, nextIndex } = nextEntry(cassette, callIndex, opts.testName);
			callIndex = nextIndex;

			if (entry.type !== "stream") {
				throw new Error(
					`VCR type mismatch for '${opts.testName}' call #${callIndex}: ` +
						`expected 'stream' but recording is '${entry.type}'.`,
				);
			}

			for (const event of entry.events) {
				yield substituteForReplay(event, subs) as StreamEvent;
			}
		},
		providers: () => cassette.metadata.providers,
	} as Client;

	const afterTest = async () => {
		// No-op in replay mode
	};

	return { client, afterTest };
}

// ---------------------------------------------------------------------------
// Adapter VCR
// ---------------------------------------------------------------------------

/**
 * Create a VCR adapter for testing provider adapters directly.
 *
 * In record mode, wraps a real adapter and captures complete() responses
 * and stream() event sequences.
 * In replay mode, returns recorded data sequentially.
 */
export function createAdapterVcr(opts: AdapterVcrOptions): {
	adapter: ProviderAdapter;
	afterTest: () => Promise<void>;
} {
	const mode = resolveMode(opts);

	if (mode === "off") {
		return createAdapterPassthrough(opts);
	}
	if (mode === "record") {
		return createAdapterRecorder(opts);
	}
	return createAdapterReplayer(opts);
}

function createAdapterPassthrough(opts: AdapterVcrOptions): {
	adapter: ProviderAdapter;
	afterTest: () => Promise<void>;
} {
	if (!opts.realAdapter) {
		throw new Error("Adapter VCR off mode requires a realAdapter");
	}
	return {
		adapter: opts.realAdapter,
		afterTest: async () => {},
	};
}

function createAdapterRecorder(opts: AdapterVcrOptions): {
	adapter: ProviderAdapter;
	afterTest: () => Promise<void>;
} {
	const realAdapter = opts.realAdapter;
	if (!realAdapter) {
		throw new Error("Adapter VCR record mode requires a realAdapter");
	}

	const entries: VcrEntry[] = [];

	const adapter: ProviderAdapter = {
		name: realAdapter.name,
		complete: async (request: Request): Promise<Response> => {
			const response = await realAdapter.complete(request);
			const cleanResponse = stripRaw(response);

			entries.push({
				type: "complete",
				request,
				response: cleanResponse,
			});

			return response;
		},
		stream: async function* (request: Request): AsyncIterable<StreamEvent> {
			const events: StreamEvent[] = [];
			for await (const event of realAdapter.stream(request)) {
				events.push(event);
				yield event;
			}

			entries.push({
				type: "stream",
				request,
				events,
			});
		},
	};

	const afterTest = async () => {
		const path = fixturePath(opts.fixtureDir, opts.testName);

		const cassette: VcrCassette = {
			recordings: entries,
			metadata: {
				recordedAt: new Date().toISOString(),
				testName: opts.testName,
				providers: [realAdapter.name],
				adapterName: realAdapter.name,
			},
		};

		saveCassette(path, cassette);
	};

	return { adapter, afterTest };
}

function createAdapterReplayer(opts: AdapterVcrOptions): {
	adapter: ProviderAdapter;
	afterTest: () => Promise<void>;
} {
	const path = fixturePath(opts.fixtureDir, opts.testName);

	if (!existsSync(path)) {
		throw new Error(`VCR fixture not found: ${path}. Run with VCR_MODE=record to create it.`);
	}

	const cassette = loadCassette(path);
	let callIndex = 0;

	const adapterName = cassette.metadata.adapterName ?? cassette.metadata.providers[0] ?? "unknown";

	const adapter: ProviderAdapter = {
		name: adapterName,
		complete: async (_request: Request): Promise<Response> => {
			const { entry, nextIndex } = nextEntry(cassette, callIndex, opts.testName);
			callIndex = nextIndex;

			if (entry.type !== "complete") {
				throw new Error(
					`VCR type mismatch for '${opts.testName}' call #${callIndex}: ` +
						`expected 'complete' but recording is '${entry.type}'.`,
				);
			}

			return entry.response;
		},
		stream: async function* (_request: Request): AsyncIterable<StreamEvent> {
			const { entry, nextIndex } = nextEntry(cassette, callIndex, opts.testName);
			callIndex = nextIndex;

			if (entry.type !== "stream") {
				throw new Error(
					`VCR type mismatch for '${opts.testName}' call #${callIndex}: ` +
						`expected 'stream' but recording is '${entry.type}'.`,
				);
			}

			for (const event of entry.events) {
				yield event;
			}
		},
	};

	const afterTest = async () => {
		// No-op in replay mode
	};

	return { adapter, afterTest };
}
