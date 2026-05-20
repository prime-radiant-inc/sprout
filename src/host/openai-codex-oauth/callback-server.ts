import { redactCredentialText } from "../settings/redaction";
import { OPENAI_CODEX_OAUTH } from "./config";

const CALLBACK_PATH = "/auth/callback";
const PROBE_PATH = "/_oauth_probe";
const DEFAULT_CALLBACK_HOST = "localhost";
const DEFAULT_CALLBACK_PORTS = [1455, 1457] as const;
const DEFAULT_TEST_CALLBACK_PORTS = [0] as const;
const DEFAULT_PROBE_TIMEOUT_MS = 500;

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

interface BoundCallbackServer {
	port: number;
	stop: (force?: boolean) => void;
}

interface CallbackListenerDependencies {
	bindServer: (input: {
		hostname: "localhost" | "127.0.0.1";
		port: number;
		fetch: (request: Request) => Response | Promise<Response>;
	}) => BoundCallbackServer;
	probeProductionRedirect: (input: {
		redirectUri: string;
		probeNonce: string;
		signal: AbortSignal;
	}) => Promise<boolean>;
	scheduleListenerTimeout: (callback: () => void, timeoutMs: number) => Timer;
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

type CallbackListenerBaseOptions = {
	expectedState: string;
	timeoutMs?: number;
	probeTimeoutMs?: number;
	appReturnUrl?: string;
	onSuccessfulCallback?: (code: string) => Promise<void>;
};

type CallbackListenerOptions = CallbackListenerBaseOptions & {
	allowUnregisteredRedirectUriForTests?: never;
	hostname?: never;
	ports?: never;
};

type CallbackListenerTestOptions = CallbackListenerBaseOptions & {
	allowUnregisteredRedirectUriForTests: true;
	hostname?: "localhost" | "127.0.0.1";
	ports?: readonly number[];
};

export function listenForCallback(options: CallbackListenerOptions): Promise<CallbackListener>;
export function listenForCallback(options: CallbackListenerTestOptions): Promise<CallbackListener>;
export function listenForCallback(
	options: CallbackListenerOptions | CallbackListenerTestOptions,
): Promise<CallbackListener> {
	return createCallbackListener(options, {
		bindServer: bindBunCallbackServer,
		probeProductionRedirect,
		scheduleListenerTimeout: setTimeout,
	});
}

export function createCallbackListenerForTests(
	options: CallbackListenerOptions,
	dependencies: Partial<CallbackListenerDependencies>,
): Promise<CallbackListener> {
	return createCallbackListener(options, {
		bindServer: dependencies.bindServer ?? bindBunCallbackServer,
		probeProductionRedirect: dependencies.probeProductionRedirect ?? probeProductionRedirect,
		scheduleListenerTimeout: dependencies.scheduleListenerTimeout ?? setTimeout,
	});
}

async function createCallbackListener(
	options: CallbackListenerOptions | CallbackListenerTestOptions,
	dependencies: CallbackListenerDependencies,
): Promise<CallbackListener> {
	const hostname =
		options.allowUnregisteredRedirectUriForTests === true
			? (options.hostname ?? DEFAULT_CALLBACK_HOST)
			: DEFAULT_CALLBACK_HOST;
	const ports =
		options.allowUnregisteredRedirectUriForTests === true
			? (options.ports ?? DEFAULT_TEST_CALLBACK_PORTS)
			: DEFAULT_CALLBACK_PORTS;
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const appReturnUrl = normalizeAppReturnUrl(options.appReturnUrl);
	validateListenerRedirectTargets({
		hostname,
		ports,
		allowUnregisteredRedirectUriForTests: options.allowUnregisteredRedirectUriForTests,
		hasCustomBindingOptions: options.hostname !== undefined || options.ports !== undefined,
	});

	let finish!: (result: CallbackValidationResult) => void;
	const result = new Promise<CallbackValidationResult>((resolve) => {
		finish = resolve;
	});

	let completed = false;
	let timeout: Timer | undefined;
	let server: BoundCallbackServer | undefined;
	let stopWhenServerIsAssigned = false;
	const probeNonce = crypto.randomUUID();
	const fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === PROBE_PATH) {
			return new Response(url.searchParams.get("nonce") === probeNonce ? probeNonce : "mismatch", {
				headers: { "content-type": "text/plain; charset=utf-8" },
				status: url.searchParams.get("nonce") === probeNonce ? 200 : 404,
			});
		}

		const validation = validateCallbackRequest(request, { expectedState: options.expectedState });
		if (validation.ok) {
			try {
				await options.onSuccessfulCallback?.(validation.code);
			} catch (error) {
				const failed = callbackError(redactCredentialText(errorMessage(error)));
				complete(failed);
				return new Response("OpenAI Codex authentication failed. Return to Sprout to continue.", {
					headers: { "content-type": "text/plain; charset=utf-8" },
					status: 400,
				});
			}
			complete(validation);
			if (appReturnUrl !== undefined) {
				return Response.redirect(appReturnUrl, 303);
			}
			return new Response("OpenAI Codex authentication complete. You can close this window.", {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		complete(validation);
		return new Response("OpenAI Codex authentication failed. Return to Sprout to continue.", {
			headers: { "content-type": "text/plain; charset=utf-8" },
			status: 400,
		});
	};
	server = await bindReachableCallbackServer({
		hostname,
		ports,
		fetch,
		probeNonce,
		probeTimeoutMs,
		allowUnregisteredRedirectUriForTests: options.allowUnregisteredRedirectUriForTests,
		dependencies,
	});
	if (stopWhenServerIsAssigned) {
		server.stop();
	}

	if (!completed) {
		timeout = dependencies.scheduleListenerTimeout(() => {
			complete(callbackError("OpenAI Codex OAuth callback timed out"));
		}, timeoutMs);
	}

	function complete(value: CallbackValidationResult): void {
		if (completed) {
			return;
		}
		completed = true;
		if (timeout !== undefined) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		if (server !== undefined) {
			server.stop();
		} else {
			stopWhenServerIsAssigned = true;
		}
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

async function bindReachableCallbackServer(input: {
	hostname: "localhost" | "127.0.0.1";
	ports: readonly number[];
	fetch: (request: Request) => Response | Promise<Response>;
	probeNonce: string;
	probeTimeoutMs: number;
	allowUnregisteredRedirectUriForTests?: true;
	dependencies: CallbackListenerDependencies;
}): Promise<BoundCallbackServer> {
	let lastError: unknown;
	for (const port of input.ports) {
		let server: BoundCallbackServer;
		try {
			server = input.dependencies.bindServer({
				hostname: input.hostname,
				port,
				fetch: input.fetch,
			});
		} catch (error) {
			lastError = error;
			continue;
		}

		const redirectUri = buildRedirectUri({
			hostname: input.hostname,
			port: requireBoundPort(server),
			allowUnregisteredRedirectUriForTests: input.allowUnregisteredRedirectUriForTests,
		});
		let reachesThisServer = input.allowUnregisteredRedirectUriForTests === true;
		if (!reachesThisServer) {
			try {
				reachesThisServer = await probeProductionRedirectWithTimeout({
					redirectUri,
					probeNonce: input.probeNonce,
					timeoutMs: input.probeTimeoutMs,
					dependencies: input.dependencies,
				});
			} catch (error) {
				lastError = error;
			}
		}
		if (reachesThisServer) {
			return server;
		}
		server.stop(true);
		lastError ??= new Error("registered redirect URI did not reach this listener");
	}
	throw new Error(
		`OpenAI Codex OAuth callback listener could not bind to a loopback port: ${String(lastError)}`,
	);
}

function bindBunCallbackServer(input: {
	hostname: "localhost" | "127.0.0.1";
	port: number;
	fetch: (request: Request) => Response | Promise<Response>;
}): BoundCallbackServer {
	const server = Bun.serve({
		hostname: input.hostname,
		port: input.port,
		fetch: input.fetch,
	});
	return {
		port: requireBoundPort(server),
		stop: (force?: boolean) => server.stop(force),
	};
}

async function probeProductionRedirect(input: {
	redirectUri: string;
	probeNonce: string;
	signal: AbortSignal;
}): Promise<boolean> {
	try {
		const url = new URL(input.redirectUri);
		url.pathname = PROBE_PATH;
		url.search = "";
		url.searchParams.set("nonce", input.probeNonce);
		const response = await fetch(url, { signal: input.signal });
		return response.ok && (await response.text()) === input.probeNonce;
	} catch {
		return false;
	}
}

async function probeProductionRedirectWithTimeout(input: {
	redirectUri: string;
	probeNonce: string;
	timeoutMs: number;
	dependencies: CallbackListenerDependencies;
}): Promise<boolean> {
	const controller = new AbortController();
	let timeout: Timer | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timeout = setTimeout(() => {
			controller.abort();
			resolve(false);
		}, input.timeoutMs);
	});
	try {
		return await Promise.race([
			input.dependencies.probeProductionRedirect({
				redirectUri: input.redirectUri,
				probeNonce: input.probeNonce,
				signal: controller.signal,
			}),
			timedOut,
		]);
	} catch (error) {
		if (controller.signal.aborted) {
			return false;
		}
		throw error;
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
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
	hasCustomBindingOptions: boolean;
}): void {
	if (input.allowUnregisteredRedirectUriForTests === true) {
		if (input.hasCustomBindingOptions && input.ports.some(isRegisteredPort)) {
			throw new Error(
				"OpenAI Codex OAuth test callback listener cannot use registered redirect URIs",
			);
		}
		return;
	}
	if (
		input.hasCustomBindingOptions ||
		input.hostname !== DEFAULT_CALLBACK_HOST ||
		input.ports.some((port) => !isRegisteredPort(port))
	) {
		throw new Error("OpenAI Codex OAuth callback listener must use registered redirect URIs");
	}
}

export function getCallbackRedirectUriForPort(port: number): string {
	return buildRedirectUri({
		hostname: DEFAULT_CALLBACK_HOST,
		port,
	});
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeAppReturnUrl(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const url = parseUrl(value);
	if (url === undefined || url.protocol !== "http:" || !isLoopbackReturnHost(url.hostname)) {
		throw new Error("OpenAI Codex OAuth app return URL must be a loopback HTTP URL");
	}
	return url.toString();
}

function isLoopbackReturnHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function requireBoundPort(server: { port?: number }): number {
	if (server.port === undefined) {
		throw new Error("OpenAI Codex OAuth callback listener did not bind a loopback port");
	}
	return server.port;
}

function callbackError(error: string): CallbackValidationResult {
	return { ok: false, error };
}
