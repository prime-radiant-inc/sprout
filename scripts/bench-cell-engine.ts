#!/usr/bin/env bun
/**
 * Cell-engine perf benchmark (QuickJS spec P3, acceptance #6). Drives a REAL
 * CellHost — a real cell-worker subprocess speaking the stdio protocol to a
 * real in-process store — under each engine, so the measured wall-time includes
 * the actual per-ambient-call round-trip that dominates a real sap cell. A fake
 * in-process ambient handler would hide exactly the I/O the gate is about.
 *
 * The engine is selected by SPROUT_CELL_ENGINE — but Bun.spawn snapshots env at
 * BUN STARTUP and ignores later `process.env` mutations, so a single process
 * cannot measure both engines by flipping the var. Instead the default
 * (compare) mode RE-EXECS this script once per engine with the var in explicit
 * spawn env; the cell worker each child spawns inherits that startup snapshot.
 *
 * Two workloads:
 *   - I/O-bound (the GATE): the sap flagship shape — bind → read-back → slice →
 *     grep → size, several ambient round-trips. This is what the < 25% p50 gate
 *     is measured against; real cells are I/O-bound.
 *   - Compute (informational): a tight in-realm loop, no ambient. A large
 *     interpreter gap here is expected — cells are not compute kernels.
 *
 * Usage:
 *   bun run scripts/bench-cell-engine.ts [--iterations N] [--warmup N]
 *   bun run scripts/bench-cell-engine.ts --measure   # internal: measures the
 *                                                     # engine from its env
 *
 * Prints a table and the pass/fail verdict against the 25% p50 gate. Does NOT
 * hit any provider API; safe to run offline.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellHost, spawnCellWorkerProcess } from "../src/cell/cell-host.ts";
import { ContentStore } from "../src/store/cas.ts";
import { SessionJournal } from "../src/store/journal.ts";
import { SapStore } from "../src/store/store.ts";
import { DirectStoreAccess } from "../src/store/store-access.ts";
import { StoreWorkerClient, type StoreWorkerHandle } from "../src/store/store-client.ts";
import {
	runStoreWorker,
	STORE_WORKER_CAS_ENV,
	STORE_WORKER_JOURNAL_ENV,
	STORE_WORKER_ROOT_SCOPE_ENV,
} from "../src/store/store-worker.ts";

const args = process.argv.slice(2);
function flag(name: string, fallback: number): number {
	const i = args.indexOf(name);
	if (i === -1 || i + 1 >= args.length) return fallback;
	const v = Number(args[i + 1]);
	return Number.isFinite(v) ? v : fallback;
}

const ITERATIONS = flag("--iterations", 120);
const WARMUP = flag("--warmup", 15);
const P50_GATE = 0.25;
const REAL_STORE = args.includes("--real-store");
const ROOT_SCOPE = "root";
const AGENT_SCOPE = "agent-1";
const WORKER_ENTRY = join(import.meta.dir, "../src/cell/cell-worker.ts");
const STORE_WORKER_ENTRY = join(import.meta.dir, "../src/store/store-worker.ts");

/** The I/O-bound flagship shape: bind, read back, slice, grep, size. */
const IO_CELL = [
	"await bind('notes', 'alpha\\nbeta\\ngamma');",
	"const p = await peek('notes');",
	"const full = await get('notes');",
	"const sliced = await slice('notes', 1, 2);",
	"const g = await grep('notes', 'a$');",
	"const n = await size('notes');",
	"return p.length + ':' + full.length + ':' + sliced.length + ':' + g.matches.length + ':' + n;",
].join("\n");

/** A pure in-realm compute loop, no ambient. */
const COMPUTE_CELL = [
	"let acc = 0;",
	"for (let i = 0; i < 200000; i++) { acc = (acc + i * 31) % 1000003; }",
	"const s = [];",
	"for (let i = 0; i < 2000; i++) s.push(('x' + i).repeat(3));",
	"return acc + ':' + s.join(',').length;",
].join("\n");

/** In-process store worker: a fresh SapStore.resume, serialized per line. */
function inProcessStoreSpawn(journal: SessionJournal, cas: ContentStore): () => StoreWorkerHandle {
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

/** Real store-worker SUBPROCESS (production I/O model), spawned directly. */
function realStoreSpawn(journalPath: string, casRoot: string): () => StoreWorkerHandle {
	return () => {
		const proc = Bun.spawn([process.execPath, STORE_WORKER_ENTRY], {
			env: {
				...process.env,
				[STORE_WORKER_JOURNAL_ENV]: journalPath,
				[STORE_WORKER_CAS_ENV]: casRoot,
				[STORE_WORKER_ROOT_SCOPE_ENV]: ROOT_SCOPE,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		let lineHandler: (line: string) => void = () => {};
		void (async () => {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of proc.stdout) {
				buffered += decoder.decode(chunk, { stream: true });
				let nl = buffered.indexOf("\n");
				while (nl !== -1) {
					lineHandler(buffered.slice(0, nl));
					buffered = buffered.slice(nl + 1);
					nl = buffered.indexOf("\n");
				}
			}
		})();
		return {
			send(line) {
				proc.stdin.write(line);
			},
			kill() {
				proc.kill("SIGKILL");
			},
			onLine(cb) {
				lineHandler = cb;
			},
			onExit() {},
		};
	};
}

async function withHost<T>(fn: (host: CellHost) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "sap-cell-bench-"));
	const journal = new SessionJournal(join(dir, "journal.jsonl"));
	const cas = new ContentStore(join(dir, "cas"));
	const client = new StoreWorkerClient({
		journalPath: join(dir, "journal.jsonl"),
		casRoot: join(dir, "cas"),
		rootScopeId: ROOT_SCOPE,
		opTimeoutMs: 5_000,
		spawnFn: REAL_STORE
			? realStoreSpawn(join(dir, "journal.jsonl"), join(dir, "cas"))
			: inProcessStoreSpawn(journal, cas),
	});
	await client.createScope({
		scopeId: AGENT_SCOPE,
		ownerHandleId: AGENT_SCOPE,
		parentScopeId: ROOT_SCOPE,
	});
	const store = new DirectStoreAccess(client, AGENT_SCOPE);
	// The cell worker is a REAL subprocess; it reads SPROUT_CELL_ENGINE from the
	// inherited env, set by the caller before this runs.
	const host = new CellHost(store, {
		spawnFn: () => spawnCellWorkerProcess([process.execPath, WORKER_ENTRY]),
	});
	try {
		return await fn(host);
	} finally {
		host.shutdown();
		await client.shutdown();
		await rm(dir, { recursive: true, force: true });
	}
}

async function timeRuns(host: CellHost, code: string, n: number, warmup: number) {
	for (let i = 0; i < warmup; i++) {
		const r = await host.runCell(code);
		if (!r.ok) throw new Error(`bench cell failed: ${r.error?.message}`);
	}
	const samples: number[] = [];
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		const r = await host.runCell(code);
		samples.push(performance.now() - t0);
		if (!r.ok) throw new Error(`bench cell failed: ${r.error?.message}`);
	}
	samples.sort((a, b) => a - b);
	return {
		p50: samples[Math.floor(n * 0.5)],
		p90: samples[Math.floor(n * 0.9)],
		mean: samples.reduce((a, b) => a + b, 0) / n,
	};
}

type Stats = { p50: number; p90: number; mean: number };
type Measurement = { engine: string; io: Stats; compute: Stats };

/** --measure mode: one process = one engine (from its startup env). */
async function measureOne(): Promise<void> {
	const engine = process.env.SPROUT_CELL_ENGINE ?? "vm";
	const io = await withHost((host) => timeRuns(host, IO_CELL, ITERATIONS, WARMUP));
	const compute = await withHost((host) => timeRuns(host, COMPUTE_CELL, ITERATIONS, WARMUP));
	const measurement: Measurement = { engine, io, compute };
	console.log(`__MEASUREMENT__${JSON.stringify(measurement)}`);
}

/** Re-exec this script with SPROUT_CELL_ENGINE in explicit spawn env. */
async function measureEngine(engine: "vm" | "quickjs"): Promise<Measurement> {
	const proc = Bun.spawn([process.execPath, import.meta.path, "--measure", ...args], {
		stdout: "pipe",
		stderr: "inherit",
		env: { ...process.env, SPROUT_CELL_ENGINE: engine },
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	const line = out.split("\n").find((l) => l.startsWith("__MEASUREMENT__"));
	if (!line) throw new Error(`no measurement from ${engine} child:\n${out}`);
	return JSON.parse(line.slice("__MEASUREMENT__".length)) as Measurement;
}

function report(label: string, vm: Stats, qjs: Stats): number {
	const p50Regression = (qjs.p50 - vm.p50) / vm.p50;
	console.log(`\n${label}`);
	console.log("  engine    p50(ms)   p90(ms)  mean(ms)");
	console.log(
		`  vm       ${vm.p50.toFixed(3).padStart(8)} ${vm.p90.toFixed(3).padStart(8)} ${vm.mean.toFixed(3).padStart(8)}`,
	);
	console.log(
		`  quickjs  ${qjs.p50.toFixed(3).padStart(8)} ${qjs.p90.toFixed(3).padStart(8)} ${qjs.mean.toFixed(3).padStart(8)}`,
	);
	console.log(`  p50 regression: ${(p50Regression * 100).toFixed(1)}%`);
	return p50Regression;
}

if (args.includes("--measure")) {
	await measureOne();
	process.exit(0);
}

console.log(
	`cell-engine benchmark — iterations=${ITERATIONS} warmup=${WARMUP} (real worker subprocess + real store)`,
);
const vm = await measureEngine("vm");
const qjs = await measureEngine("quickjs");
const ioRegression = report("I/O-bound (GATE, sap flagship shape)", vm.io, qjs.io);
report("Compute (informational — cells are not compute kernels)", vm.compute, qjs.compute);

console.log(`\n${"=".repeat(52)}`);
const pass = ioRegression < P50_GATE;
console.log(
	`GATE: I/O-bound p50 regression ${(ioRegression * 100).toFixed(1)}% ${pass ? "<" : "≥"} 25% → ${pass ? "PASS" : "FAIL"}`,
);
process.exit(pass ? 0 : 1);
