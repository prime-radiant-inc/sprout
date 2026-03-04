import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/host/event-bus.ts";
import type { ServerMessage } from "../../../src/web/protocol.ts";
import { WebServer } from "../../../src/web/server.ts";
import { type WebSocketClientOptions, WebSocketClient } from "./useWebSocket.ts";

// --- Helpers ---

function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until a predicate returns true, polling every `intervalMs`. */
function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
	intervalMs = 20,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("waitFor timed out"));
				return;
			}
			setTimeout(check, intervalMs);
		};
		check();
	});
}

// --- Test setup ---

let bus: EventBus;
let server: WebServer;
let port: number;
let staticDir: string;
const clients: WebSocketClient[] = [];

beforeEach(() => {
	bus = new EventBus();
	staticDir = mkdtempSync(join(tmpdir(), "sprout-ws-hook-test-"));
	writeFileSync(join(staticDir, "index.html"), "<html><body>Test</body></html>");
	port = 10000 + Math.floor(Math.random() * 50000);
	server = new WebServer({ bus, port, staticDir, sessionId: "hook-test" });
});

afterEach(async () => {
	for (const client of clients) {
		client.dispose();
	}
	clients.length = 0;
	await server.stop();
	// Brief delay to let sockets fully close
	await delay(50);
});

function createClient(url?: string, options: WebSocketClientOptions = {}): WebSocketClient {
	const reconnectOptions: WebSocketClientOptions = {
		initialReconnectDelayMs: 20,
		maxReconnectDelayMs: 200,
		...options,
	};
	const client = new WebSocketClient(url ?? `ws://localhost:${port}/ws`, reconnectOptions);
	clients.push(client);
	return client;
}

describe("WebSocketClient", () => {
	describe("connection", () => {
		test("connects to server and receives snapshot", async () => {
			await server.start();
			const client = createClient();
			client.connect();

			await waitFor(() => client.connected);

			// Should have received the snapshot
			expect(client.lastMessage).not.toBeNull();
			expect(client.lastMessage!.type).toBe("snapshot");
			if (client.lastMessage!.type !== "snapshot") throw new Error("Expected snapshot");
			expect(client.lastMessage!.session.id).toBe("hook-test");
		});

		test("starts disconnected", () => {
			const client = createClient();
			expect(client.connected).toBe(false);
			expect(client.lastMessage).toBeNull();
		});

		test("dispose closes the connection", async () => {
			await server.start();
			const client = createClient();
			client.connect();
			await waitFor(() => client.connected);

			client.dispose();
			await waitFor(() => !client.connected);
			expect(client.connected).toBe(false);
		});
	});

	describe("receiving messages", () => {
		test("receives live events after snapshot", async () => {
			await server.start();
			const client = createClient();
			const received: ServerMessage[] = [];
			client.onMessage((msg) => received.push(msg));
			client.connect();

			await waitFor(() => client.connected);
			// Wait for snapshot
			await waitFor(() => received.length >= 1);
			expect(received[0]!.type).toBe("snapshot");

			// Emit an event on the bus
			bus.emitEvent("plan_start", "root", 0, { turn: 1 });

			await waitFor(() => received.length >= 2);
			expect(received[1]!.type).toBe("event");
			if (received[1]!.type !== "event") throw new Error("Expected event");
			expect(received[1]!.event.kind).toBe("plan_start");
		});

		test("lastMessage reflects the most recent message", async () => {
			await server.start();
			const client = createClient();
			client.connect();
			await waitFor(() => client.connected);
			// Snapshot is first
			await waitFor(() => client.lastMessage !== null);
			expect(client.lastMessage!.type).toBe("snapshot");

			bus.emitEvent("plan_start", "root", 0);
			await waitFor(() => client.lastMessage?.type === "event");
			if (client.lastMessage!.type !== "event") throw new Error("Expected event");
			expect(client.lastMessage!.event.kind).toBe("plan_start");
		});
	});

	describe("sending messages", () => {
		test("send() delivers a command to the server", async () => {
			await server.start();
			const client = createClient();
			client.connect();
			await waitFor(() => client.connected);

			const commands: { kind: string; data: Record<string, unknown> }[] = [];
			bus.onCommand((cmd) => commands.push(cmd));

			client.send({
				type: "command",
				command: { kind: "submit_goal", data: { goal: "hello" } },
			});

			await waitFor(() => commands.length >= 1);
			expect(commands[0]!.kind).toBe("submit_goal");
			expect(commands[0]!.data.goal).toBe("hello");
		});

		test("send() queues messages while disconnected and delivers on connect", async () => {
			await server.start();
			const client = createClient();

			const commands: { kind: string; data: Record<string, unknown> }[] = [];
			bus.onCommand((cmd) => commands.push(cmd));

			// Send while not connected — should be queued
			client.send({
				type: "command",
				command: { kind: "submit_goal", data: { goal: "queued" } },
			});

			expect(commands).toHaveLength(0);

			// Now connect — queued message should be delivered
			client.connect();
			await waitFor(() => client.connected);

			await waitFor(() => commands.length >= 1);
			expect(commands[0]!.kind).toBe("submit_goal");
			expect(commands[0]!.data.goal).toBe("queued");
		});

		test("send() queue is capped while disconnected (drops oldest)", async () => {
			await server.start();
			const client = createClient(undefined, { maxQueuedMessages: 2 });

			const commands: { kind: string; data: Record<string, unknown> }[] = [];
			bus.onCommand((cmd) => commands.push(cmd));

			client.send({
				type: "command",
				command: { kind: "submit_goal", data: { goal: "oldest" } },
			});
			client.send({
				type: "command",
				command: { kind: "submit_goal", data: { goal: "middle" } },
			});
			client.send({
				type: "command",
				command: { kind: "submit_goal", data: { goal: "newest" } },
			});

			client.connect();
			await waitFor(() => client.connected);
			await waitFor(() => commands.length >= 2);
			await delay(100);

			expect(commands).toHaveLength(2);
			expect(commands[0]!.data.goal).toBe("middle");
			expect(commands[1]!.data.goal).toBe("newest");
		});
	});

	describe("reconnection", () => {
		test("reconnects after server stop and restart", async () => {
			await server.start();
			const client = createClient();
			client.connect();
			await waitFor(() => client.connected);

			// Stop the server — client should disconnect
			await server.stop();
			await waitFor(() => !client.connected);

			// Restart the server on the same port
			server = new WebServer({ bus, port, staticDir, sessionId: "hook-test-2" });
			await server.start();

			// Client should auto-reconnect
			await waitFor(() => client.connected, 10000);

			// Should receive a fresh snapshot from the new server
			expect(client.lastMessage).not.toBeNull();
			expect(client.lastMessage!.type).toBe("snapshot");
			if (client.lastMessage!.type !== "snapshot") throw new Error("Expected snapshot");
			expect(client.lastMessage!.session.id).toBe("hook-test-2");
		});

		test("queued messages are delivered after reconnection", async () => {
			await server.start();
			const client = createClient();
			client.connect();
			await waitFor(() => client.connected);

			const commands: { kind: string; data: Record<string, unknown> }[] = [];
			bus.onCommand((cmd) => commands.push(cmd));

			// Stop the server
			await server.stop();
			await waitFor(() => !client.connected);

			// Send while disconnected
			client.send({
				type: "command",
				command: { kind: "interrupt", data: {} },
			});
			expect(commands).toHaveLength(0);

			// Restart the server
			server = new WebServer({ bus, port, staticDir, sessionId: "hook-test-3" });
			await server.start();
			// Re-subscribe since new server has a new bus subscription
			bus.onCommand((cmd) => commands.push(cmd));

			await waitFor(() => client.connected, 10000);

			// Queued command should have been sent
			await waitFor(() => commands.length >= 1, 5000);
			expect(commands[0]!.kind).toBe("interrupt");
		});

		test("does not reconnect after dispose()", async () => {
			await server.start();
			const client = createClient();
			client.connect();
			await waitFor(() => client.connected);

			client.dispose();
			await waitFor(() => !client.connected);

			// Wait long enough that a reconnect would have fired
			await delay(200);
			expect(client.connected).toBe(false);
		});
	});

	describe("onStateChange callback", () => {
		test("fires with true on connect", async () => {
			await server.start();
			const client = createClient();
			const states: boolean[] = [];
			client.onStateChange((connected) => states.push(connected));
			client.connect();

			await waitFor(() => states.includes(true));
			expect(states).toContain(true);
		});

		test("fires with false on dispose", async () => {
			await server.start();
			const client = createClient();
			const states: boolean[] = [];
			client.onStateChange((connected) => states.push(connected));
			client.connect();

			await waitFor(() => client.connected);
			client.dispose();
			expect(states).toContain(false);
		});

		test("fires with false on server-initiated close", async () => {
			await server.start();
			const client = createClient();
			const states: boolean[] = [];
			client.onStateChange((connected) => states.push(connected));
			client.connect();

			await waitFor(() => client.connected);
			await server.stop();
			await waitFor(() => states.includes(false));
			expect(states).toContain(false);
		});

		test("unsubscribe stops delivery", async () => {
			await server.start();
			const client = createClient();
			const states: boolean[] = [];
			const unsub = client.onStateChange((connected) => states.push(connected));
			unsub();

			client.connect();
			await waitFor(() => client.connected);
			await delay(100);

			expect(states).toHaveLength(0);
		});

		test("multiple listeners all receive state changes", async () => {
			await server.start();
			const client = createClient();
			const states1: boolean[] = [];
			const states2: boolean[] = [];
			client.onStateChange((connected) => states1.push(connected));
			client.onStateChange((connected) => states2.push(connected));
			client.connect();

			await waitFor(() => states1.includes(true));
			expect(states1).toContain(true);
			expect(states2).toContain(true);
		});
	});

	describe("onMessage callback", () => {
		test("multiple onMessage listeners all receive messages", async () => {
			await server.start();
			const client = createClient();
			const msgs1: ServerMessage[] = [];
			const msgs2: ServerMessage[] = [];
			client.onMessage((msg) => msgs1.push(msg));
			client.onMessage((msg) => msgs2.push(msg));

			client.connect();
			await waitFor(() => client.connected);
			await waitFor(() => msgs1.length >= 1);

			expect(msgs1.length).toBe(msgs2.length);
			expect(msgs1[0]!.type).toBe("snapshot");
			expect(msgs2[0]!.type).toBe("snapshot");
		});

		test("unsubscribe from onMessage stops delivery", async () => {
			await server.start();
			const client = createClient();
			const msgs: ServerMessage[] = [];
			const unsub = client.onMessage((msg) => msgs.push(msg));

			client.connect();
			await waitFor(() => msgs.length >= 1);

			unsub();

			bus.emitEvent("plan_start", "root", 0);
			await delay(100);

			// Should only have the snapshot, not the event
			expect(msgs).toHaveLength(1);
		});
	});
});
