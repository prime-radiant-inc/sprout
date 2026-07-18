import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthChannelClient, AuthChannelServer } from "../../src/host/auth-channel";
import { HandleRegistry, hashToken, mintToken } from "../../src/host/handle-registry";
import { registerStoreHandlers } from "../../src/host/store-channel";
import { ContentStore } from "../../src/store/cas";
import { SessionJournal } from "../../src/store/journal";
import { SapStore } from "../../src/store/store";
import {
	ChannelStoreAccess,
	DirectStoreAccess,
	type StoreAccess,
} from "../../src/store/store-access";
import { StoreWorkerClient, type StoreWorkerHandle } from "../../src/store/store-client";
import { runStoreWorker } from "../../src/store/store-worker";
import type { ValueProvenance } from "../../src/store/value";

const ROOT_SCOPE = "root";
const TRUSTED = "sprout:host";

const prov = (agentHandleId: string): ValueProvenance => ({
	agentHandleId,
	origin: { kind: "cell" },
});

describe("store access", () => {
	let dir: string;
	let journal: SessionJournal;
	let cas: ContentStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sap-store-access-"));
		journal = new SessionJournal(join(dir, "journal.jsonl"));
		cas = new ContentStore(join(dir, "cas"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** In-process fake worker: a fresh SapStore.resume per spawn, like a restart. */
	function workingSpawn(): () => StoreWorkerHandle {
		return () => {
			let lineHandler: (line: string) => void = () => {};
			const storeReady = SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			let queue = Promise.resolve();
			return {
				send(line) {
					queue = queue.then(async () => {
						const store = await storeReady;
						const responses: string[] = [];
						async function* one(): AsyncGenerator<string> {
							yield line;
						}
						await runStoreWorker({ lines: one(), write: (l) => responses.push(l), store });
						for (const r of responses) lineHandler(r);
					});
				},
				kill() {},
				onLine(cb) {
					lineHandler = cb;
				},
				onExit() {},
			};
		};
	}

	function makeClient(): StoreWorkerClient {
		return new StoreWorkerClient({
			journalPath: join(dir, "journal.jsonl"),
			casRoot: join(dir, "cas"),
			rootScopeId: ROOT_SCOPE,
			opTimeoutMs: 1_000,
			spawnFn: workingSpawn(),
		});
	}

	describe("DirectStoreAccess", () => {
		it("roundtrips bind/peek/metadata/get/slice/grep with its fixed scope", async () => {
			const client = makeClient();
			const access: StoreAccess = new DirectStoreAccess(client, ROOT_SCOPE);
			const meta = await access.bind({
				name: "notes",
				content: "hello\nworld",
				type: "text",
				provenance: prov("root"),
				explicit: true,
			});
			expect(meta.name).toBe("notes");
			expect(meta.scopeId).toBe(ROOT_SCOPE);
			expect(await access.peek("notes")).toContain("text · 11 bytes");
			expect((await access.metadata("notes")).size).toBe(11);
			expect(new TextDecoder().decode(await access.get("notes", { maxBytes: 100 }))).toBe(
				"hello\nworld",
			);
			expect(await access.slice("notes", { startLine: 2, lineCount: 1 })).toBe("world");
			expect(await access.grep("notes", "wor")).toEqual({
				matches: [{ line: 2, text: "world" }],
				truncated: false,
			});
			await client.shutdown();
		});

		it("roundtrips binary content", async () => {
			const client = makeClient();
			const access = new DirectStoreAccess(client, ROOT_SCOPE);
			const body = new Uint8Array([7, 0, 255]);
			await access.bind({
				name: "blob",
				content: body,
				type: "bytes",
				provenance: prov("root"),
				explicit: true,
			});
			expect(await access.get("blob", { maxBytes: 100 })).toEqual(body);
			await client.shutdown();
		});
	});

	describe("ChannelStoreAccess + registerStoreHandlers", () => {
		let registry: HandleRegistry;
		let server: AuthChannelServer;
		let storeClient: StoreWorkerClient;
		const clients: AuthChannelClient[] = [];

		beforeEach(async () => {
			registry = new HandleRegistry({ trustedRegistrarId: TRUSTED });
			server = new AuthChannelServer({ port: 0, registry });
			await server.start();
			storeClient = makeClient();
			registerStoreHandlers(server, storeClient, { rootScopeId: ROOT_SCOPE });
		});

		afterEach(async () => {
			for (const c of clients.splice(0)) await c.disconnect();
			await server.stop();
			await storeClient.shutdown();
		});

		async function connectAgent(handleId: string): Promise<AuthChannelClient> {
			const token = mintToken();
			const result = registry.registerHandle({
				handleId,
				tokenHash: hashToken(token),
				registrarId: TRUSTED,
				ownerId: "root",
				depth: 1,
			});
			expect(result.ok).toBe(true);
			const client = new AuthChannelClient({ url: server.url, handleId, token });
			await client.connect();
			clients.push(client);
			return client;
		}

		it("roundtrips bind/peek/metadata/get/slice/grep over the channel", async () => {
			const client = await connectAgent("agent_a");
			const access: StoreAccess = new ChannelStoreAccess(client);
			const meta = await access.bind({
				name: "notes",
				content: "alpha\nbeta",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			expect(meta.name).toBe("notes");
			// The caller's scope IS its handle id.
			expect(meta.scopeId).toBe("agent_a");
			expect(await access.peek("notes")).toContain("text · 10 bytes");
			expect((await access.metadata("notes")).size).toBe(10);
			expect(new TextDecoder().decode(await access.get("notes", { maxBytes: 100 }))).toBe(
				"alpha\nbeta",
			);
			expect(await access.slice("notes", { startLine: 1, lineCount: 1 })).toBe("alpha");
			expect(await access.grep("notes", "bet", { maxResults: 5 })).toEqual({
				matches: [{ line: 2, text: "beta" }],
				truncated: false,
			});
		});

		it("roundtrips binary content over the channel", async () => {
			const client = await connectAgent("agent_bin");
			const access = new ChannelStoreAccess(client);
			const body = new Uint8Array([1, 2, 254]);
			await access.bind({
				name: "blob",
				content: body,
				type: "bytes",
				provenance: prov("agent_bin"),
				explicit: true,
			});
			expect(await access.get("blob", { maxBytes: 100 })).toEqual(body);
		});

		it("forces provenance.agentHandleId to the verified identity and ignores payload scope", async () => {
			const client = await connectAgent("agent_honest");
			// A crafted raw payload naming another agent's identity and scope.
			const result = (await client.request("store_bind", {
				name: "forged",
				content: "x",
				encoding: "utf8",
				type: "text",
				explicit: true,
				scopeId: ROOT_SCOPE,
				provenance: { agentHandleId: "someone_else", origin: { kind: "cell" } },
			})) as { scopeId: string; provenance: ValueProvenance };
			expect(result.scopeId).toBe("agent_honest");
			expect(result.provenance.agentHandleId).toBe("agent_honest");
		});

		it("scopes are per-agent: same name binds without collision, reads stay scoped", async () => {
			const a = new ChannelStoreAccess(await connectAgent("agent_a"));
			const b = new ChannelStoreAccess(await connectAgent("agent_b"));
			const metaA = await a.bind({
				name: "report",
				content: "a-content",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			const metaB = await b.bind({
				name: "report",
				content: "b-content",
				type: "text",
				provenance: prov("agent_b"),
				explicit: true,
			});
			expect(metaA.scopeId).toBe("agent_a");
			expect(metaB.scopeId).toBe("agent_b");
			expect(new TextDecoder().decode(await a.get("report", { maxBytes: 100 }))).toBe("a-content");
			expect(new TextDecoder().decode(await b.get("report", { maxBytes: 100 }))).toBe("b-content");
		});

		it("names() lists only the caller's own scope", async () => {
			const a = new ChannelStoreAccess(await connectAgent("agent_a"));
			const b = new ChannelStoreAccess(await connectAgent("agent_b"));
			await a.bind({
				name: "mine",
				content: "x",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			await b.bind({
				name: "theirs",
				content: "y",
				type: "text",
				provenance: prov("agent_b"),
				explicit: true,
			});
			expect(await a.names()).toEqual(["mine"]);
			expect(await b.names()).toEqual(["theirs"]);
		});

		it("a name is unreadable cross-scope, but the ulid is globally readable (engine semantics)", async () => {
			const a = new ChannelStoreAccess(await connectAgent("agent_a"));
			const b = new ChannelStoreAccess(await connectAgent("agent_b"));
			const metaB = await b.bind({
				name: "secret_notes",
				content: "b-only",
				type: "text",
				provenance: prov("agent_b"),
				explicit: true,
			});
			// By name: agent_a's scope has no such binding.
			await expect(a.peek("secret_notes")).rejects.toThrow(/unknown value/);
			// By ulid: current engine semantics resolve ulids globally. Asserted
			// deliberately — scope-visibility hardening would change this.
			expect(new TextDecoder().decode(await a.get(metaB.ulid, { maxBytes: 100 }))).toBe("b-only");
		});

		it("lazily creates the caller scope and tolerates a scope that already exists", async () => {
			const client = await connectAgent("agent_lazy");
			const access = new ChannelStoreAccess(client);
			await access.bind({
				name: "first",
				content: "1",
				type: "text",
				provenance: prov("agent_lazy"),
				explicit: true,
			});
			// A second handler registration (fresh created-scope memory, as after
			// a host restart racing its own journal) must treat "already exists"
			// as fine.
			registerStoreHandlers(server, storeClient, { rootScopeId: ROOT_SCOPE });
			const meta = await access.bind({
				name: "second",
				content: "2",
				type: "text",
				provenance: prov("agent_lazy"),
				explicit: true,
			});
			expect(meta.scopeId).toBe("agent_lazy");
		});

		it("store errors pass through as request errors", async () => {
			const client = await connectAgent("agent_err");
			const access = new ChannelStoreAccess(client);
			await expect(access.peek("never_bound")).rejects.toThrow(/unknown value/);
		});

		it("rejects malformed payloads field-by-field", async () => {
			const client = await connectAgent("agent_shape");
			await expect(client.request("store_bind", { name: 42 })).rejects.toThrow(/name/);
			await expect(client.request("store_peek", {})).rejects.toThrow(/ref/);
			await expect(client.request("store_slice", { ref: "x", startLine: "1" })).rejects.toThrow(
				/startLine/,
			);
			await expect(client.request("store_grep", { ref: "x" })).rejects.toThrow(/pattern/);
			await expect(client.request("store_get", { ref: "x" })).rejects.toThrow(/maxBytes/);
		});

		it("rejects non-finite and out-of-range numeric fields", async () => {
			const client = await connectAgent("agent_numbers");
			await expect(
				client.request("store_get", { ref: "x", maxBytes: Number.POSITIVE_INFINITY }),
			).rejects.toThrow(/maxBytes/);
			await expect(
				client.request("store_slice", { ref: "x", startLine: -1, lineCount: 1 }),
			).rejects.toThrow(/startLine/);
			await expect(
				client.request("store_slice", { ref: "x", startLine: 1.5, lineCount: 1 }),
			).rejects.toThrow(/startLine/);
			await expect(
				client.request("store_grep", { ref: "x", pattern: "a", maxResults: Number.NaN }),
			).rejects.toThrow(/maxResults/);
		});

		it("bind refuses a value whose wire form exceeds the channel limit", async () => {
			const access = new ChannelStoreAccess(await connectAgent("agent_big"));
			await expect(
				access.bind({
					name: "huge",
					content: "x".repeat(6 * 1024 * 1024 + 1),
					type: "text",
					provenance: prov("agent_big"),
					explicit: true,
				}),
			).rejects.toThrow(/too large for the channel.*CAS handoff/);
		});

		it("a channel get costs exactly one worker round-trip", async () => {
			const inner = workingSpawn();
			let issued = 0;
			const countingClient = new StoreWorkerClient({
				journalPath: join(dir, "journal.jsonl"),
				casRoot: join(dir, "cas"),
				rootScopeId: ROOT_SCOPE,
				opTimeoutMs: 1_000,
				spawnFn: () => {
					const handle = inner();
					const send = handle.send.bind(handle);
					handle.send = (line) => {
						issued++;
						send(line);
					};
					return handle;
				},
			});
			registerStoreHandlers(server, countingClient, { rootScopeId: ROOT_SCOPE });
			const access = new ChannelStoreAccess(await connectAgent("agent_count"));
			await access.bind({
				name: "counted",
				content: "payload",
				type: "text",
				provenance: prov("agent_count"),
				explicit: true,
			});
			const before = issued;
			expect(new TextDecoder().decode(await access.get("counted", { maxBytes: 100 }))).toBe(
				"payload",
			);
			// One worker op for the get — content and encoding in one response.
			expect(issued - before).toBe(1);
			await countingClient.shutdown();
		});
	});
});
