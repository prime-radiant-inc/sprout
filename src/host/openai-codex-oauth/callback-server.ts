import { OPENAI_CODEX_OAUTH } from "./config";

const CALLBACK_PATH = "/auth/callback";
const DEFAULT_CALLBACK_HOST = "localhost";
const DEFAULT_CALLBACK_PORTS = [1455, 1457] as const;

export type CallbackValidationResult =
	| {
			ok: true;
			code: string;
			error?: never;
	  }
	| {
			ok: false;
			error: string;
			code?: never;
	  };

export interface CallbackListener {
	redirectUri: string;
	result: Promise<CallbackValidationResult>;
	stop: () => void;
}

export function validateCallbackRequest(
	request: Request,
	options: { expectedState: string },
): CallbackValidationResult {
	if (request.method !== "GET") {
		return callbackError("OpenAI Codex OAuth callback must use GET");
	}

	const url = new URL(request.url);
	if (url.pathname !== CALLBACK_PATH) {
		return callbackError("OpenAI Codex OAuth callback path is not supported");
	}

	if (url.searchParams.has("error")) {
		return callbackError("OpenAI Codex OAuth callback returned an error");
	}

	const code = parseRequiredSearchParam(url, "code");
	if (code === undefined) {
		return callbackError("OpenAI Codex OAuth callback is missing code");
	}

	const state = parseRequiredSearchParam(url, "state");
	if (state === undefined) {
		return callbackError("OpenAI Codex OAuth callback is missing state");
	}

	if (state !== options.expectedState) {
		return callbackError("OpenAI Codex OAuth callback state did not match");
	}

	return { ok: true, code };
}

export function parseManualPasteback(input: {
	input: string;
	expectedState: string;
	returnedState?: string;
}): CallbackValidationResult {
	const value = input.input.trim();
	if (value === "") {
		return callbackError("OpenAI Codex OAuth pasteback is empty");
	}

	const callbackUrl = parseUrl(value);
	if (callbackUrl !== undefined) {
		if (!isSupportedRedirectTarget(callbackUrl)) {
			return callbackError("OpenAI Codex OAuth callback URL is not supported");
		}
		return validateCallbackRequest(new Request(callbackUrl.toString()), {
			expectedState: input.expectedState,
		});
	}

	if (input.returnedState === undefined || input.returnedState.trim() === "") {
		return callbackError("OpenAI Codex OAuth pasteback state is required for raw codes");
	}
	if (input.returnedState !== input.expectedState) {
		return callbackError("OpenAI Codex OAuth pasteback state did not match");
	}

	return { ok: true, code: value };
}

export function listenForCallback(options: {
	expectedState: string;
	hostname?: "localhost" | "127.0.0.1";
	ports?: readonly number[];
	timeoutMs?: number;
	allowUnregisteredRedirectUriForTests?: true;
}): CallbackListener {
	const hostname = options.hostname ?? DEFAULT_CALLBACK_HOST;
	const ports = options.ports ?? DEFAULT_CALLBACK_PORTS;
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
	validateListenerRedirectTargets({
		hostname,
		ports,
		allowUnregisteredRedirectUriForTests: options.allowUnregisteredRedirectUriForTests,
	});

	let finish!: (result: CallbackValidationResult) => void;
	const result = new Promise<CallbackValidationResult>((resolve) => {
		finish = resolve;
	});

	let completed = false;
	let timeout: Timer | undefined;
	const server = bindCallbackServer({
		hostname,
		ports,
		fetch: (request) => {
			const validation = validateCallbackRequest(request, { expectedState: options.expectedState });
			if (validation.ok) {
				complete(validation);
				return new Response("OpenAI Codex authentication complete. You can close this window.", {
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}

			complete(validation);
			return new Response("OpenAI Codex authentication failed. Return to Sprout to continue.", {
				headers: { "content-type": "text/plain; charset=utf-8" },
				status: 400,
			});
		},
	});

	timeout = setTimeout(() => {
		complete(callbackError("OpenAI Codex OAuth callback timed out"));
	}, timeoutMs);

	function complete(value: CallbackValidationResult): void {
		if (completed) {
			return;
		}
		completed = true;
		if (timeout !== undefined) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		server.stop();
		finish(value);
	}

	return {
		redirectUri: buildRedirectUri({
			hostname,
			port: requireBoundPort(server),
			allowUnregisteredRedirectUriForTests: options.allowUnregisteredRedirectUriForTests,
		}),
		result,
		stop: () => complete(callbackError("OpenAI Codex OAuth callback listener was stopped")),
	};
}

function bindCallbackServer(input: {
	hostname: "localhost" | "127.0.0.1";
	ports: readonly number[];
	fetch: (request: Request) => Response | Promise<Response>;
}): Bun.Server<undefined> {
	let lastError: unknown;
	for (const port of input.ports) {
		try {
			return Bun.serve({
				hostname: input.hostname,
				port,
				fetch: input.fetch,
			});
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`OpenAI Codex OAuth callback listener could not bind to a loopback port: ${String(lastError)}`,
	);
}

function parseRequiredSearchParam(url: URL, key: string): string | undefined {
	const value = url.searchParams.get(key);
	if (value === null || value.trim() === "") {
		return undefined;
	}
	return value;
}

function parseUrl(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

function isSupportedRedirectTarget(url: URL): boolean {
	return (
		url.origin + url.pathname === OPENAI_CODEX_OAUTH.primaryRedirectUri ||
		url.origin + url.pathname === OPENAI_CODEX_OAUTH.fallbackRedirectUri
	);
}

function validateListenerRedirectTargets(input: {
	hostname: "localhost" | "127.0.0.1";
	ports: readonly number[];
	allowUnregisteredRedirectUriForTests?: true;
}): void {
	if (input.allowUnregisteredRedirectUriForTests === true) {
		return;
	}
	if (
		input.hostname !== DEFAULT_CALLBACK_HOST ||
		input.ports.some((port) => !isRegisteredPort(port))
	) {
		throw new Error("OpenAI Codex OAuth callback listener must use registered redirect URIs");
	}
}

function buildRedirectUri(input: {
	hostname: "localhost" | "127.0.0.1";
	port: number;
	allowUnregisteredRedirectUriForTests?: true;
}): string {
	const { hostname, port } = input;
	if (hostname === "localhost" && port === 1455) {
		return OPENAI_CODEX_OAUTH.primaryRedirectUri;
	}
	if (hostname === "localhost" && port === 1457) {
		return OPENAI_CODEX_OAUTH.fallbackRedirectUri;
	}
	if (input.allowUnregisteredRedirectUriForTests !== true) {
		throw new Error("OpenAI Codex OAuth callback listener must use registered redirect URIs");
	}
	return `http://${hostname}:${port}${CALLBACK_PATH}`;
}

function isRegisteredPort(port: number): boolean {
	return port === 1455 || port === 1457;
}

function requireBoundPort(server: Bun.Server<undefined>): number {
	if (server.port === undefined) {
		throw new Error("OpenAI Codex OAuth callback listener did not bind a loopback port");
	}
	return server.port;
}

function callbackError(error: string): CallbackValidationResult {
	return { ok: false, error };
}
