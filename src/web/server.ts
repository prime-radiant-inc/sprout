import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { SessionBus } from "../host/event-bus.ts";
import { EVENT_CAP } from "../kernel/constants.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { CommandMessage, ServerMessage } from "./protocol.ts";
import { parseCommandMessage } from "./protocol.ts";

export interface WebServerOptions {
	bus: SessionBus;
	port: number;
	staticDir: string;
	sessionId: string;
	/** Bind address (default: localhost). Use "0.0.0.0" for all interfaces. */
	hostname?: string;
	/** Optional bearer token for WebSocket command/auth checks. */
	webToken?: string;
	/** Events from a prior session to pre-populate the snapshot. */
	initialEvents?: SessionEvent[];
	/** Available model names for the model selector. */
	availableModels?: string[];
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("../host/logger.ts").Logger;
}

type SessionStatus = "idle" | "running" | "interrupted";

/**
 * Bun HTTP + WebSocket server that bridges a SessionBus to browser clients.
 *
 * HTTP: serves static files and a session API.
 * WebSocket: sends event snapshots + live streams, receives commands.
 */
export class WebServer {
	private readonly bus: SessionBus;
	private readonly port: number;
	private readonly staticDir: string;
	private sessionId: string;
	private readonly hostname: string | undefined;
	private webToken: string | undefined;

	private readonly availableModels: string[];
	private readonly logger?: import("../host/logger.ts").Logger;

	private bunServer: ReturnType<typeof Bun.serve> | null = null;
	private events: SessionEvent[] = [];
	private status: SessionStatus = "idle";
	private currentModel: string | null = null;
	private unsubscribeEvents: (() => void) | null = null;
	private unsubscribeCommands: (() => void) | null = null;

	constructor(opts: WebServerOptions) {
		this.bus = opts.bus;
		this.port = opts.port;
		this.staticDir = opts.staticDir;
		this.sessionId = opts.sessionId;
		this.hostname = opts.hostname;
		this.webToken = opts.webToken;
		if (!this.isLoopbackHost(this.hostname) && !this.webToken) {
			this.webToken = randomBytes(16).toString("hex");
		}
		this.availableModels = opts.availableModels ?? [];
		this.logger = opts.logger;
		if (opts.initialEvents) {
			this.events = [...opts.initialEvents];
		}
	}

	async start(): Promise<void> {
		// Track switch_model commands to update currentModel
		this.unsubscribeCommands = this.bus.onCommand((cmd) => {
			if (cmd.kind === "switch_model" && typeof cmd.data.model === "string") {
				this.currentModel = cmd.data.model;
			}
		});

		// Subscribe to bus events — buffer them and track session status
		this.unsubscribeEvents = this.bus.onEvent((event) => {
			if (event.kind === "session_clear") {
				const newSessionId = event.data.new_session_id;
				if (typeof newSessionId === "string" && newSessionId.trim().length > 0) {
					this.sessionId = newSessionId;
				}
				// New session semantics: reconnect snapshots should not include stale events.
				this.events = [event];
			} else {
				this.events.push(event);
				if (this.events.length > EVENT_CAP * 2) {
					this.events = this.events.slice(-EVENT_CAP);
				}
			}
			this.updateStatus(event);
			this.broadcastEvent(event);
		});

		const self = this;

		this.bunServer = Bun.serve({
			port: this.port,
			hostname: this.hostname,
			fetch(req, server) {
				const url = new URL(req.url);
				self.logger?.debug("system", "HTTP request", {
					method: req.method,
					path: url.pathname,
				});

				// WebSocket upgrade
				if (req.headers.get("upgrade") === "websocket") {
					if (!self.isAllowedOrigin(req)) {
						return new Response("Forbidden", { status: 403 });
					}
					if (!self.hasValidToken(url, req)) {
						return new Response("Unauthorized", { status: 401 });
					}
					if (!server.upgrade(req, { data: undefined })) {
						return new Response("WebSocket upgrade failed", { status: 400 });
					}
					return;
				}

				// API routes
				if (url.pathname === "/api/session") {
					return Response.json({ id: self.sessionId, status: self.status });
				}

				if (url.pathname === "/api/models") {
					return Response.json({
						models: self.availableModels,
						currentModel: self.currentModel,
					});
				}

				// Static file serving
				return self.serveStatic(url.pathname);
			},
			websocket: {
				open(ws) {
					self.handleWsOpen(ws);
				},
				message(_ws, message) {
					self.handleWsMessage(message);
				},
				close(ws) {
					self.handleWsClose(ws);
				},
			},
		});
	}

	async stop(): Promise<void> {
		if (this.unsubscribeCommands) {
			this.unsubscribeCommands();
			this.unsubscribeCommands = null;
		}
		if (this.unsubscribeEvents) {
			this.unsubscribeEvents();
			this.unsubscribeEvents = null;
		}
		if (this.bunServer) {
			this.bunServer.stop(true);
			this.bunServer = null;
		}
	}

	getWebToken(): string | undefined {
		return this.webToken;
	}

	// --- Private: HTTP ---

	private async serveStatic(pathname: string): Promise<Response> {
		// Map / to /index.html
		const filePath = pathname === "/" ? "/index.html" : pathname;
		const fullPath = resolve(this.staticDir, `.${filePath}`);
		if (!fullPath.startsWith(resolve(this.staticDir))) {
			return new Response("Forbidden", { status: 403 });
		}
		const file = Bun.file(fullPath);
		if (!(await file.exists())) {
			return new Response("Not Found", { status: 404 });
		}
		return new Response(file);
	}

	// --- Private: WebSocket ---

	/** Track connected clients for broadcasting. */
	private wsClients = new Set<ServerWebSocket<unknown>>();

	private handleWsOpen(ws: ServerWebSocket<unknown>): void {
		this.wsClients.add(ws);
		this.logger?.debug("system", "WebSocket client connected", {
			clients: this.wsClients.size,
		});
		// Send snapshot of all buffered events
		const snapshot: ServerMessage = {
			type: "snapshot",
			events: [...this.events],
			session: {
				id: this.sessionId,
				status: this.status,
				availableModels: this.availableModels,
				currentModel: this.currentModel,
			},
		};
		ws.send(JSON.stringify(snapshot));
	}

	private handleWsMessage(message: string | Buffer): void {
		const raw = typeof message === "string" ? message : message.toString();
		let cmd: CommandMessage;
		try {
			cmd = parseCommandMessage(raw);
		} catch {
			// Malformed client message — expected, ignore
			return;
		}
		try {
			this.bus.emitCommand(cmd.command);
		} catch (err) {
			// Bus/listener error — internal bug, log it
			console.error("[WebServer] command handler error:", err);
		}
	}

	private handleWsClose(ws: ServerWebSocket<unknown>): void {
		this.wsClients.delete(ws);
		this.logger?.debug("system", "WebSocket client disconnected", {
			clients: this.wsClients.size,
		});
	}

	private broadcastEvent(event: SessionEvent): void {
		const msg: ServerMessage = { type: "event", event };
		const payload = JSON.stringify(msg);
		for (const ws of this.wsClients) {
			ws.send(payload);
		}
	}

	// --- Private: Status tracking ---

	private updateStatus(event: SessionEvent): void {
		switch (event.kind) {
			case "session_start":
				this.status = "running";
				break;
			case "session_end":
				this.status = "idle";
				break;
			case "interrupted":
				this.status = "interrupted";
				break;
			case "session_clear":
				this.status = "idle";
				this.currentModel = null;
				break;
		}
	}

	private isLoopbackHost(hostname: string | undefined): boolean {
		const host = hostname ?? "localhost";
		return host === "localhost" || host === "127.0.0.1" || host === "::1";
	}

	private parseHostHeader(hostHeader: string | null): string | null {
		if (!hostHeader) return null;
		const trimmed = hostHeader.trim().toLowerCase();
		if (trimmed.startsWith("[")) {
			const end = trimmed.indexOf("]");
			return end >= 0 ? trimmed.slice(1, end) : null;
		}
		const first = trimmed.split(",")[0]?.trim();
		if (!first) return null;
		const parts = first.split(":");
		// hostname:port
		if (parts.length === 2) return parts[0] ?? null;
		// plain hostname
		if (parts.length === 1) return first;
		// likely raw ipv6 without brackets
		return first;
	}

	/** Enforce strict same-origin checks for browser-origin websocket upgrades. */
	private isAllowedOrigin(req: Request): boolean {
		const origin = req.headers.get("origin");
		if (!origin) return true;
		let originHost: string;
		try {
			originHost = new URL(origin).hostname.toLowerCase();
		} catch {
			return false;
		}
		const requestHost = this.parseHostHeader(req.headers.get("host"));
		if (!requestHost) return false;
		return originHost === requestHost;
	}

	private hasValidToken(url: URL, req: Request): boolean {
		if (!this.webToken) return true;

		const queryToken = url.searchParams.get("token");
		if (queryToken === this.webToken) return true;

		const authHeader = req.headers.get("authorization");
		if (authHeader?.startsWith("Bearer ")) {
			const bearerToken = authHeader.slice("Bearer ".length).trim();
			if (bearerToken === this.webToken) return true;
		}

		return false;
	}
}
