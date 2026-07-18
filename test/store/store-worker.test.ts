import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store/cas";
import { SessionJournal } from "../../src/store/journal";
import { SapStore } from "../../src/store/store";
import {
	StoreUnavailableError,
	StoreWorkerClient,
	type StoreWorkerHandle,
} from "../../src/store/store-client";
import { runStoreWorker, type StoreWorkerResponse } from "../../src/store/store-worker";
import type { ValueProvenance } from "../../src/store/value";

const ROOT_SCOPE = "scope_root";

const prov: ValueProvenance = { agentHandleId: "agent_a", origin: { kind: "cell" } };

describe("store worker", () => {
	let dir: string;
	let journal: SessionJournal;
	let cas: ContentStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sap-store-worker-"));
		journal = new SessionJournal(join(dir, "journal.jsonl"));
		cas = new ContentStore(join(dir, "cas"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** Feed a fixed script of stdin chunks through runStoreWorker in-process. */
	async function run(chunks: string[]): Promise<StoreWorkerResponse[]> {
		const store = new SapStore({ journal, cas, rootScopeId: ROOT_SCOPE });
		const responses: StoreWorkerResponse[] = [];
		async function* lines(): AsyncGenerator<string> {
			for (const chunk of chunks) yield chunk;
		}
		await runStoreWorker({
			lines: lines(),
			write: (line) => responses.push(JSON.parse(line) as StoreWorkerResponse),
			store,
		});
		return responses;
	}

	const req = (r: object): string => `${JSON.stringify(r)}\n`;

	describe("runStoreWorker protocol", () => {
		it("roundtrips every op", async () => {
			const bytesBody = new Uint8Array([0, 1, 2, 255]);
			const responses = await run([
				req({
					id: "r1",
					op: "createScope",
					scopeId: "scope_child",
					ownerHandleId: "agent_a",
					parentScopeId: ROOT_SCOPE,
				}),
				req({
					id: "r2",
					op: "bind",
					scopeId: ROOT_SCOPE,
					name: "notes",
					content: "hello\nworld",
					encoding: "utf8",
					type: "text",
					provenance: prov,
					explicit: true,
				}),
				req({
					id: "r3",
					op: "bind",
					scopeId: ROOT_SCOPE,
					name: "blob",
					content: Buffer.from(bytesBody).toString("base64"),
					encoding: "base64",
					type: "bytes",
					provenance: prov,
					explicit: true,
				}),
				req({ id: "r4", op: "peek", scopeId: ROOT_SCOPE, ref: "notes" }),
				req({ id: "r5", op: "metadata", scopeId: ROOT_SCOPE, ref: "notes" }),
				req({ id: "r6", op: "get", scopeId: ROOT_SCOPE, ref: "notes", maxBytes: 1024 }),
				req({ id: "r7", op: "get", scopeId: ROOT_SCOPE, ref: "blob", maxBytes: 1024 }),
				req({
					id: "r8",
					op: "slice",
					scopeId: ROOT_SCOPE,
					ref: "notes",
					startLine: 2,
					lineCount: 1,
				}),
				req({ id: "r9", op: "grep", scopeId: ROOT_SCOPE, ref: "notes", pattern: "wor" }),
			]);
			expect(responses).toHaveLength(9);
			for (const r of responses) expect(r.ok).toBe(true);
			const byId = new Map(responses.map((r) => [r.id, r]));
			const bindResult = (byId.get("r2") as { result: { name: string; ulid: string } }).result;
			expect(bindResult.name).toBe("notes");
			expect((byId.get("r4") as { result: string }).result).toContain("text · 11 bytes");
			expect((byId.get("r5") as { result: { size: number } }).result.size).toBe(11);
			expect((byId.get("r6") as { result: { content: string; encoding: string } }).result).toEqual({
				content: "hello\nworld",
				encoding: "utf8",
			});
			const blob = (byId.get("r7") as { result: { content: string; encoding: string } }).result;
			expect(blob.encoding).toBe("base64");
			expect(new Uint8Array(Buffer.from(blob.content, "base64"))).toEqual(bytesBody);
			expect((byId.get("r8") as { result: string }).result).toBe("world");
			expect((byId.get("r9") as { result: { line: number; text: string }[] }).result).toEqual([
				{ line: 2, text: "world" },
			]);
		});

		it("reassembles a request split across stdin chunks", async () => {
			const line = req({ id: "s1", op: "peek", scopeId: ROOT_SCOPE, ref: "missing" });
			const responses = await run([line.slice(0, 10), line.slice(10)]);
			expect(responses).toHaveLength(1);
			expect(responses[0]?.id).toBe("s1");
			expect(responses[0]?.ok).toBe(false);
		});

		it("answers an unknown op with an error response", async () => {
			const responses = await run([req({ id: "u1", op: "explode" })]);
			expect(responses).toEqual([
				{ id: "u1", ok: false, error: expect.stringContaining("unknown op") },
			]);
		});

		it("answers a malformed request that still carries an id", async () => {
			const responses = await run([req({ id: "m1", op: "get" })]);
			expect(responses).toHaveLength(1);
			expect(responses[0]).toMatchObject({ id: "m1", ok: false });
		});

		it("drops unparseable lines and lines without a recoverable id", async () => {
			const responses = await run([
				"this is not json\n",
				req({ op: "peek", scopeId: ROOT_SCOPE, ref: "x" }),
				req({ id: 42, op: "peek", scopeId: ROOT_SCOPE, ref: "x" }),
			]);
			expect(responses).toHaveLength(0);
		});

		it("returns engine errors as error responses", async () => {
			const responses = await run([
				req({ id: "e1", op: "peek", scopeId: ROOT_SCOPE, ref: "nope" }),
			]);
			expect(responses).toEqual([
				{ id: "e1", ok: false, error: expect.stringContaining("unknown value") },
			]);
		});
	});

	describe("StoreWorkerClient with in-process fakes", () => {
		/**
		 * A working fake worker: a fresh SapStore.resume over the shared temp
		 * journal/cas per spawn, exactly like a real restart.
		 */
		function workingSpawn(spawnLog: StoreWorkerHandle[]): () => StoreWorkerHandle {
			return () => {
				let lineHandler: (line: string) => void = () => {};
				const storeReady = SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
				let queue = Promise.resolve();
				const handle: StoreWorkerHandle = {
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
				spawnLog.push(handle);
				return handle;
			};
		}

		/** A wedged fake: accepts requests, never answers. */
		function wedgedHandle(): StoreWorkerHandle {
			return { send() {}, kill() {}, onLine() {}, onExit() {} };
		}

		function makeClient(spawnFn: () => StoreWorkerHandle, opts: { opTimeoutMs?: number } = {}) {
			return new StoreWorkerClient({
				journalPath: join(dir, "journal.jsonl"),
				casRoot: join(dir, "cas"),
				rootScopeId: ROOT_SCOPE,
				opTimeoutMs: opts.opTimeoutMs ?? 200,
				spawnFn,
			});
		}

		it("performs ops end to end through a fake worker", async () => {
			const spawns: StoreWorkerHandle[] = [];
			const client = makeClient(workingSpawn(spawns));
			const meta = await client.bind({
				scopeId: ROOT_SCOPE,
				name: "notes",
				content: "hello\nworld",
				type: "text",
				provenance: prov,
				explicit: true,
			});
			expect(meta.name).toBe("notes");
			expect(await client.peek(ROOT_SCOPE, "notes")).toContain("text · 11 bytes");
			expect(
				new TextDecoder().decode(await client.get(ROOT_SCOPE, "notes", { maxBytes: 100 })),
			).toBe("hello\nworld");
			expect(await client.grep(ROOT_SCOPE, "notes", "hel")).toEqual([{ line: 1, text: "hello" }]);
			await client.shutdown();
		});

		it("roundtrips a bytes value through the client", async () => {
			const spawns: StoreWorkerHandle[] = [];
			const client = makeClient(workingSpawn(spawns));
			const body = new Uint8Array([7, 0, 255]);
			await client.bind({
				scopeId: ROOT_SCOPE,
				name: "blob",
				content: body,
				type: "bytes",
				provenance: prov,
				explicit: true,
			});
			expect(await client.get(ROOT_SCOPE, "blob", { maxBytes: 100 })).toEqual(body);
			await client.shutdown();
		});

		it("recovers a wedged worker: timeout kills, respawns, re-issues transparently", async () => {
			const spawns: StoreWorkerHandle[] = [];
			let killed = 0;
			const working = workingSpawn(spawns);
			let first = true;
			const client = makeClient(() => {
				if (first) {
					first = false;
					const wedged = wedgedHandle();
					wedged.kill = () => killed++;
					return wedged;
				}
				return working();
			});
			const meta = await client.bind({
				scopeId: ROOT_SCOPE,
				name: "notes",
				content: "abc",
				type: "text",
				provenance: prov,
				explicit: true,
			});
			expect(meta.name).toBe("notes");
			expect(killed).toBe(1);
			await client.shutdown();
		});

		it("re-issued binds dedup by ulid: one journal record across a restart", async () => {
			// First worker journals the bind but its response is lost (wedge after
			// write); the re-issue against the restarted worker must dedup.
			const spawns: StoreWorkerHandle[] = [];
			const working = workingSpawn(spawns);
			let first = true;
			const client = makeClient(() => {
				const handle = working();
				if (first) {
					first = false;
					// Swallow responses: the op executes (and journals) but the
					// client never hears back, so it restarts and re-issues.
					handle.onLine = () => {};
				}
				return handle;
			});
			await client.bind({
				scopeId: ROOT_SCOPE,
				name: "notes",
				content: "abc",
				type: "text",
				provenance: prov,
				explicit: true,
			});
			// Give the first worker's queued handling time to journal too.
			await new Promise((r) => setTimeout(r, 50));
			const binds = (await journal.replay()).filter((r) => r.kind === "bind");
			expect(binds).toHaveLength(1);
			await client.shutdown();
		});

		it("rejects with StoreUnavailableError (.infrastructure) when restarts exhaust", async () => {
			let spawnCount = 0;
			const client = new StoreWorkerClient({
				journalPath: join(dir, "journal.jsonl"),
				casRoot: join(dir, "cas"),
				rootScopeId: ROOT_SCOPE,
				opTimeoutMs: 100,
				maxRestarts: 2,
				spawnFn: () => {
					spawnCount++;
					return wedgedHandle();
				},
			});
			const err = await client
				.peek(ROOT_SCOPE, "x")
				.then(() => undefined)
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(StoreUnavailableError);
			expect((err as StoreUnavailableError).infrastructure).toBe(true);
			// Initial spawn + maxRestarts respawns.
			expect(spawnCount).toBe(3);
			await client.shutdown();
		});

		it("passes normal op errors through without restarting", async () => {
			let spawnCount = 0;
			const spawns: StoreWorkerHandle[] = [];
			const working = workingSpawn(spawns);
			const client = makeClient(() => {
				spawnCount++;
				return working();
			});
			await expect(client.peek(ROOT_SCOPE, "missing")).rejects.toThrow(/unknown value/);
			expect(spawnCount).toBe(1);
			await client.shutdown();
		});

		it("restarts and re-issues when the worker dies without a timeout", async () => {
			const spawns: StoreWorkerHandle[] = [];
			const working = workingSpawn(spawns);
			let exitHandler: (() => void) | undefined;
			let first = true;
			const client = makeClient(() => {
				if (first) {
					first = false;
					// A worker that crashes as soon as it receives a request.
					return {
						send() {
							exitHandler?.();
						},
						kill() {},
						onLine() {},
						onExit(cb) {
							exitHandler = cb;
						},
					};
				}
				return working();
			});
			const meta = await client.bind({
				scopeId: ROOT_SCOPE,
				name: "notes",
				content: "abc",
				type: "text",
				provenance: prov,
				explicit: true,
			});
			expect(meta.name).toBe("notes");
			await client.shutdown();
		});

		it("shutdown rejects in-flight ops with StoreUnavailableError", async () => {
			const client = makeClient(wedgedHandle, { opTimeoutMs: 60_000 });
			const pending = client.peek(ROOT_SCOPE, "x");
			await client.shutdown();
			const err = await pending.then(() => undefined).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(StoreUnavailableError);
		});
	});

	describe("real subprocess integration", () => {
		it("binds and reads through an actual spawned worker", async () => {
			const savedExec = process.env.SPROUT_SELF_EXECUTABLE;
			const savedEntry = process.env.SPROUT_SELF_ENTRYPOINT;
			process.env.SPROUT_SELF_EXECUTABLE = process.execPath;
			process.env.SPROUT_SELF_ENTRYPOINT = join(import.meta.dir, "../../src/host/cli.ts");
			try {
				const client = new StoreWorkerClient({
					journalPath: join(dir, "journal.jsonl"),
					casRoot: join(dir, "cas"),
					rootScopeId: ROOT_SCOPE,
				});
				const meta = await client.bind({
					scopeId: ROOT_SCOPE,
					name: "notes",
					content: "hello\nworld",
					type: "text",
					provenance: prov,
					explicit: true,
				});
				expect(meta.name).toBe("notes");
				expect(await client.peek(ROOT_SCOPE, "notes")).toContain("text · 11 bytes");
				const body = await client.get(ROOT_SCOPE, "notes", { maxBytes: 100 });
				expect(new TextDecoder().decode(body)).toBe("hello\nworld");
				expect(await client.grep(ROOT_SCOPE, "notes", "^wor")).toEqual([
					{ line: 2, text: "world" },
				]);
				await client.shutdown();
				// The worker journaled the bind: a direct resume sees it.
				const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
				expect(await resumed.peek(ROOT_SCOPE, "notes")).toContain("text · 11 bytes");
			} finally {
				if (savedExec === undefined) delete process.env.SPROUT_SELF_EXECUTABLE;
				else process.env.SPROUT_SELF_EXECUTABLE = savedExec;
				if (savedEntry === undefined) delete process.env.SPROUT_SELF_ENTRYPOINT;
				else process.env.SPROUT_SELF_ENTRYPOINT = savedEntry;
			}
		}, 20_000);
	});
});
