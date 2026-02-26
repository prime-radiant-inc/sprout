/** Wire-protocol message sent to the bus server */
type ClientAction =
	| { action: "subscribe"; topic: string }
	| { action: "unsubscribe"; topic: string }
	| { action: "publish"; topic: string; payload: string };

/**
 * WebSocket client for the bus pub/sub server.
 * Provides a clean API over the raw JSON wire protocol.
 */
export class BusClient {
	private readonly url: string;
	private ws: WebSocket | null = null;
	private callbacks = new Map<string, Set<(payload: string) => void>>();
	private pendingAcks = new Map<string, (() => void)[]>();

	constructor(url: string) {
		this.url = url;
	}

	/** Whether the client is currently connected to the bus server. */
	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/** Open a WebSocket connection to the bus server. Resolves when connected. */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url);
			ws.onopen = () => {
				this.ws = ws;
				ws.onmessage = (ev) => this.handleMessage(ev);
				resolve();
			};
			ws.onerror = (e) => {
				ws.close();
				reject(e);
			};
		});
	}

	/** Close the WebSocket connection and clear all local callbacks. */
	disconnect(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.ws) {
				resolve();
				return;
			}
			const ws = this.ws;
			this.ws = null;
			this.callbacks.clear();
			this.pendingAcks.clear();

			if (ws.readyState === WebSocket.CLOSED) {
				resolve();
				return;
			}

			ws.onclose = () => resolve();
			ws.close();
		});
	}

	/**
	 * Subscribe to a topic. Sends a subscribe action to the server and
	 * registers a local callback. Multiple callbacks per topic are allowed.
	 * Resolves only after the server acknowledges the subscription.
	 */
	async subscribe(topic: string, callback: (payload: string) => void): Promise<void> {
		this.requireConnection();

		let cbs = this.callbacks.get(topic);
		if (!cbs) {
			cbs = new Set();
			this.callbacks.set(topic, cbs);
		}

		// Only send the subscribe wire message if this is the first callback for the topic
		const isFirst = cbs.size === 0;
		cbs.add(callback);

		if (isFirst) {
			this.send({ action: "subscribe", topic });
			await this.awaitAck(topic);
		}
	}

	/**
	 * Unsubscribe from a topic. Sends an unsubscribe action to the server
	 * and removes all local callbacks for the topic.
	 */
	async unsubscribe(topic: string): Promise<void> {
		this.requireConnection();
		this.callbacks.delete(topic);
		this.send({ action: "unsubscribe", topic });
	}

	/** Publish a message to a topic. */
	async publish(topic: string, payload: string): Promise<void> {
		this.requireConnection();
		this.send({ action: "publish", topic, payload });
	}

	/**
	 * Subscribe to a topic, resolve with the first message received,
	 * then unsubscribe. Rejects if no message arrives within timeoutMs.
	 * Awaits the server subscribe ack before listening for messages.
	 */
	async waitForMessage(topic: string, timeoutMs = 30_000): Promise<string> {
		this.requireConnection();

		let cbs = this.callbacks.get(topic);
		const isFirst = !cbs || cbs.size === 0;
		if (!cbs) {
			cbs = new Set();
			this.callbacks.set(topic, cbs);
		}

		if (isFirst) {
			this.send({ action: "subscribe", topic });
			// Add a placeholder so the Set is non-empty during ack wait
			const placeholder = () => {};
			cbs.add(placeholder);
			await this.awaitAck(topic);
			cbs.delete(placeholder);
		}

		return new Promise((resolve, reject) => {
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.removeCallback(topic, callback);
				reject(new Error(`waitForMessage timed out after ${timeoutMs}ms on topic "${topic}"`));
			}, timeoutMs);

			const callback = (payload: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.removeCallback(topic, callback);
				resolve(payload);
			};

			cbs!.add(callback);
		});
	}

	private handleMessage(ev: MessageEvent): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(ev.data as string);
		} catch {
			return;
		}

		if (!msg || typeof msg !== "object") return;

		// Handle subscribe acknowledgment
		if (msg.action === "subscribed" && typeof msg.topic === "string") {
			const acks = this.pendingAcks.get(msg.topic);
			if (acks) {
				const resolve = acks.shift();
				if (resolve) resolve();
				if (acks.length === 0) this.pendingAcks.delete(msg.topic);
			}
			return;
		}

		// Handle normal delivery
		if (typeof msg.topic !== "string" || typeof msg.payload !== "string") return;

		const cbs = this.callbacks.get(msg.topic);
		if (!cbs) return;

		for (const cb of cbs) {
			try {
				cb(msg.payload);
			} catch {
				// Don't let one callback failure prevent others from firing
			}
		}
	}

	/** Register an ack resolver for a topic (used by waitForMessage). */
	private registerAck(topic: string, resolve: () => void): void {
		let acks = this.pendingAcks.get(topic);
		if (!acks) {
			acks = [];
			this.pendingAcks.set(topic, acks);
		}
		acks.push(resolve);
	}

	/** Wait for the server to acknowledge a subscribe for a topic. */
	private awaitAck(topic: string): Promise<void> {
		return new Promise<void>((resolve) => {
			this.registerAck(topic, resolve);
		});
	}

	private send(msg: ClientAction): void {
		this.ws!.send(JSON.stringify(msg));
	}

	private requireConnection(): void {
		if (!this.connected) {
			throw new Error("BusClient is not connected");
		}
	}

	/**
	 * Remove a specific callback from a topic. If it was the last callback,
	 * send an unsubscribe to the server and clean up the map entry.
	 */
	private removeCallback(topic: string, callback: (payload: string) => void): void {
		const cbs = this.callbacks.get(topic);
		if (!cbs) return;
		cbs.delete(callback);
		if (cbs.size === 0) {
			this.callbacks.delete(topic);
			if (this.connected) {
				this.send({ action: "unsubscribe", topic });
			}
		}
	}
}
