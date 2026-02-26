import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/host/event-bus.ts";
import type { ServerMessage } from "../../src/web/protocol.ts";
import { WebServer } from "../../src/web/server.ts";

// --- Helpers ---

/** Connect a WebSocket client and wait for the connection to open. */
function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

/** Wait for the next JSON message from a WebSocket. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
		ws.addEventListener(
			"message",
			(ev) => {
				clearTimeout(timer);
				resolve(JSON.parse(ev.data as string) as ServerMessage);
			},
			{ once: true },
		);
	});
}

/** Collect all JSON messages arriving on a WebSocket into an array. */
function collectMessages(ws: WebSocket): ServerMessage[] {
	const messages: ServerMessage[] = [];
	ws.addEventListener("message", (ev) => {
		messages.push(JSON.parse(ev.data as string) as ServerMessage);
	});
	return messages;
}

/** Brief delay for message propagation. */
function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a WebSocket to fully close. */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.CLOSED) {
			resolve();
			return;
		}
		const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs);
		ws.addEventListener(
			"close",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

// --- Test setup ---

let bus: EventBus;
let server: WebServer;
let staticDir: string;
let port: number;
const clients: WebSocket[] = [];

beforeEach(() => {
	bus = new EventBus();
	staticDir = mkdtempSync(join(tmpdir(), "sprout-web-test-"));
	// Create a simple index.html for static serving tests
	writeFileSync(join(staticDir, "index.html"), "<html><body>Hello</body></html>");
	// Pick a random high port
	port = 10000 + Math.floor(Math.random() * 50000);
	server = new WebServer({ bus, port, staticDir, sessionId: "test-session" });
});

afterEach(async () => {
	// Close all test WS clients
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			ws.close();
		}
	}
	clients.length = 0;
	await server.stop();
});

/** Connect and track for cleanup. */
async function connectClient(): Promise<WebSocket> {
	const ws = await connect(`ws://localhost:${port}/ws`);
	clients.push(ws);
	return ws;
}

describe("WebServer", () => {
	describe("lifecycle", () => {
		test("start() and stop() without error", async () => {
			await server.start();
			await server.stop();
		});

		test("stop() is idempotent", async () => {
			await server.start();
			await server.stop();
			await server.stop();
		});
	});

	describe("HTTP static file serving", () => {
		test("GET / serves index.html", async () => {
			await server.start();
			const resp = await fetch(`http://localhost:${port}/`);
			expect(resp.status).toBe(200);
			const text = await resp.text();
			expect(text).toContain("Hello");
		});

		test("GET /assets/* serves files from staticDir", async () => {
			// Create an assets subdirectory with a file
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(staticDir, "assets"), { recursive: true });
			writeFileSync(join(staticDir, "assets", "app.js"), "console.log('hi')");

			await server.start();
			const resp = await fetch(`http://localhost:${port}/assets/app.js`);
			expect(resp.status).toBe(200);
			const text = await resp.text();
			expect(text).toBe("console.log('hi')");
		});

		test("GET /nonexistent returns 404", async () => {
			await server.start();
			const resp = await fetch(`http://localhost:${port}/nonexistent`);
			expect(resp.status).toBe(404);
		});
	});

	describe("HTTP API", () => {
		test("GET /api/session returns session id and status", async () => {
			await server.start();
			const resp = await fetch(`http://localhost:${port}/api/session`);
			expect(resp.status).toBe(200);
			const body = (await resp.json()) as { id: string; status: string };
			expect(body.id).toBe("test-session");
			expect(body.status).toBe("idle");
		});

		test("session status reflects session_start event", async () => {
			await server.start();
			bus.emitEvent("session_start", "root", 0, { goal: "test" });

			const resp = await fetch(`http://localhost:${port}/api/session`);
			const body = (await resp.json()) as { id: string; status: string };
			expect(body.status).toBe("running");
		});

		test("session status reflects session_end event", async () => {
			await server.start();
			bus.emitEvent("session_start", "root", 0);
			bus.emitEvent("session_end", "root", 0);

			const resp = await fetch(`http://localhost:${port}/api/session`);
			const body = (await resp.json()) as { id: string; status: string };
			expect(body.status).toBe("idle");
		});

		test("session status reflects interrupted event", async () => {
			await server.start();
			bus.emitEvent("session_start", "root", 0);
			bus.emitEvent("interrupted", "root", 0);

			const resp = await fetch(`http://localhost:${port}/api/session`);
			const body = (await resp.json()) as { id: string; status: string };
			expect(body.status).toBe("interrupted");
		});
	});

	describe("WebSocket snapshot on connect", () => {
		test("sends snapshot with empty events when no events buffered", async () => {
			await server.start();
			const ws = await connectClient();
			const msg = await nextMessage(ws);

			expect(msg.type).toBe("snapshot");
			if (msg.type !== "snapshot") throw new Error("Expected snapshot");
			expect(msg.events).toEqual([]);
			expect(msg.session.id).toBe("test-session");
			expect(msg.session.status).toBe("idle");
		});

		test("sends snapshot with buffered events on connect", async () => {
			await server.start();
			bus.emitEvent("session_start", "root", 0, { goal: "fix bug" });
			bus.emitEvent("perceive", "root", 0, { input: "hello" });

			const ws = await connectClient();
			const msg = await nextMessage(ws);

			expect(msg.type).toBe("snapshot");
			if (msg.type !== "snapshot") throw new Error("Expected snapshot");
			expect(msg.events).toHaveLength(2);
			expect(msg.events[0]!.kind).toBe("session_start");
			expect(msg.events[1]!.kind).toBe("perceive");
			expect(msg.session.status).toBe("running");
		});
	});

	describe("WebSocket event streaming", () => {
		test("streams new events after snapshot", async () => {
			await server.start();
			const ws = await connectClient();

			// Consume the initial snapshot
			const snapshot = await nextMessage(ws);
			expect(snapshot.type).toBe("snapshot");

			// Now emit a new event on the bus
			bus.emitEvent("plan_start", "root", 0, { turn: 1 });

			const eventMsg = await nextMessage(ws);
			expect(eventMsg.type).toBe("event");
			if (eventMsg.type !== "event") throw new Error("Expected event");
			expect(eventMsg.event.kind).toBe("plan_start");
			expect(eventMsg.event.data.turn).toBe(1);
		});

		test("streams multiple events in order", async () => {
			await server.start();
			const ws = await connectClient();
			const messages = collectMessages(ws);

			// Wait for snapshot
			await delay(50);

			bus.emitEvent("plan_start", "root", 0);
			bus.emitEvent("plan_delta", "root", 0, { text: "thinking" });
			bus.emitEvent("plan_end", "root", 0);

			await delay(100);

			// First message is snapshot, then 3 events
			expect(messages).toHaveLength(4);
			expect(messages[0]!.type).toBe("snapshot");
			expect(messages[1]!.type).toBe("event");
			expect(messages[2]!.type).toBe("event");
			expect(messages[3]!.type).toBe("event");
			if (messages[1]!.type !== "event") throw new Error("Expected event");
			expect(messages[1]!.event.kind).toBe("plan_start");
		});

		test("multiple clients receive the same events", async () => {
			await server.start();
			const ws1 = await connectClient();
			const msgs1 = collectMessages(ws1);
			const ws2 = await connectClient();
			const msgs2 = collectMessages(ws2);

			// Wait for snapshots to arrive
			await delay(100);

			bus.emitEvent("plan_start", "root", 0, { turn: 1 });

			await delay(100);

			// Both should have snapshot + event
			expect(msgs1).toHaveLength(2);
			expect(msgs2).toHaveLength(2);
			expect(msgs1[0]!.type).toBe("snapshot");
			expect(msgs2[0]!.type).toBe("snapshot");
			expect(msgs1[1]!.type).toBe("event");
			expect(msgs2[1]!.type).toBe("event");
			if (msgs1[1]!.type !== "event" || msgs2[1]!.type !== "event")
				throw new Error("Expected events");
			expect(msgs1[1]!.event.kind).toBe("plan_start");
			expect(msgs2[1]!.event.kind).toBe("plan_start");
		});
	});

	describe("WebSocket commands", () => {
		test("command sent over WS triggers bus.onCommand listener", async () => {
			await server.start();
			const ws = await connectClient();
			await nextMessage(ws); // consume snapshot

			const received: { kind: string; data: Record<string, unknown> }[] = [];
			bus.onCommand((cmd) => received.push(cmd));

			ws.send(
				JSON.stringify({
					type: "command",
					command: { kind: "submit_goal", data: { goal: "Write tests" } },
				}),
			);

			await delay(100);

			expect(received).toHaveLength(1);
			expect(received[0]!.kind).toBe("submit_goal");
			expect(received[0]!.data.goal).toBe("Write tests");
		});

		test("invalid command message does not crash the server", async () => {
			await server.start();
			const ws = await connectClient();
			await nextMessage(ws); // consume snapshot

			// Send garbage
			ws.send("not json");
			ws.send(JSON.stringify({ type: "wrong" }));
			ws.send(JSON.stringify({ type: "command", command: "bad" }));

			// Server should still be alive — emit an event and verify it arrives
			await delay(50);
			bus.emitEvent("plan_start", "root", 0);
			const msg = await nextMessage(ws);
			expect(msg.type).toBe("event");
		});
	});

	describe("WebSocket disconnect and reconnect", () => {
		test("reconnect receives snapshot with events from before", async () => {
			await server.start();

			// First client connects and receives empty snapshot
			const ws1 = await connectClient();
			const snapshot1 = await nextMessage(ws1);
			expect(snapshot1.type).toBe("snapshot");
			if (snapshot1.type !== "snapshot") throw new Error("Expected snapshot");
			expect(snapshot1.events).toHaveLength(0);

			// Events happen while connected
			bus.emitEvent("session_start", "root", 0);
			bus.emitEvent("plan_start", "root", 0, { turn: 1 });
			await delay(50);

			// Disconnect
			ws1.close();
			await waitForClose(ws1);

			// More events happen while disconnected
			bus.emitEvent("plan_end", "root", 0);

			// Reconnect — should get all 3 events in snapshot
			const ws2 = await connectClient();
			const snapshot2 = await nextMessage(ws2);
			expect(snapshot2.type).toBe("snapshot");
			if (snapshot2.type !== "snapshot") throw new Error("Expected snapshot");
			expect(snapshot2.events).toHaveLength(3);
			expect(snapshot2.events[0]!.kind).toBe("session_start");
			expect(snapshot2.events[1]!.kind).toBe("plan_start");
			expect(snapshot2.events[2]!.kind).toBe("plan_end");
		});

		test("unsubscribes from bus on close (no leaked listeners)", async () => {
			await server.start();
			const ws = await connectClient();
			await nextMessage(ws); // consume snapshot

			ws.close();
			await waitForClose(ws);

			// Emitting events should not throw or accumulate listeners
			bus.emitEvent("plan_start", "root", 0);
			// If we leaked listeners, they'd try to send to a closed WS
			// Just verify no error occurred
		});
	});

	describe("event buffer cap", () => {
		test("buffer is capped at 10,000 events", async () => {
			await server.start();

			// Emit more than the cap
			for (let i = 0; i < 10_500; i++) {
				bus.emitEvent("plan_delta", "root", 0, { i });
			}

			const ws = await connectClient();
			const msg = await nextMessage(ws);
			expect(msg.type).toBe("snapshot");
			if (msg.type !== "snapshot") throw new Error("Expected snapshot");
			expect(msg.events.length).toBeLessThanOrEqual(10_000);
			// Should contain the newest events
			const last = msg.events[msg.events.length - 1]!;
			expect(last.data.i).toBe(10_499);
		});
	});
});
