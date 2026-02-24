import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";

type VcrMode = "record" | "replay" | "off";

interface VcrRecording {
	request: Request;
	response: Response;
}

interface VcrCassette {
	recordings: VcrRecording[];
	metadata: {
		recordedAt: string;
		testName: string;
		providers: string[];
	};
}

/** Minimal interface for a real client used during recording. */
interface RealClient {
	complete(request: Request): Promise<Response>;
	providers(): string[];
}

interface VcrOptions {
	fixtureDir: string;
	testName: string;
	mode?: VcrMode;
	substitutions?: Record<string, string>;
	/** Required for record mode. Not needed for replay. */
	realClient?: RealClient;
}

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

function resolveMode(opts: VcrOptions): VcrMode {
	// Explicit mode takes precedence (important for VCR's own unit tests)
	if (opts.mode) return opts.mode;
	const envMode = process.env.VCR_MODE;
	if (envMode) return envMode as VcrMode;
	// Default: replay if fixture exists, error if not
	if (existsSync(fixturePath(opts.fixtureDir, opts.testName))) return "replay";
	return "replay"; // Will error when trying to load
}

/**
 * Create a VCR client for an integration test.
 *
 * In record mode, delegates to a real LLM client and captures responses.
 * In replay mode, returns previously recorded responses sequentially.
 */
export function createVcr(opts: VcrOptions): {
	client: Client;
	afterTest: () => Promise<void>;
} {
	const mode = resolveMode(opts);
	const subs = opts.substitutions ?? {};

	if (mode === "off") {
		return createPassthrough(opts);
	}
	if (mode === "record") {
		return createRecorder(opts, subs);
	}
	return createReplayer(opts, subs);
}

function createPassthrough(opts: VcrOptions): { client: Client; afterTest: () => Promise<void> } {
	const realClient = opts.realClient;
	if (!realClient) {
		throw new Error("VCR off mode requires a realClient");
	}
	return {
		client: realClient as Client,
		afterTest: async () => {},
	};
}

function createRecorder(
	opts: VcrOptions,
	subs: Record<string, string>,
): { client: Client; afterTest: () => Promise<void> } {
	const realClient = opts.realClient;
	if (!realClient) {
		throw new Error("VCR record mode requires a realClient");
	}

	const recordings: VcrRecording[] = [];

	const client = {
		complete: async (request: Request): Promise<Response> => {
			const response = await realClient.complete(request);
			const cleanResponse = stripRaw(response);

			recordings.push({
				request: substituteForRecording(request, subs) as Request,
				response: substituteForRecording(cleanResponse, subs) as Response,
			});

			return response;
		},
		providers: () => realClient.providers(),
	} as Client;

	const afterTest = async () => {
		const path = fixturePath(opts.fixtureDir, opts.testName);
		mkdirSync(dirname(path), { recursive: true });

		const cassette: VcrCassette = {
			recordings,
			metadata: {
				recordedAt: new Date().toISOString(),
				testName: opts.testName,
				providers: realClient.providers(),
			},
		};

		writeFileSync(path, JSON.stringify(cassette, null, 2));
	};

	return { client, afterTest };
}

function createReplayer(
	opts: VcrOptions,
	subs: Record<string, string>,
): { client: Client; afterTest: () => Promise<void> } {
	const path = fixturePath(opts.fixtureDir, opts.testName);

	if (!existsSync(path)) {
		throw new Error(`VCR fixture not found: ${path}. Run with VCR_MODE=record to create it.`);
	}

	const cassette: VcrCassette = JSON.parse(readFileSync(path, "utf-8"));
	let callIndex = 0;

	const client = {
		complete: async (_request: Request): Promise<Response> => {
			if (callIndex >= cassette.recordings.length) {
				throw new Error(
					`VCR recordings exhausted for '${opts.testName}': ` +
						`only ${cassette.recordings.length} recorded calls, ` +
						`but call #${callIndex + 1} was attempted.`,
				);
			}

			const recording = cassette.recordings[callIndex++]!;
			return substituteForReplay(recording.response, subs) as Response;
		},
		providers: () => cassette.metadata.providers,
	} as Client;

	const afterTest = async () => {
		// No-op in replay mode
	};

	return { client, afterTest };
}
