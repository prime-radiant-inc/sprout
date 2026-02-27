import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/host/event-bus.ts";
import type { ServerMessage } from "../../src/web/protocol.ts";
import { WebServer } from "../../src/web/server.ts";

/**
 * End-to-end tests for the web interface round-trip.
 *
 * These verify the full flow:
 *   Browser (WS client) -> WebServer -> EventBus -> command handler
 *     -> emitEvent -> WebServer -> Browser (WS client)
 *
 * No SessionController or LLM — we register a command handler that
 * simulates what SessionController.handleCommand does: emit events
 * back on the bus in response to commands.
 */

// --- Helpers ---

function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

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

function collectMessages(ws: WebSocket): ServerMessage[] {
	const messages: ServerMessage[] = [];
	ws.addEventListener("message", (ev) => {
		messages.push(JSON.parse(ev.data as string) as ServerMessage);
	});
	return messages;
}

function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Test setup ---

let bus: EventBus;
let server: WebServer;
let port: number;
const clients: WebSocket[] = [];

beforeEach(() => {
	bus = new EventBus();
	const staticDir = mkdtempSync(join(tmpdir(), "sprout-e2e-test-"));
	writeFileSync(join(staticDir, "index.html"), "<html><body>E2E</body></html>");
	port = 10000 + Math.floor(Math.random() * 50000);
	server = new WebServer({
		bus,
		port,
		staticDir,
		sessionId: "e2e-session",
	});
});

afterEach(async () => {
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			ws.close();
		}
	}
	clients.length = 0;
	await server.stop();
});

async function connectClient(): Promise<WebSocket> {
	const ws = await connect(`ws://localhost:${port}/ws`);
	clients.push(ws);
	return ws;
}

/**
 * Send a command message via WebSocket (matches what the browser does).
 */
function sendCommand(ws: WebSocket, kind: string, data: Record<string, unknown>): void {
	ws.send(JSON.stringify({ type: "command", command: { kind, data } }));
}

describe("Web interface end-to-end", () => {
	test("submit_goal command triggers events that arrive back at the client", async () => {
		await server.start();

		// Simulate SessionController: when we receive submit_goal,
		// emit the same events the real controller would
		bus.onCommand((cmd) => {
			if (cmd.kind === "submit_goal") {
				const goal = cmd.data.goal as string;
				bus.emitEvent("perceive", "root", 0, { goal });
				bus.emitEvent("session_start", "root", 0, { goal, model: "test" });
				bus.emitEvent("plan_start", "root", 0, { turn: 1 });
				bus.emitEvent("plan_end", "root", 0, {
					text: `Response to: ${goal}`,
					turn: 1,
				});
				bus.emitEvent("session_end", "root", 0);
			}
		});

		const ws = await connectClient();
		const messages = collectMessages(ws);

		// Wait for snapshot
		await delay(100);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.type).toBe("snapshot");

		// Send submit_goal (this is exactly what the browser sends)
		sendCommand(ws, "submit_goal", { goal: "Write hello world" });

		await delay(200);

		// Should have received: snapshot + 5 events
		expect(messages).toHaveLength(6);
		expect(messages[1]!.type).toBe("event");
		expect(messages[2]!.type).toBe("event");
		expect(messages[3]!.type).toBe("event");
		expect(messages[4]!.type).toBe("event");
		expect(messages[5]!.type).toBe("event");

		// Verify event kinds in order
		const eventKinds = messages.slice(1).map((m) => (m.type === "event" ? m.event.kind : null));
		expect(eventKinds).toEqual([
			"perceive",
			"session_start",
			"plan_start",
			"plan_end",
			"session_end",
		]);

		// Verify the plan_end carries the response text
		const planEnd = messages[4]!;
		if (planEnd.type !== "event") throw new Error("Expected event");
		expect(planEnd.event.data.text).toBe("Response to: Write hello world");
	});

	test("steer command is received by command handler", async () => {
		await server.start();

		const received: Array<{ kind: string; data: Record<string, unknown> }> = [];
		bus.onCommand((cmd) => received.push(cmd));

		const ws = await connectClient();
		await nextMessage(ws); // consume snapshot

		sendCommand(ws, "steer", { text: "focus on tests" });
		await delay(100);

		expect(received).toHaveLength(1);
		expect(received[0]!.kind).toBe("steer");
		expect(received[0]!.data.text).toBe("focus on tests");
	});

	test("interrupt command is received by command handler", async () => {
		await server.start();

		const received: Array<{ kind: string }> = [];
		bus.onCommand((cmd) => received.push({ kind: cmd.kind }));

		const ws = await connectClient();
		await nextMessage(ws); // consume snapshot

		sendCommand(ws, "interrupt", {});
		await delay(100);

		expect(received).toHaveLength(1);
		expect(received[0]!.kind).toBe("interrupt");
	});

	test("session status updates flow back to new connections", async () => {
		await server.start();

		// Simulate a session starting (emit perceive + session_start like real controller)
		bus.onCommand((cmd) => {
			if (cmd.kind === "submit_goal") {
				bus.emitEvent("perceive", "root", 0, { goal: cmd.data.goal });
				bus.emitEvent("session_start", "root", 0, { goal: cmd.data.goal });
			}
		});

		const ws1 = await connectClient();
		await nextMessage(ws1); // snapshot with status: idle

		sendCommand(ws1, "submit_goal", { goal: "Do something" });
		await delay(100);

		// New client connects and should see status: running
		const ws2 = await connectClient();
		const snapshot = await nextMessage(ws2);
		expect(snapshot.type).toBe("snapshot");
		if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
		expect(snapshot.session.status).toBe("running");
		expect(snapshot.events).toHaveLength(2); // perceive + session_start
	});

	test("clear command resets session state", async () => {
		await server.start();

		bus.onCommand((cmd) => {
			if (cmd.kind === "submit_goal") {
				bus.emitEvent("perceive", "root", 0, { goal: cmd.data.goal });
				bus.emitEvent("session_start", "root", 0, {});
				bus.emitEvent("plan_end", "root", 0, { text: "Done" });
				bus.emitEvent("session_end", "root", 0);
			}
			if (cmd.kind === "clear") {
				bus.emitEvent("session_clear", "session", 0, {
					new_session_id: "new-session",
				});
			}
		});

		const ws = await connectClient();
		await nextMessage(ws); // consume snapshot

		// Submit a goal
		sendCommand(ws, "submit_goal", { goal: "First task" });
		await delay(100);

		// Clear
		sendCommand(ws, "clear", {});
		await delay(100);

		// New connection should see the clear event in the buffer
		const ws2 = await connectClient();
		const snapshot = await nextMessage(ws2);
		if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
		// Buffer should contain all events including session_clear
		const kinds = snapshot.events.map((e) => e.kind);
		expect(kinds).toContain("session_clear");
	});

	test("multiple rapid commands are all delivered", async () => {
		await server.start();

		const received: Array<{ kind: string }> = [];
		bus.onCommand((cmd) => received.push({ kind: cmd.kind }));

		const ws = await connectClient();
		await nextMessage(ws); // consume snapshot

		// Fire multiple commands rapidly
		sendCommand(ws, "submit_goal", { goal: "Task 1" });
		sendCommand(ws, "steer", { text: "Adjust" });
		sendCommand(ws, "interrupt", {});
		await delay(200);

		expect(received).toHaveLength(3);
		expect(received[0]!.kind).toBe("submit_goal");
		expect(received[1]!.kind).toBe("steer");
		expect(received[2]!.kind).toBe("interrupt");
	});

	test("events emitted before client connects are in snapshot", async () => {
		await server.start();

		// Emit events before any client connects
		bus.emitEvent("perceive", "root", 0, { goal: "Pre-connect goal" });
		bus.emitEvent("session_start", "root", 0, {});
		bus.emitEvent("plan_end", "root", 0, { text: "Response" });
		bus.emitEvent("session_end", "root", 0);

		// Now connect — should receive all events in snapshot
		const ws = await connectClient();
		const snapshot = await nextMessage(ws);
		if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
		expect(snapshot.events).toHaveLength(4);
		expect(snapshot.events[0]!.kind).toBe("perceive");
		expect(snapshot.events[0]!.data.goal).toBe("Pre-connect goal");
		expect(snapshot.session.status).toBe("idle"); // session_end resets to idle
	});

	test("snapshot includes availableModels and currentModel in session", async () => {
		const staticDir2 = mkdtempSync(join(tmpdir(), "sprout-e2e-models-"));
		writeFileSync(join(staticDir2, "index.html"), "<html></html>");
		const port2 = 10000 + Math.floor(Math.random() * 50000);
		const server2 = new WebServer({
			bus,
			port: port2,
			staticDir: staticDir2,
			sessionId: "model-test",
			availableModels: ["best", "balanced", "fast", "claude-opus-4-6"],
		});
		await server2.start();

		const ws = await connect(`ws://localhost:${port2}/ws`);
		clients.push(ws);
		const snapshot = await nextMessage(ws);
		if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
		expect(snapshot.session.availableModels).toEqual([
			"best",
			"balanced",
			"fast",
			"claude-opus-4-6",
		]);
		expect(snapshot.session.currentModel).toBeNull();
		await server2.stop();
	});

	test("GET /api/models returns available models and current model", async () => {
		const staticDir2 = mkdtempSync(join(tmpdir(), "sprout-e2e-models-"));
		writeFileSync(join(staticDir2, "index.html"), "<html></html>");
		const port2 = 10000 + Math.floor(Math.random() * 50000);
		const server2 = new WebServer({
			bus,
			port: port2,
			staticDir: staticDir2,
			sessionId: "model-api-test",
			availableModels: ["best", "claude-opus-4-6"],
		});
		await server2.start();

		const resp = await fetch(`http://localhost:${port2}/api/models`);
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { models: string[]; currentModel: string | null };
		expect(body.models).toEqual(["best", "claude-opus-4-6"]);
		expect(body.currentModel).toBeNull();
		await server2.stop();
	});

	test("currentModel updates when switch_model command is received", async () => {
		const staticDir2 = mkdtempSync(join(tmpdir(), "sprout-e2e-models-"));
		writeFileSync(join(staticDir2, "index.html"), "<html></html>");
		const port2 = 10000 + Math.floor(Math.random() * 50000);
		const server2 = new WebServer({
			bus,
			port: port2,
			staticDir: staticDir2,
			sessionId: "model-switch-test",
			availableModels: ["best", "claude-opus-4-6"],
		});
		await server2.start();

		// Send switch_model command through bus
		const ws = await connect(`ws://localhost:${port2}/ws`);
		clients.push(ws);
		await nextMessage(ws); // consume snapshot

		sendCommand(ws, "switch_model", { model: "claude-opus-4-6" });
		await delay(100);

		// New connection should see updated currentModel
		const ws2 = await connect(`ws://localhost:${port2}/ws`);
		clients.push(ws2);
		const snapshot = await nextMessage(ws2);
		if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
		expect(snapshot.session.currentModel).toBe("claude-opus-4-6");

		// API should also reflect it
		const resp = await fetch(`http://localhost:${port2}/api/models`);
		const body = (await resp.json()) as { currentModel: string | null };
		expect(body.currentModel).toBe("claude-opus-4-6");

		await server2.stop();
	});

	test("command handler error does not break event streaming", async () => {
		await server.start();

		// First handler throws
		bus.onCommand(() => {
			throw new Error("handler exploded");
		});

		const ws = await connectClient();
		const messages = collectMessages(ws);
		await delay(50);

		// Send a command that will throw
		sendCommand(ws, "submit_goal", { goal: "Boom" });
		await delay(100);

		// Server should still stream events
		bus.emitEvent("plan_start", "root", 0, { turn: 1 });
		await delay(100);

		// Should have snapshot + the plan_start event
		const eventMessages = messages.filter((m) => m.type === "event");
		expect(eventMessages.length).toBeGreaterThanOrEqual(1);
		if (eventMessages[0]!.type !== "event") throw new Error("Expected event");
		expect(eventMessages[0]!.event.kind).toBe("plan_start");
	});
});
