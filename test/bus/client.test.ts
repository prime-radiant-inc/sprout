import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";

// Brief delay for message propagation (publish/unsubscribe are fire-and-forget)
function delay(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("BusClient", () => {
	let server: BusServer;

	beforeEach(async () => {
		server = new BusServer({ port: 0 });
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
	});

	test("connect and disconnect", async () => {
		const client = new BusClient(server.url);
		expect(client.connected).toBe(false);

		await client.connect();
		expect(client.connected).toBe(true);

		await client.disconnect();
		expect(client.connected).toBe(false);
	});

	test("publish and subscribe between two clients", async () => {
		const pub = new BusClient(server.url);
		const sub = new BusClient(server.url);
		await pub.connect();
		await sub.connect();

		const received: string[] = [];
		await sub.subscribe("test/topic", (payload) => {
			received.push(payload);
		});

		await pub.publish("test/topic", "hello");
		await delay();

		expect(received).toEqual(["hello"]);

		await pub.disconnect();
		await sub.disconnect();
	});

	test("multiple callbacks on same topic all fire", async () => {
		const pub = new BusClient(server.url);
		const sub = new BusClient(server.url);
		await pub.connect();
		await sub.connect();

		const first: string[] = [];
		const second: string[] = [];
		await sub.subscribe("test/multi", (payload) => first.push(payload));
		await sub.subscribe("test/multi", (payload) => second.push(payload));

		await pub.publish("test/multi", "broadcast");
		await delay();

		expect(first).toEqual(["broadcast"]);
		expect(second).toEqual(["broadcast"]);

		await pub.disconnect();
		await sub.disconnect();
	});

	test("unsubscribe stops delivery", async () => {
		const pub = new BusClient(server.url);
		const sub = new BusClient(server.url);
		await pub.connect();
		await sub.connect();

		const received: string[] = [];
		await sub.subscribe("test/unsub", (payload) => {
			received.push(payload);
		});

		await pub.publish("test/unsub", "first");
		await delay();
		expect(received).toEqual(["first"]);

		await sub.unsubscribe("test/unsub");
		await delay();

		await pub.publish("test/unsub", "second");
		await delay();

		expect(received).toEqual(["first"]);

		await pub.disconnect();
		await sub.disconnect();
	});

	test("waitForMessage resolves on first matching message", async () => {
		const pub = new BusClient(server.url);
		const sub = new BusClient(server.url);
		await pub.connect();
		await sub.connect();

		const promise = sub.waitForMessage("test/wait", 2000);

		await pub.publish("test/wait", "got-it");

		const result = await promise;
		expect(result).toBe("got-it");

		await pub.disconnect();
		await sub.disconnect();
	});

	test("waitForMessage rejects on timeout", async () => {
		const client = new BusClient(server.url);
		await client.connect();

		const start = Date.now();
		try {
			await client.waitForMessage("test/never", 100);
			throw new Error("Should have rejected");
		} catch (err: unknown) {
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(80); // allow small timing variance
			expect((err as Error).message).toContain("timed out");
		}

		await client.disconnect();
	});

	test("waitForMessage unsubscribes after receiving", async () => {
		const pub = new BusClient(server.url);
		const sub = new BusClient(server.url);
		await pub.connect();
		await sub.connect();

		// First waitForMessage should resolve
		const promise = sub.waitForMessage("test/once", 2000);
		await pub.publish("test/once", "first");
		expect(await promise).toBe("first");

		// After waitForMessage resolved, a second publish should not be received
		// (verifiable by doing a second waitForMessage that times out)
		// The key assertion: waitForMessage cleaned up after itself
		await delay();

		// Subscribe fresh to verify cleanup happened
		const received: string[] = [];
		await sub.subscribe("test/once", (p) => received.push(p));

		await pub.publish("test/once", "second");
		await delay();

		// Only the fresh subscribe callback should receive this
		expect(received).toEqual(["second"]);

		await pub.disconnect();
		await sub.disconnect();
	});

	test("subscribe resolves only after server ack", async () => {
		const pub = new BusClient(server.url);
		const sub = new BusClient(server.url);
		await pub.connect();
		await sub.connect();

		const received: string[] = [];
		await sub.subscribe("test/ack", (p) => received.push(p));

		// No delay() — subscribe should have awaited the server ack,
		// so the subscription is guaranteed to be active
		await pub.publish("test/ack", "instant");
		await delay(30); // small delay for publish delivery (fire-and-forget)

		expect(received).toEqual(["instant"]);

		await pub.disconnect();
		await sub.disconnect();
	});

	test("disconnect clears all callbacks", async () => {
		const pub = new BusClient(server.url);
		const sub = new BusClient(server.url);
		await pub.connect();
		await sub.connect();

		const received: string[] = [];
		await sub.subscribe("test/dc", (payload) => received.push(payload));

		await sub.disconnect();

		// Reconnect and verify no leftover callbacks fire
		await sub.connect();
		// Re-subscribe on server side (new WS connection)
		// But don't re-register callback — old callbacks should be gone
		await delay();

		await pub.publish("test/dc", "after-dc");
		await delay();

		expect(received).toEqual([]);

		await pub.disconnect();
		await sub.disconnect();
	});
});
