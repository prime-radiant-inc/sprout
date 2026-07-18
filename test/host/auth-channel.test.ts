import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	AuthChannelClient,
	AuthChannelServer,
	HANDLE_HEADER,
	TOKEN_HEADER,
} from "../../src/host/auth-channel.ts";
import { HandleRegistry, hashToken, mintToken } from "../../src/host/handle-registry.ts";

const HANDLE_ID = "h-child";
const OWNER_ID = "h-parent";
const DEPTH = 2;

let registry: HandleRegistry;
let server: AuthChannelServer;
let token: string;

beforeEach(async () => {
	registry = new HandleRegistry();
	token = mintToken();
	const registered = registry.registerHandle({
		handleId: HANDLE_ID,
		tokenHash: hashToken(token),
		registrarId: OWNER_ID,
		ownerId: OWNER_ID,
		depth: DEPTH,
	});
	expect(registered).toEqual({ ok: true });
	server = new AuthChannelServer({ port: 0, registry });
	await server.start();
});

afterEach(async () => {
	await server.stop();
});

function makeClient(overrides: { handleId?: string; token?: string } = {}): AuthChannelClient {
	return new AuthChannelClient({
		url: server.url,
		handleId: overrides.handleId ?? HANDLE_ID,
		token: overrides.token ?? token,
	});
}

// Helper: poll until a condition holds. Used where the observable is registry
// state flipped by the server's async close event — there is no client-side
// event to await for "the server noticed".
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// Helper: raw authenticated WebSocket for wire-level tests below the client API
function rawConnect(handleId: string, rawToken: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(server.url, {
			headers: { [HANDLE_HEADER]: handleId, [TOKEN_HEADER]: rawToken },
		});
		ws.onopen = () => resolve(ws);
		ws.onerror = () => reject(new Error("raw connect refused"));
	});
}

// Helper: wait for the next JSON message on a raw WebSocket
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

describe("AuthChannelServer handshake", () => {
	test("authenticates a registered handle and marks it live", async () => {
		const client = makeClient();
		await client.connect();

		expect(client.connected).toBe(true);
		expect(registry.isLive(HANDLE_ID)).toBe(true);

		await client.disconnect();
	});

	test("rejects a wrong token without marking the handle live", async () => {
		const client = makeClient({ token: mintToken() });

		await expect(client.connect()).rejects.toThrow(/handshake/);
		expect(client.connected).toBe(false);
		expect(registry.isLive(HANDLE_ID)).toBe(false);

		// The failed attempt burns nothing: the real token still connects.
		const good = makeClient();
		await good.connect();
		expect(registry.isLive(HANDLE_ID)).toBe(true);
		await good.disconnect();
	});

	test("rejects an unknown handle", async () => {
		const client = makeClient({ handleId: "h-ghost" });

		await expect(client.connect()).rejects.toThrow(/handshake/);
		expect(client.connected).toBe(false);
	});

	test("rejects a connection presenting no credentials", async () => {
		const outcome = await new Promise<string>((resolve) => {
			const ws = new WebSocket(server.url);
			ws.onopen = () => resolve("open");
			ws.onerror = () => resolve("refused");
		});

		expect(outcome).toBe("refused");
		expect(registry.isLive(HANDLE_ID)).toBe(false);
	});

	test("rejects a second connection while the handle is live, keeping the first", async () => {
		server.onRequest("ping", () => "pong");
		const first = makeClient();
		await first.connect();

		const second = makeClient();
		await expect(second.connect()).rejects.toThrow(/handshake/);

		// The live connection is unaffected by the rejected duplicate.
		expect(await first.request("ping")).toBe("pong");
		expect(registry.isLive(HANDLE_ID)).toBe(true);

		await first.disconnect();
	});

	test("rolls back liveness when an authenticated request is not a WebSocket upgrade", async () => {
		const res = await fetch(server.url.replace("ws://", "http://"), {
			headers: { [HANDLE_HEADER]: HANDLE_ID, [TOKEN_HEADER]: token },
		});

		expect(res.status).toBe(426);
		expect(registry.isLive(HANDLE_ID)).toBe(false);

		// The handle is not burned: a real WebSocket connection still works.
		const client = makeClient();
		await client.connect();
		await client.disconnect();
	});

	test("url and port getters mirror BusServer", () => {
		expect(server.url).toMatch(/^ws:\/\/localhost:\d+$/);
		expect(server.port).toBeGreaterThan(0);

		const unstarted = new AuthChannelServer({ port: 0, registry });
		expect(() => unstarted.url).toThrow("not started");
		expect(() => unstarted.port).toThrow("not started");
	});
});

describe("AuthChannelServer requests", () => {
	test("round-trips a request and hands the handler the connection's verified identity", async () => {
		server.onRequest("whoami", (ctx, payload) => ({
			handleId: ctx.handleId,
			ownerId: ctx.ownerId,
			depth: ctx.depth,
			echoed: payload,
		}));
		const client = makeClient();
		await client.connect();

		const result = await client.request("whoami", { hello: "sap" });

		expect(result).toEqual({
			handleId: HANDLE_ID,
			ownerId: OWNER_ID,
			depth: DEPTH,
			echoed: { hello: "sap" },
		});

		await client.disconnect();
	});

	test("identity comes from the connection, never from the message payload", async () => {
		server.onRequest("whoami", (ctx) => ({
			handleId: ctx.handleId,
			ownerId: ctx.ownerId,
			depth: ctx.depth,
		}));
		const client = makeClient();
		await client.connect();

		// A malicious payload claims to be someone else; the handler must see
		// the verified identity bound at the handshake, not these claims.
		const result = await client.request("whoami", {
			handleId: "h-victim",
			ownerId: "h-evil",
			depth: 0,
			identity: { handleId: "h-victim", ownerId: "h-evil" },
		});

		expect(result).toEqual({ handleId: HANDLE_ID, ownerId: OWNER_ID, depth: DEPTH });

		await client.disconnect();
	});

	test("concurrent requests correlate by id, not completion order", async () => {
		server.onRequest("delayed-echo", async (_ctx, payload) => {
			const { value, delayMs } = payload as { value: number; delayMs: number };
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return value * 10;
		});
		const client = makeClient();
		await client.connect();

		// Delays are inverse to send order, so responses arrive out of order.
		const results = await Promise.all([
			client.request("delayed-echo", { value: 1, delayMs: 30 }),
			client.request("delayed-echo", { value: 2, delayMs: 15 }),
			client.request("delayed-echo", { value: 3, delayMs: 0 }),
		]);

		expect(results).toEqual([10, 20, 30]);

		await client.disconnect();
	});

	test("a handler that throws rejects the request with the error message", async () => {
		server.onRequest("explode", () => {
			throw new Error("boom: store full");
		});
		const client = makeClient();
		await client.connect();

		await expect(client.request("explode")).rejects.toThrow("boom: store full");

		await client.disconnect();
	});

	test("an unknown request type rejects", async () => {
		const client = makeClient();
		await client.connect();

		await expect(client.request("no-such-op")).rejects.toThrow(/unknown request type/);

		await client.disconnect();
	});

	test("an infrastructure-tagged error keeps its tag across the channel", async () => {
		const { StoreUnavailableError } = await import("../../src/store/store-client.ts");
		server.onRequest("infra_down", () => {
			throw new StoreUnavailableError("store worker unavailable: restarts exhausted");
		});
		const client = makeClient();
		await client.connect();

		let caught: unknown;
		try {
			await client.request("infra_down");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("restarts exhausted");
		expect((caught as { infrastructure?: boolean }).infrastructure).toBe(true);

		await client.disconnect();
	});

	test("a plain error crosses the channel without an infrastructure tag", async () => {
		server.onRequest("plain_fail", () => {
			throw new Error("ordinary failure");
		});
		const client = makeClient();
		await client.connect();

		let caught: unknown;
		try {
			await client.request("plain_fail");
		} catch (err) {
			caught = err;
		}
		expect((caught as Error).message).toBe("ordinary failure");
		expect((caught as { infrastructure?: boolean }).infrastructure).toBeUndefined();

		await client.disconnect();
	});

	test("requesting while disconnected rejects", async () => {
		const client = makeClient();

		await expect(client.request("ping")).rejects.toThrow(/not connected/);
	});

	test("ignores malformed frames and keeps serving the connection", async () => {
		server.onRequest("ping", () => "pong");
		const ws = await rawConnect(HANDLE_ID, token);

		ws.send("not valid json");
		ws.send(JSON.stringify({ type: "ping" })); // missing id
		ws.send(JSON.stringify({ id: 42, type: "ping" })); // non-string id
		ws.send(JSON.stringify({ id: "r-good", type: "ping" }));

		// Only the well-formed envelope gets a reply, on the same connection.
		const reply = await nextMessage(ws);
		expect(reply).toEqual({ id: "r-good", ok: true, result: "pong" });

		ws.close();
	});
});

describe("AuthChannelServer push", () => {
	test("push delivers to the connected handle's onPush handler", async () => {
		const client = makeClient();
		await client.connect();

		const received = new Promise<unknown>((resolve) => {
			client.onPush("note", resolve);
		});

		expect(server.push(HANDLE_ID, "note", { n: 1 })).toBe(true);
		expect(await received).toEqual({ n: 1 });

		await client.disconnect();
	});

	test("push to a handle with no live connection returns false", async () => {
		expect(server.push("h-ghost", "note", {})).toBe(false);

		const client = makeClient();
		await client.connect();
		await client.disconnect();
		await waitFor(() => !registry.isLive(HANDLE_ID));

		expect(server.push(HANDLE_ID, "note", {})).toBe(false);
	});
});

describe("AuthChannel lifecycle", () => {
	test("client disconnect clears liveness so the same token reconnects", async () => {
		server.onRequest("ping", () => "pong");
		const client = makeClient();
		await client.connect();
		expect(registry.isLive(HANDLE_ID)).toBe(true);

		await client.disconnect();
		await waitFor(() => !registry.isLive(HANDLE_ID));

		const reconnected = makeClient();
		await reconnected.connect();
		expect(registry.isLive(HANDLE_ID)).toBe(true);
		expect(await reconnected.request("ping")).toBe("pong");

		await reconnected.disconnect();
	});

	test("client disconnect rejects pending requests", async () => {
		server.onRequest("hang", () => new Promise(() => {}));
		const client = makeClient();
		await client.connect();

		const pending = client.request("hang");
		await client.disconnect();

		await expect(pending).rejects.toThrow(/disconnected/);
	});

	test("server stop clears liveness and drops connected clients", async () => {
		server.onRequest("hang", () => new Promise(() => {}));
		const client = makeClient();
		await client.connect();

		const pending = client.request("hang");
		await server.stop();

		expect(registry.isLive(HANDLE_ID)).toBe(false);
		await expect(pending).rejects.toThrow(/disconnected/);
		await waitFor(() => !client.connected);
	});
});
