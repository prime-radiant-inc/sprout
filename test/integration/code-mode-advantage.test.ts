import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellHost, spawnCellWorkerProcess } from "../../src/cell/cell-host";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env";
import { createPrimitiveRegistry } from "../../src/kernel/primitives";
import { ContentStore } from "../../src/store/cas";
import { SessionJournal } from "../../src/store/journal";
import { SapStore } from "../../src/store/store";
import { DirectStoreAccess, type StoreAccess } from "../../src/store/store-access";
import { StoreWorkerClient, type StoreWorkerHandle } from "../../src/store/store-client";
import { runStoreWorker } from "../../src/store/store-worker";

/**
 * E2E scenario tests for the cases where code mode (the sap data plane —
 * cell/code-mode, capture, $ref splice) is a MASSIVE, structural improvement
 * over the traditional tool-use agent — NOT a marginal quality edge.
 *
 * These properties do not depend on model quality: they are how the data plane
 * moves bytes. Each scenario runs BOTH the code-mode path (real cell worker +
 * real store) and the traditional path (the real read_file primitive) over the
 * SAME data, and asserts the observable difference in what crosses to the model
 * (the transcript-facing bytes = the provider payload).
 */

const ROOT_SCOPE = "root";
const AGENT_SCOPE = "agent-1";
const WORKER_ENTRY = join(import.meta.dir, "../../src/cell/cell-worker.ts");
const spawnRealWorker = () => spawnCellWorkerProcess([process.execPath, WORKER_ENTRY]);

describe("code mode vs traditional — structural improvements (e2e)", () => {
	let dir: string;
	let journal: SessionJournal;
	let cas: ContentStore;
	let client: StoreWorkerClient;
	let store: StoreAccess;
	let host: CellHost | undefined;

	function inProcessStoreSpawn(): () => StoreWorkerHandle {
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
		dir = await mkdtemp(join(tmpdir(), "sap-code-mode-adv-"));
		journal = new SessionJournal(join(dir, "journal.jsonl"));
		cas = new ContentStore(join(dir, "cas"));
		client = new StoreWorkerClient({
			journalPath: join(dir, "journal.jsonl"),
			casRoot: join(dir, "cas"),
			rootScopeId: ROOT_SCOPE,
			opTimeoutMs: 5_000,
			spawnFn: inProcessStoreSpawn(),
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

	/** The full transcript-facing surface of a cell run: what the model sees. */
	function transcriptBytes(result: {
		output: string;
		returnValue?: string;
		error?: { message: string };
	}): string {
		return `${result.output}\n${result.returnValue ?? ""}\n${result.error?.message ?? ""}`;
	}

	it("SCENARIO 1 — processing a large document: code mode returns a tiny answer; traditional floods the model with the whole file", async () => {
		// A ~100 KB log. In sap it is a captured store value; on disk it is a file
		// the traditional agent would read_file.
		const bigLog = Array.from({ length: 4000 }, (_, i) =>
			i % 50 === 0 ? `line ${i} ERROR disk full` : `line ${i} ok request served`,
		).join("\n");
		expect(bigLog.length).toBeGreaterThan(100_000);
		await store.bind({
			name: "server_log",
			content: bigLog,
			type: "text",
			provenance: { agentHandleId: AGENT_SCOPE, origin: { kind: "primitive", name: "read_file" } },
			explicit: true,
		});
		await writeFile(join(dir, "server_log.txt"), bigLog);

		// CODE MODE: the cell reads the whole log in-realm, counts errors, returns 1 number.
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const codeMode = await host.runCell(
			"const log = await get('server_log');" +
				"const errors = log.split('\\n').filter((l) => l.includes('ERROR')).length;" +
				"return 'error lines: ' + errors;",
		);
		expect(codeMode.ok).toBe(true);
		expect(codeMode.returnValue).toBe("error lines: 80");
		const codeModeBytes = transcriptBytes(codeMode).length;

		// TRADITIONAL: read_file returns the file content into the tool result — the
		// model sees (a large chunk of) the whole file to do the same count.
		const env = new LocalExecutionEnvironment(dir);
		const registry = createPrimitiveRegistry(env);
		const readResult = await registry.execute("read_file", { path: "server_log.txt" });
		const traditionalBytes = readResult.output.length;

		// The massive improvement: code mode's model-facing bytes are a rounding
		// error next to the traditional read, and the log body never crossed.
		expect(codeModeBytes).toBeLessThan(200);
		expect(traditionalBytes).toBeGreaterThan(codeModeBytes * 20);
		expect(transcriptBytes(codeMode)).not.toContain("request served");
		expect(readResult.output).toContain("request served");
	}, 20_000);

	it("SCENARIO 2 — relaying confidential content: code mode moves it store→store and never exposes it; traditional puts it in the model payload (redaction can't catch it)", async () => {
		// Confidential business content that pattern-based redaction does NOT catch
		// (it is not an API-key/token shape). Redaction is incomplete; the sap data
		// plane is content-agnostic — it keeps ALL captured bytes out of the payload.
		const confidential =
			"BOARD-EYES-ONLY: Q3 revenue 4.2M, net margin 38.1 percent, monthly churn 2.1 percent; " +
			"acquisition of Northwind pending at 61M; layoffs of 12 percent planned for January.";
		await store.bind({
			name: "board_memo",
			content: confidential,
			type: "text",
			provenance: { agentHandleId: AGENT_SCOPE, origin: { kind: "primitive", name: "read_file" } },
			explicit: true,
		});
		await writeFile(join(dir, "board_memo.txt"), confidential);

		// CODE MODE: the cell relays the captured memo to a new binding and returns
		// only a confirmation. The confidential bytes flow source→store→store; the
		// model-facing transcript never contains them.
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		const codeMode = await host.runCell(
			"const memo = await get('board_memo');" +
				"await bind('memo_copy', memo);" +
				"return 'relayed ' + memo.length + ' bytes';",
		);
		expect(codeMode.ok).toBe(true);
		expect(codeMode.returnValue).toBe(`relayed ${confidential.length} bytes`);
		// The destination holds the real memo (proves the relay actually happened)...
		const readBack = await host.runCell("return await get('memo_copy');");
		expect(readBack.returnValue).toBe(confidential);
		// ...yet the confidential body NEVER appeared in anything the model would see.
		expect(transcriptBytes(codeMode)).not.toContain("Northwind");
		expect(transcriptBytes(codeMode)).not.toContain("churn");

		// TRADITIONAL: read_file returns the memo verbatim into the tool result —
		// redaction does not recognize it, so it rides the very next provider payload.
		const env = new LocalExecutionEnvironment(dir);
		const registry = createPrimitiveRegistry(env);
		const readResult = await registry.execute("read_file", { path: "board_memo.txt" });
		expect(readResult.output).toContain("Northwind");
		expect(readResult.output).toContain("churn");
	}, 20_000);

	it("SCENARIO 3 — a cell that produces a large result auto-captures: the model gets a ~2 KB marker, the full value stays in the store", async () => {
		host = new CellHost(store, { spawnFn: spawnRealWorker });
		// A cell that generates a large artifact (e.g. a rendered report) and returns
		// it. The transcript gate auto-binds it and hands the model a marker.
		const result = await host.runCell(
			"return Array.from({ length: 3000 }, (_, i) => 'row ' + i + ' value ' + (i * 7)).join('\\n');",
		);
		expect(result.ok).toBe(true);
		const rv = result.returnValue ?? "";
		// The model-facing return is bounded (marker), NOT the full artifact.
		expect(rv.length).toBeLessThan(2_500);
		expect(rv).toContain("full content:");
		// The auto-bound value's name is in the ⟦marker⟧; the full artifact is
		// retrievable in full from the store.
		const markerMatch = rv.match(/⟦([^⟧]+)⟧/);
		expect(markerMatch).not.toBeNull();
		const markerName = markerMatch?.[1];
		// The store holds the FULL artifact: a cell that fetches it materializes all
		// of it (returning its length proves the bytes are intact; returning the
		// content itself would simply re-gate to another marker — that IS the point).
		const full = await host.runCell(
			`const v = await get(${JSON.stringify(markerName)}); return String(v.length) + ':' + v.includes('row 2999 value 20993');`,
		);
		const [len, hasTail] = (full.returnValue ?? "0:false").split(":");
		expect(Number(len)).toBeGreaterThan(30_000);
		expect(hasTail).toBe("true");
	}, 20_000);
});
