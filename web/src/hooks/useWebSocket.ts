import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ServerMessage } from "@kernel/protocol.ts";

type MessageListener = (msg: ServerMessage) => void;

export interface WebSocketClientOptions {
	initialReconnectDelayMs?: number;
	maxReconnectDelayMs?: number;
	maxQueuedMessages?: number;
}

/**
 * Manages a WebSocket connection to the Sprout server.
 * Handles auto-reconnect with exponential backoff and message queuing.
 *
 * Separated from React so it can be tested without a DOM.
 */
export class WebSocketClient {
	private readonly url: string;
	private ws: WebSocket | null = null;
	private disposed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly initialReconnectDelayMs: number;
	private reconnectDelay: number;
	private readonly maxReconnectDelay: number;
	private readonly maxQueuedMessages: number;
	private readonly sendQueue: Array<{ payload: string; epoch: number }> = [];
	private sessionId: string | null = null;
	private sessionEpoch = 0;
	private awaitingInitialSnapshot = false;
	private listeners: MessageListener[] = [];
	private stateListeners: Array<(connected: boolean) => void> = [];

	connected = false;
	authError: string | null = null;
	lastMessage: ServerMessage | null = null;

	constructor(url: string, options: WebSocketClientOptions = {}) {
		this.url = url;
		this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 1000;
		this.reconnectDelay = this.initialReconnectDelayMs;
		this.maxReconnectDelay = options.maxReconnectDelayMs ?? 30000;
		this.maxQueuedMessages = Math.max(1, options.maxQueuedMessages ?? 200);
	}

	/** Open the WebSocket connection. Idempotent if already connecting/connected. */
	connect(): void {
		if (this.disposed || this.ws) return;
		this.openSocket();
	}

	/** Permanently close the connection and cancel reconnection. */
	dispose(): void {
		this.disposed = true;
		this.cancelReconnect();
		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onclose = null;
			this.ws.onmessage = null;
			this.ws.onerror = null;
			this.ws.close();
			this.ws = null;
		}
		this.connected = false;
		this.notifyStateChange();
	}

	/** Send a message. Queues if not connected; sends immediately if connected. */
	send(msg: object): void {
		const payload = JSON.stringify(msg);
		if (this.connected && this.ws?.readyState === WebSocket.OPEN && !this.awaitingInitialSnapshot) {
			this.ws.send(payload);
		} else {
			if (this.sendQueue.length >= this.maxQueuedMessages) {
				this.sendQueue.shift();
			}
			this.sendQueue.push({ payload, epoch: this.sessionEpoch });
		}
	}

	/** Subscribe to parsed incoming messages. Returns unsubscribe function. */
	onMessage(listener: MessageListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/** Subscribe to connection state changes. Returns unsubscribe function. */
	onStateChange(listener: (connected: boolean) => void): () => void {
		this.stateListeners.push(listener);
		return () => {
			const idx = this.stateListeners.indexOf(listener);
			if (idx >= 0) this.stateListeners.splice(idx, 1);
		};
	}

	// --- Private ---

	private notifyStateChange(): void {
		for (const listener of this.stateListeners) {
			listener(this.connected);
		}
	}

	private openSocket(): void {
		const ws = new WebSocket(this.url);
		let opened = false;

		ws.onopen = () => {
			opened = true;
			this.connected = true;
			this.authError = null;
			this.reconnectDelay = this.initialReconnectDelayMs;
			this.awaitingInitialSnapshot = true;
			this.notifyStateChange();
		};

		ws.onmessage = (ev: MessageEvent) => {
			const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
			try {
				const msg = JSON.parse(raw) as ServerMessage;
				this.trackSessionEpoch(msg);
				this.lastMessage = msg;
				if (this.awaitingInitialSnapshot && msg.type === "snapshot") {
					this.awaitingInitialSnapshot = false;
					this.flushQueue();
				}
				for (const listener of this.listeners) {
					listener(msg);
				}
			} catch {
				// Ignore unparseable messages
			}
		};

		ws.onclose = () => {
			void this.handleSocketClose(opened);
		};

		ws.onerror = () => {
			// onclose will fire after onerror, triggering reconnection
		};

		this.ws = ws;
	}

	private async handleSocketClose(opened: boolean): Promise<void> {
		this.connected = false;
		this.ws = null;
		this.awaitingInitialSnapshot = false;
		this.notifyStateChange();

		if (this.disposed) return;

		if (!opened) {
			const authError = await this.detectAuthError();
			if (this.disposed) return;
			if (authError) {
				this.authError = authError;
				this.notifyStateChange();
				return;
			}
		}

		this.authError = null;
		this.scheduleReconnect();
	}

	private async detectAuthError(): Promise<string | null> {
		try {
			const wsUrl = new URL(this.url);
			wsUrl.protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
			wsUrl.pathname = "/api/auth";
			wsUrl.hash = "";
			const response = await fetch(wsUrl.toString(), { cache: "no-store" });
			if (response.status === 401) {
				return "Invalid or missing web nonce. Add ?token=<nonce> to the URL.";
			}
			return null;
		} catch {
			return null;
		}
	}

	private flushQueue(): void {
		while (this.sendQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
			const queued = this.sendQueue.shift()!;
			if (queued.epoch !== this.sessionEpoch) continue;
			this.ws.send(queued.payload);
		}
	}

	private trackSessionEpoch(msg: ServerMessage): void {
		if (msg.type === "snapshot") {
			const nextSessionId = msg.session.id;
			if (this.sessionId !== null && this.sessionId !== nextSessionId) {
				this.sessionEpoch += 1;
				this.sendQueue.length = 0;
			}
			this.sessionId = nextSessionId;
			return;
		}

		if (msg.event.kind !== "session_clear") return;
		const nextSessionId = msg.event.data.new_session_id;
		if (typeof nextSessionId !== "string" || nextSessionId.length === 0) return;
		if (this.sessionId !== null && this.sessionId !== nextSessionId) {
			this.sessionEpoch += 1;
			this.sendQueue.length = 0;
		}
		this.sessionId = nextSessionId;
	}

	private scheduleReconnect(): void {
		if (this.disposed) return;
		this.cancelReconnect();
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.disposed) {
				this.openSocket();
			}
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
	}

	private cancelReconnect(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}

// --- React hook ---

/** Snapshot type for useSyncExternalStore. */
interface WebSocketState {
	connected: boolean;
	authError: string | null;
}

/**
 * React hook wrapping WebSocketClient.
 *
 * Connects on mount, disconnects on unmount.
 * Returns `{ connected, send, onMessage }`.
 */
export function useWebSocket(url: string) {
	const client = useMemo(() => new WebSocketClient(url), [url]);

	// Snapshot for useSyncExternalStore
	const stateRef = useRef<WebSocketState>({ connected: false, authError: null });
	stateRef.current = { connected: client.connected, authError: client.authError };

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			const unsubState = client.onStateChange(() => {
				stateRef.current = { connected: client.connected, authError: client.authError };
				onStoreChange();
			});

			return () => {
				unsubState();
			};
		},
		[client],
	);

	const getSnapshot = () => stateRef.current;

	const state = useSyncExternalStore(subscribe, getSnapshot);

	useEffect(() => {
		client.connect();
		return () => {
			client.dispose();
		};
	}, [client]);

	const onMessage = useCallback(
		(listener: (msg: ServerMessage) => void) => client.onMessage(listener),
		[client],
	);

	const send = useCallback((msg: object) => client.send(msg), [client]);

	return {
		connected: state.connected,
		authError: state.authError,
		send,
		/** Subscribe to every incoming message (no batching/dropping). */
		onMessage,
	};
}
