import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthChannelClient, AuthChannelServer } from "../../src/host/auth-channel.ts";
import {
	ChannelHandleRegistrar,
	HostHandleRegistrar,
	makeRegisterHandleHandler,
	REGISTER_HANDLE_REQUEST,
} from "../../src/host/handle-registrar.ts";
import {
	HandleRegistry,
	hashToken,
	mintToken,
	type ObserverRemit,
} from "../../src/host/handle-registry.ts";

const TRUSTED = "host";

describe("HostHandleRegistrar (in-process trusted path)", () => {
	test("registers a child; the child then authenticates with its token", async () => {
		const registry = new HandleRegistry({ trustedRegistrarId: TRUSTED });
		const registrar = new HostHandleRegistrar(registry, TRUSTED);
		const token = mintToken();

		await registrar.registerChild({
			handleId: "h-child",
			tokenHash: hashToken(token),
			ownerId: "h-root",
			depth: 1,
		});

		// Round-trips through the real registry: the minted token authenticates.
		const auth = registry.authenticate("h-child", token);
		expect(auth.ok).toBe(true);
		if (auth.ok) {
			expect(auth.identity).toEqual({ ownerId: "h-root", depth: 1, live: true });
		}
	});

	test("rejects a failed registration with an Error naming the reason", async () => {
		const registry = new HandleRegistry({ trustedRegistrarId: TRUSTED });
		const registrar = new HostHandleRegistrar(registry, TRUSTED);

		await registrar.registerChild({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			ownerId: "h-a",
			depth: 1,
		});

		// Same handle id, different owner → registry rejects as duplicate, which
		// must surface as a rejected promise carrying the reason.
		await expect(
			registrar.registerChild({
				handleId: "h-child",
				tokenHash: hashToken(mintToken()),
				ownerId: "h-b",
				depth: 1,
			}),
		).rejects.toThrow(/handle registration failed: duplicate/);
	});
});

describe("makeRegisterHandleHandler + ChannelHandleRegistrar (real channel)", () => {
	const PARENT = "h-parent";

	let registry: HandleRegistry;
	let server: AuthChannelServer;
	let parentClient: AuthChannelClient;
	let parentToken: string;

	beforeEach(async () => {
		registry = new HandleRegistry({ trustedRegistrarId: TRUSTED });
		parentToken = mintToken();
		// The parent is root's direct child — registered by the host trusted path.
		registry.registerHandle({
			handleId: PARENT,
			tokenHash: hashToken(parentToken),
			registrarId: TRUSTED,
			ownerId: "h-root",
			depth: 1,
		});
		server = new AuthChannelServer({ port: 0, registry });
		server.onRequest(REGISTER_HANDLE_REQUEST, makeRegisterHandleHandler(registry));
		await server.start();
		parentClient = new AuthChannelClient({ url: server.url, handleId: PARENT, token: parentToken });
		await parentClient.connect();
	});

	afterEach(async () => {
		await parentClient.disconnect();
		await server.stop();
	});

	test("parent registers a grandchild; the grandchild can then authenticate", async () => {
		const gcToken = mintToken();
		const registrar = new ChannelHandleRegistrar(parentClient);

		await registrar.registerChild({
			handleId: "h-grandchild",
			tokenHash: hashToken(gcToken),
			ownerId: PARENT,
			depth: 2,
		});

		// The grandchild's own process connects with its token over the real channel.
		const gcClient = new AuthChannelClient({
			url: server.url,
			handleId: "h-grandchild",
			token: gcToken,
		});
		await gcClient.connect();
		expect(gcClient.connected).toBe(true);
		expect(registry.isLive("h-grandchild")).toBe(true);

		await gcClient.disconnect();
	});

	test("carries an observer remit through the wire", async () => {
		const registrar = new ChannelHandleRegistrar(parentClient);
		const remit: ObserverRemit = { kind: "delegate", ownerId: PARENT };

		await registrar.registerChild({
			handleId: "h-observer",
			tokenHash: hashToken(mintToken()),
			ownerId: PARENT,
			depth: 2,
			observerRemit: remit,
		});

		expect(registry.get("h-observer")).toEqual({
			ownerId: PARENT,
			depth: 2,
			observerRemit: { kind: "delegate", ownerId: PARENT },
			live: false,
		});
	});

	test("keystone: registering a child owned by another handle is rejected as not_parent", async () => {
		const registrar = new ChannelHandleRegistrar(parentClient);

		await expect(
			registrar.registerChild({
				handleId: "h-captured",
				tokenHash: hashToken(mintToken()),
				ownerId: "h-victim", // the parent does not own this handle
				depth: 2,
			}),
		).rejects.toThrow(/not_parent/);

		expect(registry.get("h-captured")).toBeUndefined();
	});

	test("keystone: the handler derives registrarId from the connection, ignoring a crafted payload registrarId", async () => {
		// The crafted payload sets registrarId === ownerId so that IF the handler
		// trusted the payload's registrarId, the registry's not_parent check would
		// pass and this connection would capture an identity it does not own. The
		// handler must instead use the connection's verified id (h-parent), so the
		// registry sees registrarId=h-parent ≠ ownerId=h-victim and rejects.
		await expect(
			parentClient.request(REGISTER_HANDLE_REQUEST, {
				handleId: "h-captured",
				tokenHash: hashToken(mintToken()),
				ownerId: "h-victim",
				depth: 2,
				registrarId: "h-victim",
			}),
		).rejects.toThrow(/not_parent/);

		expect(registry.get("h-captured")).toBeUndefined();
	});

	test("a duplicate registration surfaces the registry reason as a rejected promise", async () => {
		// The host trusted path pre-registers a colliding handle id owned by a
		// different subtree. The parent owns the id it claims (passes not_parent),
		// but the existing record belongs to another owner → duplicate.
		registry.registerHandle({
			handleId: "h-collision",
			tokenHash: hashToken(mintToken()),
			registrarId: TRUSTED,
			ownerId: "h-elsewhere",
			depth: 1,
		});
		const registrar = new ChannelHandleRegistrar(parentClient);

		await expect(
			registrar.registerChild({
				handleId: "h-collision",
				tokenHash: hashToken(mintToken()),
				ownerId: PARENT,
				depth: 2,
			}),
		).rejects.toThrow(/handle registration failed: duplicate/);
	});

	test("rejects a malformed payload with a clear error", async () => {
		// Missing handleId.
		await expect(
			parentClient.request(REGISTER_HANDLE_REQUEST, {
				tokenHash: hashToken(mintToken()),
				ownerId: PARENT,
				depth: 2,
			}),
		).rejects.toThrow(/handleId/);

		// depth is a string, not a number.
		await expect(
			parentClient.request(REGISTER_HANDLE_REQUEST, {
				handleId: "h-bad",
				tokenHash: hashToken(mintToken()),
				ownerId: PARENT,
				depth: "2",
			}),
		).rejects.toThrow(/depth/);

		// payload is not an object at all.
		await expect(parentClient.request(REGISTER_HANDLE_REQUEST, 42)).rejects.toThrow(/object/);

		// No malformed attempt registered anything.
		expect(registry.get("h-bad")).toBeUndefined();
	});
});
