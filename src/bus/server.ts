import type { ServerWebSocket } from "bun";

/** Wire-protocol message from client to server */
type ClientMessage =
	| { action: "subscribe"; topic: string }
	| { action: "unsubscribe"; topic: string }
	| { action: "publish"; topic: string; payload: string };

/** Wire-protocol message from server to client */
type ServerMessage =
	| { topic: string; payload: string }
	| { action: "subscribed"; topic: string };

type WSData = { id: number };

export interface BusServerOptions {
	/** Port to listen on. Use 0 for random port assignment. */
	port: number;
	/** Optional hostname. Defaults to "localhost". */
	hostname?: string;
}

/**
 * WebSocket bus server providing topic-based pub/sub messaging.
 * Clients connect via WebSocket and use a JSON wire protocol to
 * subscribe, unsubscribe, and publish to topics.
 */
export class BusServer {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly options: BusServerOptions;

	/** topic -> set of subscribed websockets */
	private subscriptions = new Map<string, Set<ServerWebSocket<WSData>>>();

	/** ws -> set of topics it's subscribed to (for cleanup on disconnect) */
	private clientTopics = new Map<ServerWebSocket<WSData>, Set<string>>();

	private nextClientId = 0;

	constructor(options: BusServerOptions) {
		this.options = options;
	}

	/** The WebSocket URL clients should use to connect. Only valid after start(). */
	get url(): string {
		if (!this.server) throw new Error("BusServer not started");
		return `ws://${this.options.hostname ?? "localhost"}:${this.server.port}`;
	}

	/** The port the server is listening on. Only valid after start(). */
	get port(): number {
		if (!this.server) throw new Error("BusServer not started");
		return this.server.port!;
	}

	async start(): Promise<void> {
		if (this.server) throw new Error("BusServer already started");

		const self = this;

		this.server = Bun.serve<WSData>({
			port: this.options.port,
			hostname: this.options.hostname ?? "localhost",
			fetch(req, server) {
				const upgraded = server.upgrade(req, {
					data: { id: self.nextClientId++ },
				});
				if (upgraded) return undefined;
				return new Response("Expected WebSocket upgrade", { status: 426 });
			},
			websocket: {
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
		this.server.stop(true);
		this.server = null;
		this.subscriptions.clear();
		this.clientTopics.clear();
	}

	private handleMessage(ws: ServerWebSocket<WSData>, raw: string | Buffer): void {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			return; // Ignore malformed JSON
		}

		if (!msg || typeof msg !== "object" || typeof msg.action !== "string") {
			return;
		}

		switch (msg.action) {
			case "subscribe":
				this.handleSubscribe(ws, msg);
				break;
			case "unsubscribe":
				this.handleUnsubscribe(ws, msg);
				break;
			case "publish":
				this.handlePublish(ws, msg as ClientMessage & { action: "publish" });
				break;
			default:
				return; // Ignore unknown actions
		}
	}

	private handleSubscribe(ws: ServerWebSocket<WSData>, msg: { topic: string }): void {
		if (typeof msg.topic !== "string") return;

		let subs = this.subscriptions.get(msg.topic);
		if (!subs) {
			subs = new Set();
			this.subscriptions.set(msg.topic, subs);
		}
		subs.add(ws);

		let topics = this.clientTopics.get(ws);
		if (!topics) {
			topics = new Set();
			this.clientTopics.set(ws, topics);
		}
		topics.add(msg.topic);
		ws.send(JSON.stringify({ action: "subscribed", topic: msg.topic }));
	}

	private handleUnsubscribe(ws: ServerWebSocket<WSData>, msg: { topic: string }): void {
		if (typeof msg.topic !== "string") return;

		const subs = this.subscriptions.get(msg.topic);
		if (subs) {
			subs.delete(ws);
			if (subs.size === 0) this.subscriptions.delete(msg.topic);
		}

		const topics = this.clientTopics.get(ws);
		if (topics) {
			topics.delete(msg.topic);
			if (topics.size === 0) this.clientTopics.delete(ws);
		}
	}

	private handlePublish(
		ws: ServerWebSocket<WSData>,
		msg: { topic: string; payload: string },
	): void {
		if (typeof msg.topic !== "string" || typeof msg.payload !== "string") {
			return;
		}

		const subs = this.subscriptions.get(msg.topic);
		if (!subs) return;

		const delivery: ServerMessage = {
			topic: msg.topic,
			payload: msg.payload,
		};
		const serialized = JSON.stringify(delivery);

		for (const sub of subs) {
			// Don't echo back to the sender
			if (sub === ws) continue;
			sub.send(serialized);
		}
	}

	private handleClose(ws: ServerWebSocket<WSData>): void {
		const topics = this.clientTopics.get(ws);
		if (topics) {
			for (const topic of topics) {
				const subs = this.subscriptions.get(topic);
				if (subs) {
					subs.delete(ws);
					if (subs.size === 0) this.subscriptions.delete(topic);
				}
			}
			this.clientTopics.delete(ws);
		}
	}
}
