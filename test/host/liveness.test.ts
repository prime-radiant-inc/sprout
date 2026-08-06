import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthChannelClient, AuthChannelServer } from "../../src/host/auth-channel.ts";
import { HandleRegistry, hashToken, mintToken } from "../../src/host/handle-registry.ts";
import {
	ChannelLivenessProbe,
	HostLivenessProbe,
	LIVENESS_REQUEST,
	LivenessReporter,
	makeLivenessHandler,
	makePingHandler,
	PING_REQUEST,
} from "../../src/host/liveness.ts";
import { waitFor } from "../helpers/wait-for.ts";

describe("HandleRegistry ping tracking", () => {
	test("msSincePing is null for unknown or never-pinged handles", () => {
		const registry = new HandleRegistry();
		expect(registry.msSincePing("h-ghost", 1000)).toBeNull();

		registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			registrarId: "h-parent",
			ownerId: "h-parent",
			depth: 1,
		});
		expect(registry.msSincePing("h-child", 1000)).toBeNull();
	});

	test("recordPing timestamps the handle; msSincePing measures from it", () => {
		const registry = new HandleRegistry();
		registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			registrarId: "h-parent",
			ownerId: "h-parent",
			depth: 1,
		});

		registry.recordPing("h-child", 1000);
		expect(registry.msSincePing("h-child", 1600)).toBe(600);

		registry.recordPing("h-child", 2000);
		expect(registry.msSincePing("h-child", 2100)).toBe(100);
	});

	test("recordPing on an unknown handle is ignored", () => {
		const registry = new HandleRegistry();
		registry.recordPing("h-ghost", 1000);
		expect(registry.msSincePing("h-ghost", 2000)).toBeNull();
	});
});

describe("ping and liveness handlers", () => {
	test("ping handler records for the connection's verified identity only", async () => {
		const registry = new HandleRegistry();
		registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			registrarId: "h-parent",
			ownerId: "h-parent",
			depth: 1,
		});
		const handler = makePingHandler(registry, () => 5000);

		await handler(
			{ handleId: "h-child", ownerId: "h-parent", depth: 1, live: true },
			// A crafted payload naming another handle must be ignored.
			{ handleId: "h-other" },
		);

		expect(registry.msSincePing("h-child", 5600)).toBe(600);
		expect(registry.msSincePing("h-other", 5600)).toBeNull();
	});

	test("liveness handler reports msSincePing for the queried handle", async () => {
		const registry = new HandleRegistry();
		registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			registrarId: "h-parent",
			ownerId: "h-parent",
			depth: 1,
		});
		registry.recordPing("h-child", 1000);
		const handler = makeLivenessHandler(registry, () => 1400);

		const result = await handler(
			{ handleId: "h-parent", ownerId: "root", depth: 0, live: true },
			{ handleId: "h-child" },
		);
		expect(result).toEqual({ msSincePing: 400 });

		const unknown = await handler(
			{ handleId: "h-parent", ownerId: "root", depth: 0, live: true },
			{ handleId: "h-ghost" },
		);
		expect(unknown).toEqual({ msSincePing: null });
	});

	test("liveness handler rejects a malformed payload", async () => {
		const registry = new HandleRegistry();
		const handler = makeLivenessHandler(registry, () => 0);
		expect(() =>
			handler({ handleId: "h-parent", ownerId: "root", depth: 0, live: true }, { nope: true }),
		).toThrow("handleId");
	});
});

describe("LivenessReporter + probes over a real channel", () => {
	let registry: HandleRegistry;
	let server: AuthChannelServer;
	let client: AuthChannelClient;
	let reporter: LivenessReporter | undefined;

	beforeEach(async () => {
		registry = new HandleRegistry({ trustedRegistrarId: "sprout:host" });
		server = new AuthChannelServer({ port: 0, hostname: "127.0.0.1", registry });
		await server.start();
		server.onRequest(PING_REQUEST, makePingHandler(registry));
		server.onRequest(LIVENESS_REQUEST, makeLivenessHandler(registry));

		const token = mintToken();
		registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(token),
			registrarId: "sprout:host",
			ownerId: "root",
			depth: 1,
		});
		client = new AuthChannelClient({ url: server.url, handleId: "h-child", token });
		await client.connect();
	});

	afterEach(async () => {
		reporter?.stop();
		await client.disconnect();
		await server.stop();
	});

	test("reporter pings on start and keeps pinging on its interval", async () => {
		expect(registry.msSincePing("h-child", Date.now())).toBeNull();

		reporter = new LivenessReporter({ client, intervalMs: 25 });
		reporter.start();

		await waitFor(() => registry.msSincePing("h-child", Date.now()) !== null);
		const first = registry.lastPingAt("h-child");
		await waitFor(() => registry.lastPingAt("h-child") !== first);

		reporter.stop();
		const afterStop = registry.lastPingAt("h-child");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(registry.lastPingAt("h-child")).toBe(afterStop);
	});

	test("host probe reads the registry directly; channel probe asks over the wire", async () => {
		registry.recordPing("h-child", Date.now() - 500);

		const hostProbe = new HostLivenessProbe(registry);
		const hostMs = await hostProbe.msSincePing("h-child");
		expect(hostMs).not.toBeNull();
		expect(hostMs!).toBeGreaterThanOrEqual(500);

		const channelProbe = new ChannelLivenessProbe(client);
		const wireMs = await channelProbe.msSincePing("h-child");
		expect(wireMs).not.toBeNull();
		expect(wireMs!).toBeGreaterThanOrEqual(500);

		expect(await hostProbe.msSincePing("h-ghost")).toBeNull();
		expect(await channelProbe.msSincePing("h-ghost")).toBeNull();
	});
});
