import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";
import {
	AgentSpawner,
	type FeatherweightFn,
	type SpawnAgentOptions,
} from "../../src/bus/spawner.ts";
import type { ResultMessage } from "../../src/bus/types.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import type { StoreAccess, StoreBindInput } from "../../src/store/store-access.ts";
import { addr } from "../helpers/agent-address.ts";

/**
 * The capture-all structural wins (spec v10 P2 measurement), asserted as
 * payload-byte facts that do not depend on model quality:
 *
 * 1. N-way fan-out: every child's full answer lands in the store; the
 *    orchestrator's payload holds N budget-sized previews + refs, not N full
 *    answers — the wall that made deep orchestration collapse is gone.
 * 2. Tool mode: a large read with capture on puts ~budget bytes in the
 *    payload where capture off puts today's full truncation limit.
 */

function fakeStore() {
	const bound: Array<{ name: string; content: string }> = [];
	const store = {
		bound,
		async bind(args: StoreBindInput) {
			const content =
				typeof args.content === "string" ? args.content : new TextDecoder().decode(args.content);
			bound.push({ name: args.name, content });
			return {
				ulid: `ulid_${bound.length}`,
				name: args.name,
				scopeId: "parent",
				type: args.type,
				size: content.length,
				provenance: args.provenance,
				preview: "",
				createdAt: 1,
			};
		},
		async publish() {},
	} as unknown as StoreAccess & { bound: Array<{ name: string; content: string }> };
	return store;
}

describe("capture-all structural advantage (e2e)", () => {
	let server: BusServer;
	let bus: BusClient;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-capture-adv-"));
		server = new BusServer({ port: 0 });
		await server.start();
		bus = new BusClient(server.url);
		await bus.connect();
	});

	afterEach(async () => {
		await bus.disconnect();
		await server.stop();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("8-way fan-out keeps the orchestrator payload flat: previews + refs inline, full answers in the store", async () => {
		const store = fakeStore();
		const FAN_OUT = 8;
		const answerFor = (goal: string) => `${goal} verdict first\n${"detail ".repeat(3_000)}`;
		const fn: FeatherweightFn = async (input) => ({
			output: answerFor(input.goal),
			success: true,
			stumbles: 0,
			turns: 1,
			timed_out: false,
		});
		const spawner = new AgentSpawner(
			bus,
			server.url,
			"capture-adv-session",
			undefined,
			undefined,
			undefined,
			{ store } as unknown as ConstructorParameters<typeof AgentSpawner>[6],
			fn,
		);

		const results: ResultMessage[] = [];
		for (let i = 0; i < FAN_OUT; i++) {
			const opts: SpawnAgentOptions = {
				agentName: "analyst",
				genomePath: join(tempDir, "genome"),
				projectDataDir: join(tempDir, "data"),
				caller: addr("root", 0),
				goal: `analyze shard ${i}`,
				blocking: true,
				shared: false,
				workDir: tempDir,
				featherweight: true,
			};
			results.push((await spawner.spawnAgent(opts)) as ResultMessage);
		}

		// Every full answer is in the store — nothing was destroyed.
		expect(store.bound).toHaveLength(FAN_OUT);
		for (let i = 0; i < FAN_OUT; i++) {
			expect(store.bound[i]!.content).toBe(answerFor(`analyze shard ${i}`));
		}
		// The orchestrator-facing payload is FLAT: each result is a bounded
		// preview + ref, so the total stays ~N × budget instead of N × answer.
		const inlineBytes = results.reduce((sum, r) => sum + r.output.length, 0);
		const rawBytes = Array.from({ length: FAN_OUT }, (_, i) =>
			answerFor(`analyze shard ${i}`),
		).reduce((sum, a) => sum + a.length, 0);
		for (const r of results) {
			expect(r.output.length).toBeLessThanOrEqual(4_000);
			expect(r.output).toMatch(/full content: ⟦analyze_shard_\d+_result/);
		}
		expect(inlineBytes).toBeLessThan(rawBytes / 5);
	});

	test("tool mode: capture on puts ~budget bytes in the payload; capture off puts today's limit", async () => {
		const bigLog = Array.from({ length: 2_000 }, (_, i) => `line ${i} request served ok`).join("\n");
		await writeFile(join(tempDir, "server.log"), bigLog);
		const env = new LocalExecutionEnvironment(tempDir);

		const withStore = createPrimitiveRegistry(env);
		const store = fakeStore();
		withStore.setCaptureStore?.(store);
		const on = await withStore.execute("read_file", { path: "server.log" });

		const withoutStore = createPrimitiveRegistry(env);
		const off = await withoutStore.execute("read_file", { path: "server.log" });

		// Capture on: bounded preview + ref, full raw source in the store.
		expect(on.output.length).toBeLessThan(5_000);
		expect(on.output).toMatch(/full content: ⟦read_file_output⟧/);
		expect(store.bound[0]!.content).toBe(bigLog);
		// Capture off: today's limits — an order of magnitude more payload.
		expect(off.output.length).toBeGreaterThan(on.output.length * 5);
	});
});
