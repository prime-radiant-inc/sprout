import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusServer } from "../../src/bus/server.ts";

// Helper: connect a WebSocket client to the bus server and wait for open
function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(e);
	});
}

// Helper: wait for next message on a WebSocket
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
		ws.addEventListener(
			"message",
			(ev) => {
				clearTimeout(timer);
				resolve(JSON.parse(ev.data as string));
			},
			{ once: true },
		);
	});
}

// Helper: collect messages on a WebSocket into an array
function collectMessages(ws: WebSocket): unknown[] {
	const messages: unknown[] = [];
	ws.addEventListener("message", (ev) => {
		messages.push(JSON.parse(ev.data as string));
	});
	return messages;
}

// Helper: send a wire-protocol message
function send(ws: WebSocket, msg: Record<string, unknown>): void {
	ws.send(JSON.stringify(msg));
}

// Helper: brief delay for message propagation
function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("BusServer", () => {
	let server: BusServer;

	beforeEach(async () => {
		server = new BusServer({ port: 0 });
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
	});

	test("starts and accepts WebSocket connections", async () => {
		const ws = await connect(server.url);
		expect(ws.readyState).toBe(WebSocket.OPEN);
		ws.close();
	});

	test("published messages route to subscribers", async () => {
		const sub = await connect(server.url);
		const pub = await connect(server.url);

		send(sub, { action: "subscribe", topic: "test/topic" });
		await delay();

		send(pub, {
			action: "publish",
			topic: "test/topic",
			payload: "hello",
		});

		const msg = await nextMessage(sub);
		expect(msg).toEqual({ topic: "test/topic", payload: "hello" });

		sub.close();
		pub.close();
	});

	test("messages do not reach non-subscribers", async () => {
		const sub = await connect(server.url);
		const nonSub = await connect(server.url);
		const pub = await connect(server.url);

		const nonSubMessages = collectMessages(nonSub);

		send(sub, { action: "subscribe", topic: "test/topic" });
		await delay();

		send(pub, {
			action: "publish",
			topic: "test/topic",
			payload: "secret",
		});

		// Wait for the subscriber to get the message (proves delivery happened)
		await nextMessage(sub);
		// Give non-subscriber time to NOT receive it
		await delay();

		expect(nonSubMessages).toHaveLength(0);

		sub.close();
		nonSub.close();
		pub.close();
	});

	test("publisher does not receive its own messages", async () => {
		const pubSub = await connect(server.url);

		const received = collectMessages(pubSub);

		send(pubSub, { action: "subscribe", topic: "test/echo" });
		await delay();

		send(pubSub, {
			action: "publish",
			topic: "test/echo",
			payload: "ping",
		});
		await delay(100);

		expect(received).toHaveLength(0);

		pubSub.close();
	});

	test("unsubscribe stops delivery", async () => {
		const sub = await connect(server.url);
		const pub = await connect(server.url);

		const received = collectMessages(sub);

		send(sub, { action: "subscribe", topic: "test/unsub" });
		await delay();

		send(pub, {
			action: "publish",
			topic: "test/unsub",
			payload: "first",
		});
		await nextMessage(sub);
		expect(received).toHaveLength(1);

		send(sub, { action: "unsubscribe", topic: "test/unsub" });
		await delay();

		send(pub, {
			action: "publish",
			topic: "test/unsub",
			payload: "second",
		});
		await delay(100);

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({
			topic: "test/unsub",
			payload: "first",
		});

		sub.close();
		pub.close();
	});

	test("cleanup on disconnect removes subscriptions", async () => {
		const sub = await connect(server.url);
		const pub = await connect(server.url);
		const observer = await connect(server.url);

		send(sub, { action: "subscribe", topic: "test/dc" });
		send(observer, { action: "subscribe", topic: "test/dc" });
		await delay();

		// Disconnect the first subscriber
		sub.close();
		await delay(100);

		// Publish — should only reach observer, not crash
		send(pub, {
			action: "publish",
			topic: "test/dc",
			payload: "after-dc",
		});

		const msg = await nextMessage(observer);
		expect(msg).toEqual({ topic: "test/dc", payload: "after-dc" });

		observer.close();
		pub.close();
	});

	test("multiple topics are independent", async () => {
		const subA = await connect(server.url);
		const subB = await connect(server.url);
		const pub = await connect(server.url);

		const messagesA = collectMessages(subA);
		const messagesB = collectMessages(subB);

		send(subA, { action: "subscribe", topic: "topic/a" });
		send(subB, { action: "subscribe", topic: "topic/b" });
		await delay();

		send(pub, { action: "publish", topic: "topic/a", payload: "for-a" });
		send(pub, { action: "publish", topic: "topic/b", payload: "for-b" });
		await delay(100);

		expect(messagesA).toEqual([{ topic: "topic/a", payload: "for-a" }]);
		expect(messagesB).toEqual([{ topic: "topic/b", payload: "for-b" }]);

		subA.close();
		subB.close();
		pub.close();
	});

	test("multiple subscribers on same topic all receive messages", async () => {
		const sub1 = await connect(server.url);
		const sub2 = await connect(server.url);
		const pub = await connect(server.url);

		send(sub1, { action: "subscribe", topic: "test/multi" });
		send(sub2, { action: "subscribe", topic: "test/multi" });
		await delay();

		send(pub, {
			action: "publish",
			topic: "test/multi",
			payload: "broadcast",
		});

		const msg1 = await nextMessage(sub1);
		const msg2 = await nextMessage(sub2);

		expect(msg1).toEqual({ topic: "test/multi", payload: "broadcast" });
		expect(msg2).toEqual({ topic: "test/multi", payload: "broadcast" });

		sub1.close();
		sub2.close();
		pub.close();
	});

	test("ignores malformed messages without crashing", async () => {
		const ws = await connect(server.url);

		// Send garbage — server should not crash
		ws.send("not valid json");
		ws.send(JSON.stringify({ action: "unknown" }));
		ws.send(JSON.stringify({ action: "subscribe" })); // missing topic
		ws.send(JSON.stringify({ action: "publish", topic: "t" })); // missing payload

		await delay(100);

		// Server still works — connect another client
		const ws2 = await connect(server.url);
		expect(ws2.readyState).toBe(WebSocket.OPEN);

		ws.close();
		ws2.close();
	});

	test("url returns a connectable WebSocket URL", () => {
		expect(server.url).toMatch(/^ws:\/\/localhost:\d+$/);
	});
});
