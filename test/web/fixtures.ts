import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../src/web/protocol.ts";

/** Connect a WebSocket client and wait for the connection to open. */
export function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

/** Wait for the next JSON message from a WebSocket. */
export function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<ServerMessage> {
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
export function collectMessages(ws: WebSocket): ServerMessage[] {
	const messages: ServerMessage[] = [];
	ws.addEventListener("message", (ev) => {
		messages.push(JSON.parse(ev.data as string) as ServerMessage);
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
