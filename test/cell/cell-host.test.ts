import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellHost, spawnCellWorkerProcess } from "../../src/cell/cell-host";
import { ContentStore } from "../../src/store/cas";
import { SessionJournal } from "../../src/store/journal";
import { SapStore } from "../../src/store/store";
import { DirectStoreAccess, type StoreAccess } from "../../src/store/store-access";
import { StoreWorkerClient, type StoreWorkerHandle } from "../../src/store/store-client";
import { runStoreWorker } from "../../src/store/store-worker";

const ROOT_SCOPE = "root";
const AGENT_SCOPE = "agent-1";
const WORKER_ENTRY = join(import.meta.dir, "../../src/cell/cell-worker.ts");

/** Real subprocess cell worker, spawned via bun directly (no self-command env). */
const spawnRealWorker = () => spawnCellWorkerProcess([process.execPath, WORKER_ENTRY]);

describe("CellHost", () => {
	let dir: string;
	let journal: SessionJournal;
	let cas: ContentStore;
	let client: StoreWorkerClient;
	let store: StoreAccess;
	let host: CellHost | undefined;

	/** In-process fake store worker: a fresh SapStore.resume per spawn. */
	function workingSpawn(): () => StoreWorkerHandle {
		return () => {
			let lineHandler: (line: string) => void = () => {};
			const storeReady = SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			let queue = Promise.resolve();
			return {
				send(line) {
					queue = queue.then(async () => {
						const engine = await storeReady;
						const responses: string[] = [];
						async function* one(): AsyncGenerator<string> {
							yield line;
						}
						await runStoreWorker({ lines: one(), write: (l) => responses.push(l), store: engine });
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

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sap-cell-host-"));
		journal = new SessionJournal(join(dir, "journal.jsonl"));
		cas = new ContentStore(join(dir, "cas"));
		client = new StoreWorkerClient({
			journalPath: join(dir, "journal.jsonl"),
			casRoot: join(dir, "cas"),
			rootScopeId: ROOT_SCOPE,
			opTimeoutMs: 2_000,
			spawnFn: workingSpawn(),
		});
		await client.createScope({
			scopeId: AGENT_SCOPE,
			ownerHandleId: AGENT_SCOPE,
			parentScopeId: ROOT_SCOPE,
		});
		store = new DirectStoreAccess(client, AGENT_SCOPE);
	});

	afterEach(async () => {
		host?.shutdown();
		host = undefined;
		await client.shutdown();
		await rm(dir, { recursive: true, force: true });
	});

	it("runs the ambient value API end-to-end against a real store", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const bindResult = await host.runCell(
			'await bind("notes", "alpha\\nbeta\\ngamma"); await bind("data", {k: [1, 2, 3]}); await publish("notes"); return "bound";',
		);
		expect(bindResult.ok).toBe(true);
		expect(bindResult.returnValue).toBe("bound");
		expect(bindResult.newBindings.map((b) => b.name)).toEqual(["notes", "data"]);

		const readResult = await host.runCell(
			[
				'const p = await peek("notes");',
				'const full = await get("notes");',
				'const sliced = await slice("notes", 2, 3);',
				'const l = await lines("notes", 1, 1);',
				'const g = await grep("notes", "ta$");',
				'const parsed = await parse("data");',
				'const s = await size("notes");',
				"return JSON.stringify({ p: p.length > 0, full, sliced, l, g: g.matches.length, parsed: parsed.k, s });",
			].join("\n"),
		);
		expect(readResult.ok).toBe(true);
		const parsed = JSON.parse(readResult.returnValue ?? "{}");
		expect(parsed.full).toBe("alpha\nbeta\ngamma");
		expect(parsed.sliced).toContain("beta");
		expect(parsed.sliced).toContain("gamma");
		expect(parsed.l).toContain("alpha");
		expect(parsed.g).toBe(1);
		expect(parsed.parsed).toEqual([1, 2, 3]);
		expect(parsed.s).toBe(16);
	}, 20_000);

	it("bindings persist across cells while plain locals die", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const first = await host.runCell('const local = "x"; await bind("kept", "persisted");');
		expect(first.ok).toBe(true);
		const second = await host.runCell('return await get("kept");');
		expect(second.ok).toBe(true);
		expect(second.returnValue).toBe("persisted");
		const third = await host.runCell("return local;");
		expect(third.ok).toBe(false);
		expect(third.error?.message).toContain("local");
	}, 20_000);

	it("errors include the names currently in scope", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		await host.runCell('await bind("alpha", "1"); await bind("beta", "2");');
		const failed = await host.runCell('return await get("missing");');
		expect(failed.ok).toBe(false);
		expect(failed.error?.scopeNames).toEqual(["alpha", "beta"]);
	}, 20_000);

	it("the parent clock kills a wedged sync loop and the next cell works (respawn)", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker, budgetMs: 300 });
		const wedged = await host.runCell("while (true) {}");
		expect(wedged.ok).toBe(false);
		expect(wedged.error?.message).toContain("cell budget exceeded");
		const next = await host.runCell('return "alive";');
		expect(next.ok).toBe(true);
		expect(next.returnValue).toBe("alive");
	}, 20_000);

	it("time parked on ambient awaits does not accrue against the budget", async () => {
		const slowStore: StoreAccess = Object.create(store);
		slowStore.peek = async (ref: string) => {
			await new Promise((resolve) => setTimeout(resolve, 600));
			return store.peek(ref);
		};
		host = new CellHost(slowStore, { spawnFn: spawnRealWorker, budgetMs: 300 });
		await host.runCell('await bind("v", "hello");');
		const result = await host.runCell('return await peek("v");');
		expect(result.ok).toBe(true);
		expect(result.returnValue).toContain("hello");
		expect(result.metrics.computeTimeMs).toBeLessThan(300);
		expect(result.metrics.totalMs).toBeGreaterThanOrEqual(600);
	}, 20_000);

	it("an allocation bomb dies by a guard (memory or time budget)", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			budgetMs: 10_000,
			memoryBudgetBytes: 64 * 1024 * 1024,
		});
		const result = await host.runCell('let s = "x"; while (true) s += s;');
		expect(result.ok).toBe(false);
		// Which guard fires first is timing-dependent (the bomb also burns CPU,
		// and the runtime may OOM-throw on its own); any loud death is correct.
		expect(result.error?.message).toMatch(
			/memory budget|budget exceeded|out of memory|worker exited/i,
		);
	}, 30_000);

	it("redacts secrets in captured stdout", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const result = await host.runCell(
			'console.log("api_key=sk-abcdefghijklmnopqrstuvwxyz123456");',
		);
		expect(result.ok).toBe(true);
		expect(result.output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
		expect(result.output).toContain("api_key=");
	}, 20_000);

	it("auto-binds oversized stdout and marks the transcript with the value name", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const result = await host.runCell('console.log("z".repeat(5000));');
		expect(result.ok).toBe(true);
		expect(result.output.length).toBeLessThan(2400);
		expect(result.output).toContain("⟦cell_1_output⟧");
		const bound = new TextDecoder().decode(await store.get("cell_1_output", { maxBytes: 10_000 }));
		expect(bound.trim()).toBe("z".repeat(5000));
	}, 20_000);

	it("journals a redacted cell record with bindings and compute time", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const code = 'const password = "hunter2secret"; await bind("out", "v"); return 1;';
		await host.runCell(code);
		const records = await journal.replay();
		const cell = records.find((r) => r.kind === "cell");
		expect(cell).toBeDefined();
		if (cell?.kind !== "cell") throw new Error("unreachable");
		expect(cell.handle).toBe(AGENT_SCOPE);
		expect(cell.code).not.toContain("hunter2secret");
		expect(cell.bindings.map((b) => b.name)).toEqual(["out"]);
		expect(cell.computeTimeMs).toBeGreaterThanOrEqual(0);
	}, 20_000);

	it("serializes concurrent runCell calls in submission order", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const [first, second] = await Promise.all([
			host.runCell('await bind("first", "1"); return "one";'),
			host.runCell('return (await peek("first")).length > 0 ? "two" : "broken";'),
		]);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(second.returnValue).toBe("two");
	}, 20_000);
});
