import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../src/host/event-bus.ts";
import { WebServer } from "../../src/web/server.ts";
import { makeSettingsSnapshot } from "../helpers/provider-settings.ts";
import { collectMessages, connect, createStaticDir, delay, nextMessage } from "./fixtures.ts";

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

// --- Test setup ---

let bus: EventBus;
let server: WebServer;
let port: number;
const clients: WebSocket[] = [];

beforeEach(async () => {
	bus = new EventBus();
	const staticDir = createStaticDir("sprout-e2e-test-", "<html><body>E2E</body></html>");
	port = 0;
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

async function startServer(): Promise<void> {
	await server.start();
	port = server.getPort();
}

/**
 * Send a command message via WebSocket (matches what the browser does).
 */
function sendCommand(ws: WebSocket, kind: string, data: Record<string, unknown>): void {
	ws.send(JSON.stringify({ type: "command", command: { kind, data } }));
}

describe("Web interface end-to-end", () => {
	test("submit_goal command triggers events that arrive back at the client", async () => {
		await startServer();

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
		await startServer();

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
		await startServer();

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
		await startServer();

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
		await startServer();

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
		expect(snapshot.session.id).toBe("new-session");
		expect(snapshot.events.map((e) => e.kind)).toEqual(["session_clear"]);
	});

	test("multiple rapid commands are all delivered", async () => {
		await startServer();

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
		await startServer();

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
		const staticDir2 = createStaticDir("sprout-e2e-models-", "<html></html>");
		const server2 = new WebServer({
			bus,
			port: 0,
			staticDir: staticDir2,
			sessionId: "model-test",
			availableModels: ["best", "balanced", "fast", "claude-opus-4-6"],
		});
		await server2.start();
		const port2 = server2.getPort();

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
		const staticDir2 = createStaticDir("sprout-e2e-models-", "<html></html>");
		const server2 = new WebServer({
			bus,
			port: 0,
			staticDir: staticDir2,
			sessionId: "model-api-test",
			availableModels: ["best", "claude-opus-4-6"],
		});
		await server2.start();
		const port2 = server2.getPort();

		const resp = await fetch(`http://localhost:${port2}/api/models`);
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { models: string[]; currentModel: string | null };
		expect(body.models).toEqual(["best", "claude-opus-4-6"]);
		expect(body.currentModel).toBeNull();
		await server2.stop();
	});

	test("currentModel updates when switch_model command is received", async () => {
		const staticDir2 = createStaticDir("sprout-e2e-models-", "<html></html>");
		const server2 = new WebServer({
			bus,
			port: 0,
			staticDir: staticDir2,
			sessionId: "model-switch-test",
			availableModels: ["best", "claude-opus-4-6"],
		});
		await server2.start();
		const port2 = server2.getPort();

		// Send switch_model command through bus
		const ws = await connect(`ws://localhost:${port2}/ws`);
		clients.push(ws);
		await nextMessage(ws); // consume snapshot

		sendCommand(ws, "switch_model", {
			selection: { kind: "unqualified_model", modelId: "claude-opus-4-6" },
		});
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

	test("settings commands return results and live updates through the same websocket", async () => {
		const staticDir2 = createStaticDir("sprout-e2e-settings-", "<html></html>");
		const received: Array<{ kind: string; data: Record<string, unknown> }> = [];
		let snapshot = structuredClone(makeSettingsSnapshot());
		const server2 = new WebServer({
			bus,
			port: 0,
			staticDir: staticDir2,
			sessionId: "settings-test",
			settingsControlPlane: {
				execute: async (command) => {
					received.push(command);
					if (command.kind === "set_provider_enabled") {
						const providerId = command.data.providerId;
						const enabled = command.data.enabled;
						snapshot = {
							...snapshot,
							settings: {
								...snapshot.settings,
								providers: snapshot.settings.providers.map((provider) =>
									provider.id === providerId ? { ...provider, enabled } : provider,
								),
							},
						};
					}
					return { ok: true as const, snapshot };
				},
			},
		});
		await server2.start();
		const port2 = server2.getPort();

		const ws = await connect(`ws://localhost:${port2}/ws`);
		clients.push(ws);
		const messages = collectMessages(ws);
		await nextMessage(ws);

		sendCommand(ws, "set_provider_enabled", {
			providerId: "anthropic-main",
			enabled: false,
		});
		await delay(100);

		expect(received.map((command) => command.kind)).toEqual([
			"get_settings",
			"set_provider_enabled",
		]);
		expect(received[1]).toEqual({
			kind: "set_provider_enabled",
			data: {
				providerId: "anthropic-main",
				enabled: false,
			},
		});
		const settingsResult = messages.find((message) => message.type === "settings_result");
		expect(settingsResult).toEqual({
			type: "settings_result",
			result: {
				ok: true,
				snapshot,
			},
		});
		const settingsUpdated = messages.find((message) => message.type === "settings_updated");
		expect(settingsUpdated).toEqual({
			type: "settings_updated",
			snapshot,
		});

		await server2.stop();
	});

	test("command handler error does not break event streaming", async () => {
		await startServer();

		// First handler throws
		bus.onCommand(() => {
			throw new Error("handler exploded");
		});

		const logged: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => logged.push(args);
		try {
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

			expect(logged.length).toBeGreaterThanOrEqual(1);
			const logLine = logged.flat().map(String).join(" ");
			expect(logLine).toContain("handler exploded");
		} finally {
			console.error = origError;
		}
	});

	test("token-protected websocket rejects missing token and accepts valid token", async () => {
		const staticDir2 = createStaticDir("sprout-e2e-auth-", "<html></html>");
		const server2 = new WebServer({
			bus,
			port: 0,
			staticDir: staticDir2,
			sessionId: "auth-test",
			webToken: "secret-token",
		});
		await server2.start();
		const port2 = server2.getPort();

		const unauthorized = await fetch(`http://localhost:${port2}/`, {
			headers: {
				upgrade: "websocket",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
				"sec-websocket-version": "13",
				connection: "upgrade",
			},
		});
		expect(unauthorized.status).toBe(401);

		const received: Array<{ kind: string }> = [];
		bus.onCommand((cmd) => received.push({ kind: cmd.kind }));

		const ws = await connect(`ws://localhost:${port2}/ws?token=secret-token`);
		clients.push(ws);
		await nextMessage(ws); // snapshot
		sendCommand(ws, "interrupt", {});
		await delay(100);
		expect(received.map((r) => r.kind)).toContain("interrupt");

		await server2.stop();
	});
});
