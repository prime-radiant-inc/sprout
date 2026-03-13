import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { SessionBus } from "../host/event-bus.ts";
import {
	createDefaultSessionSelectionSnapshot,
	type SessionSelectionSnapshot,
	selectionRequestToCurrentModel,
	selectionSnapshotToCurrentModel,
} from "../host/session-selection.ts";
import { loadAllEventLogs } from "../host/session-state.ts";
import type {
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "../host/settings/control-plane.ts";
import { EVENT_CAP } from "../kernel/constants.ts";
import type { PricingTable } from "../kernel/pricing.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import type { CommandMessage, ServerMessage } from "./protocol.ts";
import { parseCommandMessage } from "./protocol.ts";

interface SettingsControlPlaneLike {
	execute(command: SettingsCommand): Promise<SettingsCommandResult>;
}

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
	/** Directory for project data (task files, logs). */
	projectDataDir?: string;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("../host/logger.ts").Logger;
	/** Server-side pricing table for model cost calculations. */
	pricingTable?: PricingTable | null;
	/** Settings control plane used for the web settings UI. */
	settingsControlPlane?: SettingsControlPlaneLike;
	/** Returns the controller's current session model selection. */
	getSessionSelection?: () => SessionSelectionSnapshot;
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
	private readonly projectDataDir: string | undefined;
	private pricingTable: PricingTable | null;
	private readonly settingsControlPlane: SettingsControlPlaneLike | undefined;
	private readonly getSessionSelection: (() => SessionSelectionSnapshot) | undefined;
	private settingsSnapshot: SettingsSnapshot | null = null;

	private bunServer: ReturnType<typeof Bun.serve> | null = null;
	private events: SessionEvent[] = [];
	private status: SessionStatus = "idle";
	private currentModel: string | null = null;
	private unsubscribeEvents: (() => void) | null = null;
	private unsubscribeCommands: (() => void) | null = null;
	private historyCache: SessionEvent[] | null = null;
	private historyCacheSessionId: string | null = null;

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
		this.projectDataDir = opts.projectDataDir;
		this.pricingTable = opts.pricingTable ?? null;
		this.settingsControlPlane = opts.settingsControlPlane;
		this.getSessionSelection = opts.getSessionSelection;
		if (this.getSessionSelection) {
			this.currentModel = selectionSnapshotToCurrentModel(this.getCurrentSelection()) ?? null;
		}
		if (opts.initialEvents) {
			this.historyCache = [...opts.initialEvents];
			this.historyCacheSessionId = this.sessionId;
			this.events =
				opts.initialEvents.length > EVENT_CAP
					? opts.initialEvents.slice(-EVENT_CAP)
					: [...opts.initialEvents];
		}
	}

	async start(): Promise<void> {
		await this.refreshSettingsSnapshot();

		// Track switch_model commands to update currentModel
		this.unsubscribeCommands = this.bus.onCommand((cmd) => {
			if (this.getSessionSelection) {
				this.currentModel = selectionSnapshotToCurrentModel(this.getCurrentSelection()) ?? null;
			} else if (cmd.kind === "switch_model") {
				this.currentModel =
					selectionRequestToCurrentModel(cmd.data.selection as SessionSelectionRequest) ?? null;
			}
		});

		// Subscribe to bus events — buffer them and track session status
		this.unsubscribeEvents = this.bus.onEvent((event) => {
			if (event.kind === "session_clear") {
				const newSessionId = event.data.new_session_id;
				if (typeof newSessionId === "string" && newSessionId.trim().length > 0) {
					this.sessionId = newSessionId;
				}
				this.historyCache = null;
				this.historyCacheSessionId = null;
				// New session semantics: reconnect snapshots should not include stale events.
				this.events = [event];
			} else {
				this.events.push(event);
				if (this.events.length > EVENT_CAP * 2) {
					this.events = this.events.slice(-EVENT_CAP);
				}
				if (this.historyCache && this.historyCacheSessionId === this.sessionId) {
					this.historyCache.push(event);
				}
			}
			// Track task-cli calls to emit task_update events.
			// task-cli is registered as a direct primitive (name === "task-cli"),
			// but may also be invoked via the exec primitive with "task-cli" in the command string.
			if (event.kind === "primitive_start") {
				if (event.data.name === "task-cli") {
					this.pendingTaskCliAgents.add(event.agent_id);
				} else if (event.data.name === "exec") {
					const cmd = event.data.args && (event.data.args as Record<string, unknown>).command;
					if (typeof cmd === "string" && cmd.includes("task-cli")) {
						this.pendingTaskCliAgents.add(event.agent_id);
					}
				}
			}
			if (
				event.kind === "primitive_end" &&
				(event.data.name === "task-cli" || event.data.name === "exec") &&
				event.data.success === true
			) {
				if (this.pendingTaskCliAgents.delete(event.agent_id)) {
					this.emitTaskUpdate(event.agent_id, event.depth);
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
				if (url.pathname === "/api/auth") {
					if (!self.isAllowedOrigin(req)) {
						return new Response("Forbidden", { status: 403 });
					}
					if (!self.hasValidToken(url, req)) {
						return Response.json({ ok: false, error: "invalid_nonce" }, { status: 401 });
					}
					return Response.json({ ok: true });
				}

				if (url.pathname === "/api/session") {
					return Response.json({ id: self.sessionId, status: self.status });
				}

				if (url.pathname === "/api/events") {
					if (!self.isAllowedOrigin(req)) {
						return new Response("Forbidden", { status: 403 });
					}
					if (!self.hasValidToken(url, req)) {
						return new Response("Unauthorized", { status: 401 });
					}
					return self.serveEventHistory(url);
				}

				if (url.pathname === "/api/models") {
					return Response.json({
						models: self.availableModels,
						currentModel: self.getCurrentModel(),
					});
				}

				// Static file serving
				return self.serveStatic(url.pathname);
			},
			websocket: {
				open(ws) {
					self.handleWsOpen(ws);
				},
				message(ws, message) {
					void self.handleWsMessage(ws, message);
				},
				close(ws) {
					self.handleWsClose(ws);
				},
			},
		});
	}

	getPort(): number {
		return this.bunServer?.port ?? this.port;
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

	private async serveEventHistory(url: URL): Promise<Response> {
		const before = Math.max(0, Number(url.searchParams.get("before") ?? 0) || 0);
		const limit = Math.min(
			Math.max(1, Number(url.searchParams.get("limit") ?? 0) || 0 || 1000),
			EVENT_CAP,
		);
		const history = await this.getHistoryEvents();
		const endExclusive = Math.max(0, history.length - before);
		const start = Math.max(0, endExclusive - limit);
		const events = history.slice(start, endExclusive);
		return Response.json({
			events,
			hasMore: start > 0,
			nextBefore: before + events.length,
			total: history.length,
		});
	}

	private async getHistoryEvents(): Promise<SessionEvent[]> {
		if (!this.projectDataDir) return [...this.events];
		if (this.historyCache && this.historyCacheSessionId === this.sessionId) {
			return this.historyCache;
		}

		const rootLogPath = join(this.projectDataDir, "logs", `${this.sessionId}.jsonl`);
		const sessionLogDir = join(this.projectDataDir, "logs", this.sessionId);
		const events = await loadAllEventLogs(rootLogPath, sessionLogDir);
		this.historyCache = events;
		this.historyCacheSessionId = this.sessionId;
		return events;
	}

	private async emitTaskUpdate(agentId: string, depth: number): Promise<void> {
		if (!this.projectDataDir) return;
		try {
			const path = `${this.projectDataDir}/logs/${this.sessionId}/tasks.json`;
			const file = Bun.file(path);
			if (!(await file.exists())) {
				this.bus.emitEvent("task_update", agentId, depth, { tasks: [] });
				return;
			}
			const data = await file.json();
			const tasks = Array.isArray(data.tasks) ? data.tasks : [];
			this.bus.emitEvent("task_update", agentId, depth, { tasks });
		} catch {
			// File read/parse error — silently skip
		}
	}

	// --- Private: WebSocket ---

	/** Track connected clients for broadcasting. */
	private wsClients = new Set<ServerWebSocket<unknown>>();
	private pendingTaskCliAgents = new Set<string>();

	private handleWsOpen(ws: ServerWebSocket<unknown>): void {
		const snapshot = this.createSnapshotMessage();
		this.sendToClient(ws, snapshot);
		this.wsClients.add(ws);
		this.logger?.debug("system", "WebSocket client connected", {
			clients: this.wsClients.size,
		});
		void this.seedTasksForClient(ws);
	}

	private async seedTasksForClient(ws: ServerWebSocket<unknown>): Promise<void> {
		// Check if any task_update event already exists in the buffered events
		const hasTaskUpdate = this.events.some((e) => e.kind === "task_update");
		if (hasTaskUpdate) return;
		if (!this.projectDataDir) return;
		try {
			const path = `${this.projectDataDir}/logs/${this.sessionId}/tasks.json`;
			const file = Bun.file(path);
			if (!(await file.exists())) return;
			const data = await file.json();
			const tasks = Array.isArray(data.tasks) ? data.tasks : [];
			if (tasks.length === 0) return;
			const syntheticEvent: SessionEvent = {
				kind: "task_update",
				timestamp: Date.now(),
				agent_id: "system",
				depth: 0,
				data: { tasks },
			};
			const msg: ServerMessage = { type: "event", event: syntheticEvent };
			ws.send(JSON.stringify(msg));
		} catch {
			// File read/parse error — silently skip
		}
	}

	private async handleWsMessage(
		ws: ServerWebSocket<unknown>,
		message: string | Buffer,
	): Promise<void> {
		const raw = typeof message === "string" ? message : message.toString();
		let cmd: CommandMessage;
		try {
			cmd = parseCommandMessage(raw);
		} catch {
			// Malformed client message — expected, ignore
			return;
		}

		if (this.isSettingsCommand(cmd.command)) {
			const unavailableResult: SettingsCommandResult = {
				ok: false,
				code: "settings_unavailable",
				message: "Settings control plane is unavailable",
			};
			const result = this.settingsControlPlane
				? await this.executeSettingsCommand(cmd.command)
				: unavailableResult;
			this.sendToClient(ws, {
				type: "settings_result",
				result,
			});
			if (result.ok) {
				this.settingsSnapshot = result.snapshot;
				this.broadcast({
					type: "settings_updated",
					snapshot: result.snapshot,
				});
			}
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
		this.broadcast({ type: "event", event });
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

	private createSnapshotMessage(): ServerMessage {
		return {
			type: "snapshot",
			events: [...this.events],
			session: {
				id: this.sessionId,
				status: this.status,
				availableModels: this.availableModels,
				currentModel: this.getCurrentModel(),
				currentSelection: this.getCurrentSelection(),
				pricingTable: this.pricingTable,
			},
			settings: this.settingsSnapshot,
		};
	}

	private getCurrentSelection(): SessionSelectionSnapshot {
		return this.getSessionSelection?.() ?? createDefaultSessionSelectionSnapshot();
	}

	private getCurrentModel(): string | null {
		if (this.getSessionSelection) {
			return selectionSnapshotToCurrentModel(this.getCurrentSelection()) ?? null;
		}
		return this.currentModel;
	}

	private async refreshSettingsSnapshot(): Promise<void> {
		if (!this.settingsControlPlane) {
			this.settingsSnapshot = null;
			return;
		}
		try {
			const result = await this.settingsControlPlane.execute({ kind: "get_settings", data: {} });
			this.settingsSnapshot = result.ok ? result.snapshot : null;
		} catch (error) {
			this.settingsSnapshot = null;
			this.logger?.debug("system", "Failed to load settings snapshot", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async executeSettingsCommand(command: SettingsCommand): Promise<SettingsCommandResult> {
		if (!this.settingsControlPlane) {
			return {
				ok: false,
				code: "settings_unavailable",
				message: "Settings control plane is unavailable",
			};
		}
		try {
			return await this.settingsControlPlane.execute(command);
		} catch (error) {
			return {
				ok: false,
				code: "settings_error",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private isSettingsCommand(command: CommandMessage["command"]): command is SettingsCommand {
		const { kind } = command;
		return (
			kind === "get_settings" ||
			kind === "create_provider" ||
			kind === "update_provider" ||
			kind === "delete_provider" ||
			kind === "set_provider_secret" ||
			kind === "delete_provider_secret" ||
			kind === "set_provider_enabled" ||
			kind === "test_provider_connection" ||
			kind === "refresh_provider_models" ||
			kind === "set_global_tier_default" ||
			kind === "set_default_provider"
		);
	}

	private sendToClient(ws: ServerWebSocket<unknown>, message: ServerMessage): void {
		ws.send(JSON.stringify(message));
	}

	private broadcast(message: ServerMessage): void {
		const payload = JSON.stringify(message);
		for (const ws of this.wsClients) {
			ws.send(payload);
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
