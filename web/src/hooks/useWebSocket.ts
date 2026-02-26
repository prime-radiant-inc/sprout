import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ServerMessage } from "../../../src/web/protocol.ts";

type MessageListener = (msg: ServerMessage) => void;

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
	private reconnectDelay = 1000;
	private readonly maxReconnectDelay = 30000;
	private readonly sendQueue: string[] = [];
	private listeners: MessageListener[] = [];

	connected = false;
	lastMessage: ServerMessage | null = null;

	constructor(url: string) {
		this.url = url;
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
	}

	/** Send a message. Queues if not connected; sends immediately if connected. */
	send(msg: object): void {
		const payload = JSON.stringify(msg);
		if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(payload);
		} else {
			this.sendQueue.push(payload);
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

	// --- Private ---

	private openSocket(): void {
		const ws = new WebSocket(this.url);

		ws.onopen = () => {
			this.connected = true;
			this.reconnectDelay = 1000;
			this.flushQueue();
		};

		ws.onmessage = (ev: MessageEvent) => {
			const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
			try {
				const msg = JSON.parse(raw) as ServerMessage;
				this.lastMessage = msg;
				for (const listener of this.listeners) {
					listener(msg);
				}
			} catch {
				// Ignore unparseable messages
			}
		};

		ws.onclose = () => {
			this.connected = false;
			this.ws = null;
			if (!this.disposed) {
				this.scheduleReconnect();
			}
		};

		ws.onerror = () => {
			// onclose will fire after onerror, triggering reconnection
		};

		this.ws = ws;
	}

	private flushQueue(): void {
		while (this.sendQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(this.sendQueue.shift()!);
		}
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
	lastMessage: ServerMessage | null;
}

/**
 * React hook wrapping WebSocketClient.
 *
 * Connects on mount, disconnects on unmount.
 * Returns `{ connected, lastMessage, send }`.
 */
export function useWebSocket(url: string) {
	const clientRef = useRef<WebSocketClient | null>(null);

	// Lazily create the client
	if (!clientRef.current) {
		clientRef.current = new WebSocketClient(url);
	}

	const client = clientRef.current;

	// Snapshot for useSyncExternalStore
	const stateRef = useRef<WebSocketState>({ connected: false, lastMessage: null });

	const subscribe = (onStoreChange: () => void) => {
		const unsub = client.onMessage(() => {
			stateRef.current = { connected: client.connected, lastMessage: client.lastMessage };
			onStoreChange();
		});

		// Also poll connected state periodically for reconnect detection
		const interval = setInterval(() => {
			const prev = stateRef.current;
			if (prev.connected !== client.connected || prev.lastMessage !== client.lastMessage) {
				stateRef.current = { connected: client.connected, lastMessage: client.lastMessage };
				onStoreChange();
			}
		}, 200);

		return () => {
			unsub();
			clearInterval(interval);
		};
	};

	const getSnapshot = () => stateRef.current;

	const state = useSyncExternalStore(subscribe, getSnapshot);

	useEffect(() => {
		client.connect();
		return () => {
			client.dispose();
			clientRef.current = null;
		};
	}, [client]);

	return {
		connected: state.connected,
		lastMessage: state.lastMessage,
		send: (msg: object) => client.send(msg),
	};
}
