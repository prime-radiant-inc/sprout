import type { ServerWebSocket } from "bun";
import type { HandleIdentity, HandleRegistry } from "./handle-registry.ts";

/**
 * Authenticated host channel (sap spec §1 Transport, §3 Identity). The open
 * pub/sub bus carries no caller identity, so nothing authority-bearing may
 * ride it. This module is the separate authenticated endpoint: each agent
 * process opens one WebSocket, proves its per-handle token at the handshake,
 * and the host maps connection → verified identity for every message after.
 * Identity is per-connection, never per-message — handlers get the identity
 * the registry verified at upgrade time, nothing from message bodies.
 *
 * This is only the pipe: request/response envelopes and server→client push.
 * The operations that ride it (store ops, grants, cell spawns, pings, waits)
 * are later phases that register handlers via `onRequest`.
 *
 * Handshake mechanism: credentials travel in custom headers. Bun's WebSocket
 * client accepts `new WebSocket(url, { headers })` (a Bun extension, typed in
 * bun-types) and the server sees those headers on the upgrade request —
 * verified empirically on Bun 1.3.10. The token never goes in the URL, where
 * it would leak into logs; the `Sec-WebSocket-Protocol` fallback is unneeded.
 */

/** Header carrying the handle ID during the WebSocket handshake. */
export const HANDLE_HEADER = "x-sprout-handle";

/** Header carrying the per-handle secret token during the handshake. */
export const TOKEN_HEADER = "x-sprout-token";

/** Wire envelope client → server. */
type RequestEnvelope = { id: string; type: string; payload: unknown };

/** Wire envelope server → client answering a request (correlated by id). */
type ResponseEnvelope =
	| { id: string; ok: true; result: unknown }
	// `infrastructure` carries a thrown error's `.infrastructure === true` tag
	// (e.g. StoreUnavailableError) across the channel — callers key retry/fail
	// decisions on it, so the wire must not strip it.
	| { id: string; ok: false; error: string; infrastructure?: boolean };

/** Wire envelope server → client push (no id — that distinguishes it). */
type PushEnvelope = { type: string; payload: unknown };

/**
 * Verified identity handed to request handlers: the connection's handle ID
 * plus the registry identity bound at the handshake.
 */
export type AuthRequestContext = { handleId: string } & HandleIdentity;

/**
 * Handler for one request type. The return value becomes the response result;
 * a thrown error becomes an error response.
 */
export type AuthRequestHandler = (
	ctx: AuthRequestContext,
	payload: unknown,
) => unknown | Promise<unknown>;

/** Identity bound to a connection at upgrade time. */
type WSData = { handleId: string; identity: HandleIdentity };

export interface AuthChannelServerOptions {
	/** Port to listen on. Use 0 for random port assignment. */
	port: number;
	/** Optional hostname. Defaults to "localhost". */
	hostname?: string;
	/** Registry that verifies handshake credentials and tracks liveness. */
	registry: HandleRegistry;
}

/**
 * Host-side endpoint for the authenticated channel. Authenticates every
 * connection against the handle registry BEFORE upgrading — a request that
 * fails auth is rejected with 401 and never becomes a WebSocket. Dispatches
 * request envelopes to registered handlers with the connection's verified
 * identity, and clears registry liveness when a connection closes so the
 * handle can reconnect or be respawned.
 */
export class AuthChannelServer {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly options: AuthChannelServerOptions;
	private readonly handlers = new Map<string, AuthRequestHandler>();

	/** handleId -> live authenticated connection (one per handle). */
	private readonly connections = new Map<string, ServerWebSocket<WSData>>();

	constructor(options: AuthChannelServerOptions) {
		this.options = options;
	}

	/** The WebSocket URL clients should use to connect. Only valid after start(). */
	get url(): string {
		if (!this.server) throw new Error("AuthChannelServer not started");
		return `ws://${this.options.hostname ?? "localhost"}:${this.server.port}`;
	}

	/** The port the server is listening on. Only valid after start(). */
	get port(): number {
		if (!this.server) throw new Error("AuthChannelServer not started");
		return this.server.port!;
	}

	/**
	 * Register the handler for a request type. Later phases (store ops, grants,
	 * spawns) call this; one handler per type, last registration wins.
	 */
	onRequest(type: string, handler: AuthRequestHandler): void {
		this.handlers.set(type, handler);
	}

	/**
	 * Push a message to a connected handle (ping relay, spawn routing).
	 * Returns false when that handle has no live connection.
	 */
	push(handleId: string, type: string, payload: unknown): boolean {
		const ws = this.connections.get(handleId);
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		const envelope: PushEnvelope = { type, payload };
		ws.send(JSON.stringify(envelope));
		return true;
	}

	async start(): Promise<void> {
		if (this.server) throw new Error("AuthChannelServer already started");

		const self = this;

		this.server = Bun.serve<WSData>({
			port: this.options.port,
			hostname: this.options.hostname ?? "localhost",
			fetch(req, server) {
				// Authenticate BEFORE upgrading — the load-bearing security
				// property. No valid token, no WebSocket.
				const handleId = req.headers.get(HANDLE_HEADER);
				const token = req.headers.get(TOKEN_HEADER);
				if (!handleId || !token) {
					return new Response("Authentication required", { status: 401 });
				}
				const auth = self.options.registry.authenticate(handleId, token);
				if (!auth.ok) {
					// One generic body for every failure — don't tell a prober
					// whether the handle exists or the token was wrong.
					return new Response("Authentication failed", { status: 401 });
				}
				const upgraded = server.upgrade(req, {
					data: { handleId, identity: auth.identity },
				});
				if (upgraded) return undefined;
				// authenticate() marked the handle live; a failed upgrade (e.g.
				// plain HTTP with valid credentials) must roll that back or the
				// handle could never connect again.
				self.options.registry.disconnect(handleId);
				return new Response("Expected WebSocket upgrade", { status: 426 });
			},
			websocket: {
				// Explicit frame cap: Bun's default 16 MB maxPayloadLength is
				// unstated in docs and an over-limit frame drops the connection
				// silently. 8 MB is deliberate headroom over the client-side
				// 6 MB bind guard; large bodies use CAS handoff in Phase 3.
				maxPayloadLength: 8 * 1024 * 1024,
				open(ws) {
					self.connections.set(ws.data.handleId, ws);
				},
				message(ws, raw) {
					self.handleMessage(ws, raw);
				},
				close(ws) {
					self.handleClose(ws);
				},
			},
		});
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		// Clear liveness for every connected handle deterministically rather
		// than relying on close events racing server shutdown.
		for (const handleId of this.connections.keys()) {
			this.options.registry.disconnect(handleId);
		}
		this.connections.clear();
		this.server.stop(true);
		this.server = null;
	}

	private async handleMessage(ws: ServerWebSocket<WSData>, raw: string | Buffer): Promise<void> {
		let msg: Partial<RequestEnvelope>;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			return; // Ignore malformed JSON
		}

		// Without a string id there is nothing to correlate a reply to.
		if (!msg || typeof msg !== "object" || typeof msg.id !== "string") return;
		if (typeof msg.type !== "string") return;

		const handler = this.handlers.get(msg.type);
		if (!handler) {
			this.respond(ws, { id: msg.id, ok: false, error: `unknown request type "${msg.type}"` });
			return;
		}

		try {
			// Identity comes from the connection's handshake-verified data,
			// never from the message body.
			const result = await handler(
				{ handleId: ws.data.handleId, ...ws.data.identity },
				msg.payload,
			);
			this.respond(ws, { id: msg.id, ok: true, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const infrastructure =
				(error as { infrastructure?: unknown } | null)?.infrastructure === true;
			this.respond(ws, {
				id: msg.id,
				ok: false,
				error: message,
				...(infrastructure ? { infrastructure: true } : {}),
			});
		}
	}

	private respond(ws: ServerWebSocket<WSData>, envelope: ResponseEnvelope): void {
		// Guard like push(): a socket that closed mid-request must not throw out
		// of the un-awaited message handler into an unhandled rejection.
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify(envelope));
	}

	private handleClose(ws: ServerWebSocket<WSData>): void {
		// Only the connection currently bound to the handle clears state —
		// stop() may already have cleaned up.
		const current = this.connections.get(ws.data.handleId);
		if (current !== ws) return;
		this.connections.delete(ws.data.handleId);
		this.options.registry.disconnect(ws.data.handleId);
	}
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

export interface AuthChannelClientOptions {
	/** ws:// URL of the AuthChannelServer. */
	url: string;
	/** Handle ID to authenticate as. */
	handleId: string;
	/** Per-handle secret token minted by this handle's spawner. */
	token: string;
}

/**
 * Agent-process side of the authenticated channel. Presents the handle's
 * credentials at the handshake (connect() rejects if the server refuses
 * them), correlates concurrent requests to responses by envelope id, and
 * delivers server pushes to onPush handlers.
 */
export class AuthChannelClient {
	private readonly options: AuthChannelClientOptions;
	private ws: WebSocket | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly pushHandlers = new Map<string, Set<(payload: unknown) => void>>();
	private nextRequestId = 0;

	constructor(options: AuthChannelClientOptions) {
		this.options = options;
	}

	/** Whether the client currently holds an open authenticated connection. */
	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Open and authenticate the connection. Rejects when the server refuses
	 * the handshake — the WebSocket API cannot see the HTTP status, so a
	 * refusal reads as a failed upgrade; on this endpoint that means bad
	 * credentials (or no server).
	 */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.options.url, {
				headers: {
					[HANDLE_HEADER]: this.options.handleId,
					[TOKEN_HEADER]: this.options.token,
				},
			});
			ws.onopen = () => {
				this.ws = ws;
				ws.onmessage = (ev) => this.handleMessage(ev);
				ws.onclose = () => {
					if (this.ws === ws) this.ws = null;
					this.rejectAllPending("AuthChannelClient disconnected before response");
				};
				resolve();
			};
			ws.onerror = (event) => {
				ws.close();
				const detail = (event as { message?: string }).message ?? "socket error";
				reject(
					new Error(
						`AuthChannel handshake rejected for handle "${this.options.handleId}" — ` +
							`authentication refused or server unreachable (${detail})`,
					),
				);
			};
		});
	}

	/** Close the connection, rejecting any requests still in flight. */
	disconnect(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.ws) {
				resolve();
				return;
			}
			const ws = this.ws;
			this.ws = null;
			this.pushHandlers.clear();
			this.rejectAllPending("AuthChannelClient disconnected before response");

			if (ws.readyState === WebSocket.CLOSED) {
				resolve();
				return;
			}

			ws.onclose = () => resolve();
			ws.close();
		});
	}

	/**
	 * Send a request and await its correlated response. Resolves with the
	 * handler's result; rejects with the server's error string on failure.
	 * Any number of requests may be in flight concurrently.
	 */
	async request(type: string, payload?: unknown): Promise<unknown> {
		if (!this.connected) {
			throw new Error("AuthChannelClient is not connected");
		}
		const id = `r${this.nextRequestId++}`;
		const envelope: RequestEnvelope = { id, type, payload };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.ws!.send(JSON.stringify(envelope));
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	/** Register a handler for a server→client push type. */
	onPush(type: string, handler: (payload: unknown) => void): void {
		let handlers = this.pushHandlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.pushHandlers.set(type, handlers);
		}
		handlers.add(handler);
	}

	private handleMessage(ev: MessageEvent): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(ev.data as string);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object") return;

		// Responses carry a string id; pushes carry a type and no id.
		if (typeof msg.id === "string") {
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if (msg.ok === true) {
				pending.resolve(msg.result);
			} else {
				const error = new Error(typeof msg.error === "string" ? msg.error : "request failed");
				// Rebuild the infrastructure tag so callers' retry/fail logic sees
				// the same `.infrastructure === true` an in-process throw carries.
				if (msg.infrastructure === true) {
					(error as Error & { infrastructure?: boolean }).infrastructure = true;
				}
				pending.reject(error);
			}
			return;
		}

		if (typeof msg.type === "string") {
			const handlers = this.pushHandlers.get(msg.type);
			if (!handlers) return;
			for (const handler of handlers) {
				try {
					handler(msg.payload);
				} catch {
					// One push handler failing must not stop the others.
				}
			}
		}
	}

	private rejectAllPending(message: string): void {
		const error = new Error(message);
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}
