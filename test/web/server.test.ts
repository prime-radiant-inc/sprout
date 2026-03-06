import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/host/event-bus.ts";
import { WebServer } from "../../src/web/server.ts";
import {
	collectMessages,
	connect,
	createStaticDir,
	delay,
	nextMessage,
	randomPort,
	waitForClose,
} from "./fixtures.ts";

// --- Test setup ---

let bus: EventBus;
let server: WebServer;
let staticDir: string;
let port: number;
const clients: WebSocket[] = [];

beforeEach(() => {
	bus = new EventBus();
	staticDir = createStaticDir("sprout-web-test-", "<html><body>Hello</body></html>");
	port = randomPort();
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

		test("start() auto-generates nonce for non-localhost binds and enforces auth", async () => {
			const remotePort = port + 1;
			const remoteServer = new WebServer({
				bus,
				port: remotePort,
				staticDir,
				sessionId: "remote-session",
				hostname: "0.0.0.0",
			});

			await remoteServer.start();
			const nonce = remoteServer.getWebToken();
			expect(typeof nonce).toBe("string");
			expect((nonce ?? "").length).toBeGreaterThanOrEqual(16);

			const unauthorized = await fetch(`http://localhost:${remotePort}/`, {
				headers: {
					upgrade: "websocket",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version": "13",
					connection: "upgrade",
				},
			});
			expect(unauthorized.status).toBe(401);

			const ws = await connect(
				`ws://localhost:${remotePort}/ws?token=${encodeURIComponent(nonce!)}`,
			);
			clients.push(ws);
			const snapshot = await nextMessage(ws);
			expect(snapshot.type).toBe("snapshot");

			await remoteServer.stop();
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

		test("path traversal attempt does not serve files outside staticDir", async () => {
			// Create a file one level above staticDir to verify it's unreachable
			const { basename, dirname, resolve } = await import("node:path");
			const parentDir = dirname(staticDir);
			const secretName = `secret-${basename(staticDir)}.txt`;
			writeFileSync(join(parentDir, secretName), "top secret");

			await server.start();

			// Bun's URL parser normalizes /../.. before it reaches serveStatic,
			// providing a first layer of defense. Our resolve+startsWith check
			// in serveStatic provides defense-in-depth against bypasses.
			const resp = await fetch(`http://localhost:${port}/../${secretName}`);
			expect(resp.status).toBe(404);

			// Verify the resolve+startsWith guard: a crafted pathname with ..
			// would resolve outside staticDir and should be caught
			const malicious = resolve(staticDir, `./../../../etc/passwd`);
			expect(malicious.startsWith(resolve(staticDir))).toBe(false);
		});
	});

	describe("HTTP API", () => {
		test("GET /api/auth returns ok when no token is configured", async () => {
			await server.start();
			const resp = await fetch(`http://localhost:${port}/api/auth`);
			expect(resp.status).toBe(200);
			const body = (await resp.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
		});

		test("GET /api/auth returns 401 when token is required and missing", async () => {
			const tokenPort = port + 10;
			const tokenServer = new WebServer({
				bus,
				port: tokenPort,
				staticDir,
				sessionId: "auth-token-missing",
				webToken: "secret-token",
			});
			await tokenServer.start();
			try {
				const resp = await fetch(`http://localhost:${tokenPort}/api/auth`);
				expect(resp.status).toBe(401);
			} finally {
				await tokenServer.stop();
			}
		});

		test("GET /api/auth accepts valid token query param", async () => {
			const tokenPort = port + 11;
			const tokenServer = new WebServer({
				bus,
				port: tokenPort,
				staticDir,
				sessionId: "auth-token-valid",
				webToken: "secret-token",
			});
			await tokenServer.start();
			try {
				const resp = await fetch(`http://localhost:${tokenPort}/api/auth?token=secret-token`);
				expect(resp.status).toBe(200);
				const body = (await resp.json()) as { ok: boolean };
				expect(body.ok).toBe(true);
			} finally {
				await tokenServer.stop();
			}
		});

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

		test("session_clear updates session id and resets to idle", async () => {
			await server.start();
			bus.emitEvent("session_start", "root", 0, { goal: "old" });
			bus.emitEvent("session_clear", "session", 0, {
				new_session_id: "new-session-id",
			});

			const resp = await fetch(`http://localhost:${port}/api/session`);
			const body = (await resp.json()) as { id: string; status: string };
			expect(body.id).toBe("new-session-id");
			expect(body.status).toBe("idle");
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
			ws.send(JSON.stringify({ type: "command", command: { kind: "custom_thing", data: {} } }));

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

		test("emitting after client disconnect does not crash", async () => {
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

	describe("WebSocket upgrade failure", () => {
		test("returns 400 when WebSocket upgrade fails", async () => {
			await server.start();
			// Send a request with upgrade header but missing required WS headers
			const res = await fetch(`http://localhost:${port}/`, {
				headers: { upgrade: "websocket" },
			});
			expect(res.status).toBe(400);
		});
	});

	describe("WebSocket origin validation", () => {
		test("rejects WebSocket upgrade from non-localhost origin", async () => {
			await server.start();
			const res = await fetch(`http://localhost:${port}/`, {
				headers: {
					upgrade: "websocket",
					origin: "https://evil.example.com",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version": "13",
					connection: "upgrade",
				},
			});
			expect(res.status).toBe(403);
		});

		test("still enforces strict origin checks on 0.0.0.0 binds", async () => {
			const remotePort = port + 2;
			const remoteServer = new WebServer({
				bus,
				port: remotePort,
				staticDir,
				sessionId: "remote-origin-test",
				hostname: "0.0.0.0",
				webToken: "secret-token",
			});
			await remoteServer.start();
			const res = await fetch(`http://localhost:${remotePort}/`, {
				headers: {
					upgrade: "websocket",
					origin: "https://evil.example.com",
					authorization: "Bearer secret-token",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version": "13",
					connection: "upgrade",
				},
			});
			expect(res.status).toBe(403);
			await remoteServer.stop();
		});
	});

	describe("WebSocket token auth", () => {
		test("rejects websocket upgrade when token is required but missing", async () => {
			const tokenPort = port + 3;
			const tokenServer = new WebServer({
				bus,
				port: tokenPort,
				staticDir,
				sessionId: "token-test",
				webToken: "secret-token",
			});
			await tokenServer.start();
			const res = await fetch(`http://localhost:${tokenPort}/`, {
				headers: {
					upgrade: "websocket",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version": "13",
					connection: "upgrade",
				},
			});
			expect(res.status).toBe(401);
			await tokenServer.stop();
		});

		test("allows websocket connection with query token", async () => {
			const tokenPort = port + 4;
			const tokenServer = new WebServer({
				bus,
				port: tokenPort,
				staticDir,
				sessionId: "token-test-ok",
				webToken: "secret-token",
			});
			await tokenServer.start();
			const ws = await connect(`ws://localhost:${tokenPort}/ws?token=secret-token`);
			clients.push(ws);
			const msg = await nextMessage(ws);
			expect(msg.type).toBe("snapshot");
			await tokenServer.stop();
		});
	});

	describe("event buffer cap", () => {
		test("buffer trims to EVENT_CAP when exceeding 2x cap", async () => {
			await server.start();

			// Emit exactly 2x cap + 1 to trigger amortized trim, leaving exactly EVENT_CAP
			const total = 20_001;
			for (let i = 0; i < total; i++) {
				bus.emitEvent("plan_delta", "root", 0, { i });
			}

			const ws = await connectClient();
			const msg = await nextMessage(ws);
			expect(msg.type).toBe("snapshot");
			if (msg.type !== "snapshot") throw new Error("Expected snapshot");
			expect(msg.events.length).toBe(10_000);
			// Should contain the newest events
			const last = msg.events[msg.events.length - 1]!;
			expect(last.data.i).toBe(total - 1);
		});
	});

	describe("session_clear buffer behavior", () => {
		test("snapshot after session_clear excludes pre-clear events", async () => {
			await server.start();
			bus.emitEvent("session_start", "root", 0, { goal: "old session" });
			bus.emitEvent("plan_end", "root", 0, { text: "old result" });
			bus.emitEvent("session_clear", "session", 0, { new_session_id: "new-session" });
			bus.emitEvent("plan_start", "root", 0, { turn: 1 });

			const ws = await connectClient();
			const snapshot = await nextMessage(ws);
			expect(snapshot.type).toBe("snapshot");
			if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
			expect(snapshot.session.id).toBe("new-session");
			expect(snapshot.events.map((e) => e.kind)).toEqual(["session_clear", "plan_start"]);
		});
	});

	describe("task_update event emission", () => {
		test("emits task_update when task-cli exec completes successfully", async () => {
			const dataDir = mkdtempSync(join(tmpdir(), "sprout-task-update-"));
			const logsDir = join(dataDir, "logs", "task-update-session");
			mkdirSync(logsDir, { recursive: true });
			writeFileSync(
				join(logsDir, "tasks.json"),
				JSON.stringify({
					tasks: [{ id: "1", description: "First task", status: "in_progress" }],
				}),
			);

			const port2 = randomPort();
			const server2 = new WebServer({
				bus,
				port: port2,
				staticDir,
				sessionId: "task-update-session",
				projectDataDir: dataDir,
			});
			await server2.start();

			const ws = await connect(`ws://localhost:${port2}/ws`);
			clients.push(ws);
			const messages = collectMessages(ws);

			// Wait for snapshot (and possible seed task_update) to arrive
			await delay(200);

			// Simulate task-cli exec: primitive_start then primitive_end
			bus.emitEvent("primitive_start", "agent-1", 1, {
				name: "exec",
				args: { command: "task-cli update 1 --status done" },
			});
			bus.emitEvent("primitive_end", "agent-1", 1, {
				name: "exec",
				success: true,
				args: { command: "task-cli update 1 --status done" },
			});

			// Wait for the async emitTaskUpdate to complete
			await delay(500);

			// Find task_update events among all received messages
			const taskUpdateMsgs = messages.filter(
				(m): m is import("../../src/web/protocol.ts").EventServerMessage =>
					m.type === "event" && m.event.kind === "task_update",
			);

			// Should have at least one task_update from the exec completion
			// (may also have the seed task_update from initial connect)
			expect(taskUpdateMsgs.length).toBeGreaterThanOrEqual(1);

			const lastTaskUpdate = taskUpdateMsgs[taskUpdateMsgs.length - 1]!;
			if (lastTaskUpdate.type !== "event") throw new Error("Expected event");
			expect(lastTaskUpdate.event.kind).toBe("task_update");
			expect(Array.isArray(lastTaskUpdate.event.data.tasks)).toBe(true);
			const tasks = lastTaskUpdate.event.data.tasks as { id: string }[];
			expect(tasks[0]!.id).toBe("1");

			await server2.stop();
		});

		test("emits task_update when task-cli primitive completes successfully", async () => {
			const dataDir = mkdtempSync(join(tmpdir(), "sprout-task-update-direct-"));
			const logsDir = join(dataDir, "logs", "task-update-direct-session");
			mkdirSync(logsDir, { recursive: true });
			writeFileSync(
				join(logsDir, "tasks.json"),
				JSON.stringify({
					tasks: [{ id: "1", description: "First task", status: "in_progress" }],
				}),
			);

			const port2 = randomPort();
			const server2 = new WebServer({
				bus,
				port: port2,
				staticDir,
				sessionId: "task-update-direct-session",
				projectDataDir: dataDir,
			});
			await server2.start();

			const ws = await connect(`ws://localhost:${port2}/ws`);
			clients.push(ws);
			const messages = collectMessages(ws);

			// Wait for snapshot (and possible seed task_update) to arrive
			await delay(200);

			// Simulate direct task-cli primitive: name is "task-cli", not "exec"
			bus.emitEvent("primitive_start", "agent-1", 1, {
				name: "task-cli",
				args: { command: "update", id: "1", status: "done" },
			});
			bus.emitEvent("primitive_end", "agent-1", 1, {
				name: "task-cli",
				success: true,
				args: { command: "update", id: "1", status: "done" },
			});

			// Wait for the async emitTaskUpdate to complete
			await delay(500);

			// Find task_update events among all received messages
			const taskUpdateMsgs = messages.filter(
				(m): m is import("../../src/web/protocol.ts").EventServerMessage =>
					m.type === "event" && m.event.kind === "task_update",
			);

			// Should have at least one task_update from the primitive completion
			expect(taskUpdateMsgs.length).toBeGreaterThanOrEqual(1);

			const lastTaskUpdate = taskUpdateMsgs[taskUpdateMsgs.length - 1]!;
			if (lastTaskUpdate.type !== "event") throw new Error("Expected event");
			expect(lastTaskUpdate.event.kind).toBe("task_update");
			expect(Array.isArray(lastTaskUpdate.event.data.tasks)).toBe(true);
			const tasks = lastTaskUpdate.event.data.tasks as { id: string }[];
			expect(tasks[0]!.id).toBe("1");

			await server2.stop();
		});

		test("does not emit task_update for non-task-cli exec", async () => {
			await server.start();
			const ws = await connectClient();
			const messages = collectMessages(ws);

			await delay(50);

			// Simulate a regular (non-task-cli) exec
			bus.emitEvent("primitive_start", "agent-1", 1, {
				name: "exec",
				args: { command: "ls -la" },
			});
			bus.emitEvent("primitive_end", "agent-1", 1, {
				name: "exec",
				success: true,
				args: { command: "ls -la" },
			});

			await delay(200);

			// Should have snapshot + 2 events (primitive_start, primitive_end), no task_update
			const eventMessages = messages.filter(
				(m) => m.type === "event" && (m.type === "event" ? m.event.kind : "") === "task_update",
			);
			expect(eventMessages).toHaveLength(0);
		});

		test("does not emit task_update for failed task-cli exec", async () => {
			await server.start();
			const ws = await connectClient();
			const messages = collectMessages(ws);

			await delay(50);

			bus.emitEvent("primitive_start", "agent-1", 1, {
				name: "exec",
				args: { command: "task-cli update 1 --status done" },
			});
			bus.emitEvent("primitive_end", "agent-1", 1, {
				name: "exec",
				success: false,
				error: "command failed",
				args: { command: "task-cli update 1 --status done" },
			});

			await delay(200);

			const taskUpdateMessages = messages.filter(
				(m) => m.type === "event" && (m.type === "event" ? m.event.kind : "") === "task_update",
			);
			expect(taskUpdateMessages).toHaveLength(0);
		});

		test("seedTasksForClient sends synthetic task_update on connect when tasks.json exists", async () => {
			const dataDir = mkdtempSync(join(tmpdir(), "sprout-seed-tasks-"));
			const logsDir = join(dataDir, "logs", "seed-session");
			mkdirSync(logsDir, { recursive: true });
			writeFileSync(
				join(logsDir, "tasks.json"),
				JSON.stringify({
					tasks: [{ id: "1", description: "Seeded task", status: "new" }],
				}),
			);

			const port2 = randomPort();
			const server2 = new WebServer({
				bus,
				port: port2,
				staticDir,
				sessionId: "seed-session",
				projectDataDir: dataDir,
			});
			await server2.start();

			const ws = await connect(`ws://localhost:${port2}/ws`);
			clients.push(ws);

			// First message is the snapshot
			const snapshot = await nextMessage(ws);
			expect(snapshot.type).toBe("snapshot");

			// Second message should be the synthetic task_update
			const seedMsg = await nextMessage(ws);
			expect(seedMsg.type).toBe("event");
			if (seedMsg.type !== "event") throw new Error("Expected event");
			expect(seedMsg.event.kind).toBe("task_update");
			expect(Array.isArray(seedMsg.event.data.tasks)).toBe(true);
			const tasks = seedMsg.event.data.tasks as { id: string; description: string }[];
			expect(tasks[0]!.description).toBe("Seeded task");

			await server2.stop();
		});

		test("seedTasksForClient does not send synthetic event when task_update already in buffer", async () => {
			const dataDir = mkdtempSync(join(tmpdir(), "sprout-seed-exists-"));
			const logsDir = join(dataDir, "logs", "seed-exists-session");
			mkdirSync(logsDir, { recursive: true });
			writeFileSync(
				join(logsDir, "tasks.json"),
				JSON.stringify({
					tasks: [{ id: "1", description: "Task", status: "new" }],
				}),
			);

			const port2 = randomPort();
			const server2 = new WebServer({
				bus,
				port: port2,
				staticDir,
				sessionId: "seed-exists-session",
				projectDataDir: dataDir,
			});
			await server2.start();

			// Emit a task_update event before connecting
			bus.emitEvent("task_update", "agent-1", 0, {
				tasks: [{ id: "1", description: "Already updated", status: "done" }],
			});

			const ws = await connect(`ws://localhost:${port2}/ws`);
			clients.push(ws);

			// First message is the snapshot (which already contains the task_update)
			const snapshot = await nextMessage(ws);
			expect(snapshot.type).toBe("snapshot");
			if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");

			// The snapshot should contain the task_update event
			const taskUpdates = snapshot.events.filter((e) => e.kind === "task_update");
			expect(taskUpdates).toHaveLength(1);

			// No additional synthetic event should arrive - wait a bit and check
			await delay(200);

			// Connect another client and verify it also gets snapshot only (no extra seed)
			const ws2 = await connect(`ws://localhost:${port2}/ws`);
			clients.push(ws2);
			const snapshot2 = await nextMessage(ws2);
			expect(snapshot2.type).toBe("snapshot");
			if (snapshot2.type !== "snapshot") throw new Error("Expected snapshot");
			const taskUpdates2 = snapshot2.events.filter((e) => e.kind === "task_update");
			expect(taskUpdates2).toHaveLength(1);

			await server2.stop();
		});

		test("GET /api/tasks returns 404 (endpoint removed)", async () => {
			await server.start();
			const resp = await fetch(`http://localhost:${port}/api/tasks`);
			expect(resp.status).toBe(404);
		});
	});
});
