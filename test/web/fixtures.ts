import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../src/web/protocol.ts";

interface WebSocketFixtureState {
	queue: ServerMessage[];
	listeners: Set<(message: ServerMessage) => void>;
}

const wsState = new WeakMap<WebSocket, WebSocketFixtureState>();

/** Connect a WebSocket client and wait for the connection to open. */
export function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const state: WebSocketFixtureState = {
			queue: [],
			listeners: new Set(),
		};
		wsState.set(ws, state);
		ws.addEventListener("message", (ev) => {
			const message = JSON.parse(ev.data as string) as ServerMessage;
			state.queue.push(message);
			for (const listener of state.listeners) {
				listener(message);
			}
		});
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

/** Wait for the next JSON message from a WebSocket. */
export function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<ServerMessage> {
	const state = wsState.get(ws);
	if (!state) {
		return Promise.reject(new Error("WebSocket state not initialized"));
	}
	if (state.queue.length > 0) {
		return Promise.resolve(state.queue.shift()!);
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
		const listener = (message: ServerMessage) => {
			clearTimeout(timer);
			state.listeners.delete(listener);
			state.queue.shift();
			resolve(message);
		};
		state.listeners.add(listener);
	});
}

/** Collect all JSON messages arriving on a WebSocket into an array. */
export function collectMessages(ws: WebSocket): ServerMessage[] {
	const state = wsState.get(ws);
	const messages: ServerMessage[] = [...(state?.queue ?? [])];
	state?.listeners.add((message) => {
		messages.push(message);
	});
	return messages;
}

/** Brief delay for message propagation. */
export function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a WebSocket to fully close. */
export function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
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

/** Create a temp static dir with an index file and return its path. */
export function createStaticDir(prefix: string, indexHtml: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	writeFileSync(join(dir, "index.html"), indexHtml);
	return dir;
}
