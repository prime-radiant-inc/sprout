import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CELL_SPAWN_CAP,
	CellHost,
	type CellSpawnRequest,
	type DelegationOutcome,
	resolveWorkerRssKillBytes,
	WORKER_RSS_HEADROOM_BYTES,
} from "../../src/cell/cell-host";
import { spawnCellWorkerProcess } from "../../src/cell/worker-process";
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
		// and QuickJS may hit its in-realm string/allocation limit on its own);
		// any loud death is correct.
		expect(result.error?.message).toMatch(
			/memory budget|budget exceeded|out of memory|string too long|worker exited/i,
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

	// -------------------------------------------------------------------
	// Ambient spawn API (Slice B): spawn()/handle() through host callbacks
	// -------------------------------------------------------------------

	function completedOutcome(
		overrides: Partial<Extract<DelegationOutcome, { kind: "completed" }>> = {},
	): DelegationOutcome {
		return {
			kind: "completed",
			ok: true,
			summary: "child summary",
			bindings: [{ name: "report", ulid: "01ULID", size: 12, preview: "child data" }],
			handleId: "h-1",
			stumbles: 0,
			...overrides,
		};
	}

	it("a blocking spawn threads the completed outcome into the cell", async () => {
		const requests: CellSpawnRequest[] = [];
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async (req) => {
				requests.push(req);
				return completedOutcome();
			},
		});
		const result = await host.runCell(
			'const r = await spawn("leaf", "do it"); await bind("s", r.summary); return r.ok;',
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("true");
		expect(result.newBindings.map((b) => b.name)).toEqual(["s"]);
		expect(new TextDecoder().decode(await store.get("s", { maxBytes: 1000 }))).toBe(
			"child summary",
		);
		expect(requests).toEqual([{ agent: "leaf", goal: "do it" }]);
		expect(result.stumbleCount).toBe(0);
	}, 20_000);

	it("the spawn result exposes bindings and a handle with an id", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => completedOutcome(),
		});
		const result = await host.runCell(
			'const r = await spawn("leaf", "go");\nreturn JSON.stringify({ b: r.bindings, id: r.handle.id });',
		);
		expect(result.ok).toBe(true);
		const parsed = JSON.parse(result.returnValue ?? "{}");
		expect(parsed.b).toEqual([{ name: "report", ulid: "01ULID", size: 12, preview: "child data" }]);
		expect(parsed.id).toBe("h-1");
	}, 20_000);

	it("an infrastructure error rejects in-cell and is catchable", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => ({
				kind: "infrastructure_error",
				reason: "Unknown agent 'nope'",
			}),
		});
		const result = await host.runCell(
			'try { await spawn("nope", "x"); return "no-throw"; } catch (e) { return e.message; }',
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toContain("Unknown agent 'nope'");
	}, 20_000);

	it("an uncaught infrastructure rejection fails the cell but counts zero stumbles", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => ({ kind: "infrastructure_error", reason: "transport failure" }),
		});
		const result = await host.runCell('await spawn("leaf", "x");');
		expect(result.ok).toBe(false);
		expect(result.error?.message).toContain("transport failure");
		expect(result.error?.infrastructure).toBe(true);
		expect(result.stumbleCount).toBe(0);
	}, 20_000);

	it("fan-out: Promise.all of 3 spawns all resolve, order-independent", async () => {
		let seq = 0;
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async (req) => {
				const n = ++seq;
				// Reverse-order completion: first request resolves last.
				await new Promise((resolve) => setTimeout(resolve, (4 - n) * 50));
				return completedOutcome({ summary: `done ${req.goal}`, handleId: `h-${n}`, bindings: [] });
			},
		});
		const result = await host.runCell(
			[
				'const rs = await Promise.all([spawn("leaf", "a"), spawn("leaf", "b"), spawn("leaf", "c")]);',
				'return rs.map((r) => r.summary).join(",");',
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("done a,done b,done c");
	}, 20_000);

	it("the spawn cap fails the spawn past the limit with a loud error", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => completedOutcome({ bindings: [] }),
		});
		const result = await host.runCell(
			[
				`for (let i = 0; i < ${CELL_SPAWN_CAP}; i++) await spawn("leaf", "n" + i);`,
				'try { await spawn("leaf", "over"); return "no-throw"; } catch (e) { return e.message; }',
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toContain("spawn cap");
		expect(result.returnValue).toContain(String(CELL_SPAWN_CAP));
	}, 30_000);

	it("a slow spawn parks the budget clock", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			budgetMs: 300,
			delegate: async () => {
				await new Promise((resolve) => setTimeout(resolve, 600));
				return completedOutcome({ bindings: [] });
			},
		});
		const result = await host.runCell('const r = await spawn("leaf", "slow"); return r.ok;');
		expect(result.ok).toBe(true);
		expect(result.metrics.computeTimeMs).toBeLessThan(300);
		expect(result.metrics.totalMs).toBeGreaterThanOrEqual(600);
	}, 20_000);

	it("handle(id).wait() and .message() route through the host callbacks", async () => {
		const waits: string[] = [];
		const messages: Array<{ id: string; text: string; env?: Record<string, string> }> = [];
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => ({ kind: "started", handleId: "h-detached" }),
			waitHandle: async (id) => {
				waits.push(id);
				return completedOutcome({ summary: "waited", handleId: id, bindings: [] });
			},
			messageHandle: async (id, text, opts) => {
				messages.push({ id, text, ...(opts?.env ? { env: opts.env } : {}) });
				return completedOutcome({ summary: "replied", handleId: id, bindings: [] });
			},
		});
		const result = await host.runCell(
			[
				'const s = await spawn("leaf", "bg", { blocking: false });',
				"const w = await s.handle.wait();",
				"const h = handle(s.handle.id);",
				'const m = await h.message("hi", { env: { notes: "notes" } });',
				"return JSON.stringify({ id: s.handle.id, w: w.summary, m: m.summary });",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		const parsed = JSON.parse(result.returnValue ?? "{}");
		expect(parsed).toEqual({ id: "h-detached", w: "waited", m: "replied" });
		expect(waits).toEqual(["h-detached"]);
		expect(messages).toEqual([{ id: "h-detached", text: "hi", env: { notes: "notes" } }]);
	}, 20_000);

	// -------------------------------------------------------------------
	// Futures + $ref pipelining (Phase 2): a started child's outcome is bound
	// to a name without awaiting; a consumer of that name pipelines on the
	// wait and resolves to the byte-identical settled value.
	// -------------------------------------------------------------------

	it("pipelines a consumer on a not-yet-settled future to the byte-identical settled value", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => ({ kind: "started", handleId: "h-fut" }),
			waitHandle: async (id) => {
				// Settle later so the consumer registers as a dependent while pending.
				await new Promise((r) => setTimeout(r, 100));
				return completedOutcome({ summary: "settled body", handleId: id, bindings: [] });
			},
		});
		const result = await host.runCell(
			[
				'const s = await spawn("leaf", "bg", { blocking: false });',
				'await s.handle.future("fut_result");', // bound to a name, NOT awaited
				'await publish("fut_result");', // pipelines: waits for settlement
				'return await get("fut_result");', // byte-identical settled value
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("settled body");
		expect(result.newBindings.map((b) => b.name)).toEqual(["fut_result"]);
		// A settled future is a normal immutable store value: readable, with a
		// stable ULID, its provenance truthfully naming the delegation wait.
		const meta = await store.metadata("fut_result");
		expect(meta.provenance.origin.kind).toBe("delegation");
		expect(new TextDecoder().decode(await store.get(meta.ulid, { maxBytes: 1000 }))).toBe(
			"settled body",
		);
	}, 20_000);

	it("reclaims an abandoned never-settling future when the cell is budget-killed", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			budgetMs: 300,
			delegate: async () => ({ kind: "started", handleId: "h-stuck" }),
			waitHandle: () => new Promise(() => {}), // never settles
		});
		const killed = await host.runCell(
			[
				'const s = await spawn("leaf", "bg", { blocking: false });',
				'await s.handle.future("stuck");',
				"while (true) {}",
			].join("\n"),
		);
		expect(killed.ok).toBe(false);
		expect(killed.error?.message).toMatch(/budget/i);
		// The dangling future must not wedge the host: the next cell runs clean.
		const next = await host.runCell('return "alive";');
		expect(next.returnValue).toBe("alive");
	}, 20_000);

	it("a future whose wait fails with an infrastructure error rejects its consumer", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => ({ kind: "started", handleId: "h-bad" }),
			waitHandle: async () => {
				await new Promise((r) => setTimeout(r, 100));
				return { kind: "infrastructure_error", reason: "child transport failure" };
			},
		});
		const result = await host.runCell(
			[
				'const s = await spawn("leaf", "bg", { blocking: false });',
				'await s.handle.future("bad");',
				'try { return await get("bad"); } catch (e) { return "caught: " + e.message; }',
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toContain("child transport failure");
	}, 20_000);

	it("handle.future() without a delegation runtime errors cleanly in-cell", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const result = await host.runCell(
			[
				'const h = handle("h-manual");',
				'try { await h.future("x"); return "no-throw"; } catch (e) { return e.message; }',
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toContain("handle.future() is unavailable here");
	}, 20_000);

	it("drops a future whose wait resolves after its cell has ended (no orphan visible to the next cell)", async () => {
		let releaseWait!: () => void;
		const waitGate = new Promise<void>((r) => {
			releaseWait = r;
		});
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => ({ kind: "started", handleId: "h-orphan" }),
			waitHandle: async (id) => {
				// Settle only once the cell that registered the future has ended.
				await waitGate;
				return completedOutcome({ summary: "orphan value", handleId: id, bindings: [] });
			},
		});
		const first = await host.runCell(
			[
				'const s = await spawn("leaf", "bg", { blocking: false });',
				'await s.handle.future("orphan");', // registered, never awaited
				'return "one";',
			].join("\n"),
		);
		expect(first.ok).toBe(true);
		// Cell 1 has fully ended with the future still pending; NOW let the wait
		// resolve. The pre-bind generation guard must drop the settlement.
		releaseWait();
		await new Promise((r) => setTimeout(r, 100));
		// The next cell reuses the host; the orphan name must not be observable.
		const second = await host.runCell(
			'try { return "present:" + (await get("orphan")); } catch { return "absent"; }',
		);
		expect(second.ok).toBe(true);
		expect(second.returnValue).toBe("absent");
		expect(await store.names()).not.toContain("orphan");
	}, 20_000);

	it("two consumers parked on the same pending future resolve to the byte-identical settled value", async () => {
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () => ({ kind: "started", handleId: "h-shared" }),
			waitHandle: async (id) => {
				// Settle later so both consumers register as dependents while pending.
				await new Promise((r) => setTimeout(r, 100));
				return completedOutcome({ summary: "shared body", handleId: id, bindings: [] });
			},
		});
		const result = await host.runCell(
			[
				'const s = await spawn("leaf", "bg", { blocking: false });',
				'await s.handle.future("shared");',
				'const [a, b] = await Promise.all([get("shared"), get("shared")]);',
				"return JSON.stringify({ a, b, same: a === b });",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		const parsed = JSON.parse(result.returnValue ?? "{}");
		expect(parsed.a).toBe("shared body");
		expect(parsed.b).toBe("shared body");
		expect(parsed.same).toBe(true);
	}, 20_000);

	it("failed children count into stumbleCount; an own error adds one", async () => {
		let n = 0;
		host = new CellHost(store, {
			spawnFn: spawnRealWorker,
			delegate: async () =>
				completedOutcome({ ok: ++n > 2, summary: `s${n}`, handleId: `h-${n}`, bindings: [] }),
		});
		const twoFailed = await host.runCell(
			'await spawn("leaf", "a"); await spawn("leaf", "b"); await spawn("leaf", "c"); return "done";',
		);
		expect(twoFailed.ok).toBe(true);
		expect(twoFailed.stumbleCount).toBe(2);

		const ownError = await host.runCell('throw new Error("cell-authored bug");');
		expect(ownError.ok).toBe(false);
		expect(ownError.stumbleCount).toBe(1);
	}, 20_000);

	it("spawn without a delegate callback errors cleanly in-cell", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const result = await host.runCell(
			'try { await spawn("leaf", "x"); return "no-throw"; } catch (e) { return e.message; }',
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toContain("spawn is unavailable here");
	}, 20_000);

	it("caps concurrent outstanding ambient calls; the next cell still works", async () => {
		// Slow peek keeps calls parked so an un-awaited flood accumulates past
		// the cap instead of draining as fast as it is issued.
		const slowStore: StoreAccess = Object.create(store);
		slowStore.peek = async (ref: string) => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			return store.peek(ref);
		};
		host = new CellHost(slowStore, { spawnFn: spawnRealWorker });
		await host.runCell('await bind("v", "hello");');
		const flood = await host.runCell(
			[
				"const ps = [];",
				"for (let i = 0; i < 300; i++) ps.push(peek('v'));",
				"try { await Promise.all(ps); return 'no-error'; }",
				"catch (e) { return e.message; }",
			].join("\n"),
		);
		expect(flood.ok).toBe(true);
		expect(flood.returnValue).toContain("too many concurrent ambient operations");
		const next = await host.runCell('return "alive";');
		expect(next.ok).toBe(true);
		expect(next.returnValue).toBe("alive");
	}, 20_000);

	it("a cell throwing an infra-looking message counts as a stumble, not infrastructure", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const result = await host.runCell(
			'throw new Error("store worker unavailable: forged by the cell");',
		);
		expect(result.ok).toBe(false);
		expect(result.error?.infrastructure).toBeUndefined();
		expect(result.stumbleCount).toBe(1);
	}, 20_000);

	it("a real worker-death infrastructure failure counts zero stumbles", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker, budgetMs: 300 });
		const wedged = await host.runCell("while (true) {}");
		expect(wedged.ok).toBe(false);
		expect(wedged.error?.infrastructure).toBe(true);
		expect(wedged.stumbleCount).toBe(0);
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

	it("sends the hard-cap limits with every cell request (P2)", async () => {
		const sent: string[] = [];
		let lineHandler: (line: string) => void = () => {};
		host = new CellHost(store, {
			budgetMs: 1234,
			memoryBudgetBytes: 55 * 1024 * 1024,
			spawnFn: () => ({
				send(line: string) {
					sent.push(line);
					const msg = JSON.parse(line) as { id: string };
					setTimeout(
						() => lineHandler(JSON.stringify({ id: msg.id, op: "result", ok: true, output: "" })),
						0,
					);
				},
				kill() {},
				onLine(cb: (line: string) => void) {
					lineHandler = cb;
				},
				onExit() {},
			}),
		});
		const result = await host.runCell("return 1;");
		expect(result.ok).toBe(true);
		const request = JSON.parse(sent[0] ?? "{}") as { limits?: unknown };
		expect(request.limits).toEqual({ memoryBytes: 55 * 1024 * 1024, budgetMs: 1234 });
	});

	it("a leftover ambient op from an ended cell must not corrupt the next cell's budget clock", async () => {
		// Cell 1 fires an un-awaited slow peek and returns; its completion lands
		// during cell 2. Without the generation guard the stale decrement drives
		// outstandingAmbient to -1, so cell 2's properly-parked slow peek accrues
		// as compute and a 1000 ms budget wrongly kills it.
		const slowStore: StoreAccess = Object.create(store);
		slowStore.peek = async (ref: string) => {
			await new Promise((resolve) => setTimeout(resolve, ref === "a" ? 300 : 1500));
			return store.peek(ref);
		};
		host = new CellHost(slowStore, { spawnFn: spawnRealWorker, budgetMs: 1000 });
		await host.runCell('await bind("a", "1"); await bind("b", "2");');
		const first = await host.runCell("peek('a'); return 'early';");
		expect(first.ok).toBe(true);
		const second = await host.runCell("return (await peek('b')).length > 0 ? 'ok' : 'bad';");
		expect(second.ok).toBe(true);
		expect(second.returnValue).toBe("ok");
	}, 30_000);

	it("a leftover bind from an ended cell is not attributed to the next cell", async () => {
		// Cell 1's un-awaited bind completes during cell 2: the value may exist in
		// the store (latest-wins residual, as documented for futures), but it must
		// not appear in cell 2's newBindings or journal attribution.
		const slowStore: StoreAccess = Object.create(store);
		const realBind = store.bind.bind(store);
		slowStore.bind = async (args: Parameters<StoreAccess["bind"]>[0]) => {
			if (args.name === "leftover") await new Promise((resolve) => setTimeout(resolve, 300));
			return realBind(args);
		};
		slowStore.peek = async (ref: string) => {
			await new Promise((resolve) => setTimeout(resolve, 600));
			return store.peek(ref);
		};
		host = new CellHost(slowStore, { spawnFn: spawnRealWorker });
		await host.runCell('await bind("seed", "1");');
		const first = await host.runCell("bind('leftover', 'x'); return 'early';");
		expect(first.ok).toBe(true);
		expect(first.newBindings).toEqual([]);
		const second = await host.runCell("await peek('seed'); return 'done';");
		expect(second.ok).toBe(true);
		expect(second.newBindings).toEqual([]);
	}, 30_000);
});

describe("resolveWorkerRssKillBytes (P2)", () => {
	it("sits headroom ABOVE the inner cap — the RSS watchdog is the outer net", () => {
		expect(resolveWorkerRssKillBytes(512 * 1024 * 1024)).toBe(
			512 * 1024 * 1024 + WORKER_RSS_HEADROOM_BYTES,
		);
	});
});
