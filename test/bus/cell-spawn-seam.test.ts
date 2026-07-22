/**
 * Full cell-spawn seam (sap spec §4, Slice B): an owning agent's cell code
 * calls the ambient spawn(), which routes through the agent's delegation core
 * into a REAL AgentSpawner running an in-process child agent process, and the
 * child's result threads back into the cell as the spawn contract's envelope.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { runAgentProcess } from "../../src/bus/agent-process.ts";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";
import { AgentSpawner } from "../../src/bus/spawner.ts";
import { spawnCellWorkerProcess } from "../../src/cell/worker-process.ts";
import { Genome } from "../../src/genome/genome.ts";
import { AuthChannelServer } from "../../src/host/auth-channel.ts";
import {
	HostHandleRegistrar,
	makeRegisterHandleHandler,
	REGISTER_HANDLE_REQUEST,
	TRUSTED_REGISTRAR_ID,
} from "../../src/host/handle-registrar.ts";
import { HandleRegistry } from "../../src/host/handle-registry.ts";
import {
	LIVENESS_REQUEST,
	makeLivenessHandler,
	makePingHandler,
	PING_REQUEST,
} from "../../src/host/liveness.ts";
import { registerStoreHandlers } from "../../src/host/store-channel.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Response } from "../../src/llm/types.ts";
import { ContentKind, Msg } from "../../src/llm/types.ts";
import { ContentStore } from "../../src/store/cas.ts";
import { SessionJournal } from "../../src/store/journal.ts";
import { SapStore } from "../../src/store/store.ts";
import { DirectStoreAccess } from "../../src/store/store-access.ts";
import { StoreWorkerClient } from "../../src/store/store-client.ts";
import { runStoreWorker } from "../../src/store/store-worker.ts";

const SESSION_ID = "cell-spawn-seam-session";
const ROOT_SCOPE = "root";
const TEST_PROVIDER_ID = "anthropic";
const TEST_MODEL_ID = "claude-haiku-4-5-20251001";
const WORKER_ENTRY = join(import.meta.dir, "../../src/cell/cell-worker.ts");

const RESOLVER_SETTINGS = createResolverSettings([{ id: TEST_PROVIDER_ID, enabled: true }], {
	best: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODEL_ID },
	balanced: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODEL_ID },
	fast: { providerId: TEST_PROVIDER_ID, modelId: TEST_MODEL_ID },
});

const LEAF_SPEC = {
	name: "test-leaf",
	description: "A minimal test agent",
	model: "best",
	tools: ["read_file"],
	agents: [],
	constraints: {
		max_turns: 5,
		timeout_ms: 30000,
		can_spawn: false,
		can_learn: false,
	},
	tags: ["test"],
	version: 1,
	system_prompt: "You are a test agent. Respond with a brief answer.",
};

const OWNER_SPEC: AgentSpec = {
	name: "cell-owner",
	description: "Owns a cell that spawns",
	system_prompt: "You are a test agent.",
	model: "best",
	tools: [],
	agents: ["test-leaf"],
	constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: true, max_turns: 5 },
	tags: [],
	version: 1,
};

function leafClient(text: string): Client {
	const response: Response = {
		id: "leaf-1",
		model: TEST_MODEL_ID,
		provider: TEST_PROVIDER_ID,
		message: Msg.assistant(text),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
	};
	return {
		complete: async () => response,
		stream: async function* () {
			yield { type: "stream_start" as const };
			yield { type: "text_start" as const };
			yield { type: "text_delta" as const, delta: text };
			yield { type: "text_end" as const };
			yield {
				type: "finish" as const,
				finish_reason: response.finish_reason,
				usage: response.usage,
				response,
			};
		},
		providers: () => [TEST_PROVIDER_ID],
		adapter: () => ({ kind: "anthropic" }),
	} as unknown as Client;
}

function ownerClient(code: string): Client {
	let calls = 0;
	return {
		providers: () => [TEST_PROVIDER_ID],
		complete: async (): Promise<Response> => {
			calls++;
			if (calls === 1) {
				return {
					id: "owner-1",
					model: TEST_MODEL_ID,
					provider: TEST_PROVIDER_ID,
					message: {
						role: "assistant",
						content: [
							{
								kind: ContentKind.TOOL_CALL,
								tool_call: {
									id: "call-cell-seam",
									name: "cell",
									arguments: JSON.stringify({ code }),
								},
							},
						],
					},
					finish_reason: { reason: "tool_calls" },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			}
			return {
				id: `owner-${calls}`,
				model: TEST_MODEL_ID,
				provider: TEST_PROVIDER_ID,
				message: Msg.assistant("Done."),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			};
		},
		stream: async function* () {},
	} as unknown as Client;
}

describe("cell spawn seam (real spawner, in-process child)", () => {
	let tempDir: string;
	let genomeDir: string;
	let server: BusServer;
	let bus: BusClient;
	let authServer: AuthChannelServer;
	let storeClient: StoreWorkerClient;
	let spawner: AgentSpawner;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-cell-seam-"));
		genomeDir = join(tempDir, "genome");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.addAgent(LEAF_SPEC as any);

		server = new BusServer({ port: 0 });
		await server.start();
		bus = new BusClient(server.url);
		await bus.connect();

		const registry = new HandleRegistry({ trustedRegistrarId: TRUSTED_REGISTRAR_ID });
		authServer = new AuthChannelServer({ port: 0, hostname: "127.0.0.1", registry });
		await authServer.start();
		authServer.onRequest(REGISTER_HANDLE_REQUEST, makeRegisterHandleHandler(registry));
		authServer.onRequest(PING_REQUEST, makePingHandler(registry));
		authServer.onRequest(LIVENESS_REQUEST, makeLivenessHandler(registry));

		const journalPath = join(tempDir, "store", "journal.jsonl");
		const casRoot = join(tempDir, "store", "cas");
		storeClient = new StoreWorkerClient({
			journalPath,
			casRoot,
			rootScopeId: ROOT_SCOPE,
			// In-process store worker over the real temp store.
			spawnFn: () => {
				let lineHandler: (line: string) => void = () => {};
				const storeReady = SapStore.resume({
					journal: new SessionJournal(journalPath),
					cas: new ContentStore(casRoot),
					rootScopeId: ROOT_SCOPE,
				});
				let queue = Promise.resolve();
				return {
					send(line: string) {
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
					onLine(cb: (line: string) => void) {
						lineHandler = cb;
					},
					onExit() {},
				};
			},
		});
		registerStoreHandlers(authServer, storeClient, {
			rootScopeId: ROOT_SCOPE,
			handleOwner: (id) => registry.get(id)?.ownerId,
		});

		const childClient = leafClient("leaf says hi");
		spawner = new AgentSpawner(
			bus,
			server.url,
			SESSION_ID,
			(_handleId, env) => {
				const controller = new AbortController();
				const promise = runAgentProcess({
					busUrl: env.SPROUT_BUS_URL!,
					handleId: env.SPROUT_HANDLE_ID!,
					sessionId: env.SPROUT_SESSION_ID!,
					genomePath: env.SPROUT_GENOME_PATH!,
					client: childClient,
					workDir: env.SPROUT_WORK_DIR!,
					...(env.SPROUT_AUTH_URL && env.SPROUT_HANDLE_TOKEN
						? { authChannel: { url: env.SPROUT_AUTH_URL, token: env.SPROUT_HANDLE_TOKEN } }
						: {}),
					signal: controller.signal,
				});
				return { kill: () => controller.abort(), exited: promise.then(() => 0) };
			},
			undefined,
			undefined,
			{
				url: authServer.url,
				registrar: new HostHandleRegistrar(registry, TRUSTED_REGISTRAR_ID),
				store: new DirectStoreAccess(storeClient, ROOT_SCOPE),
			},
		);
	});

	afterEach(async () => {
		await spawner?.shutdown();
		if (spawner) {
			const exits = spawner
				.getHandles()
				.map((id) => spawner.getHandle(id)?.process.exited)
				.filter(Boolean);
			await Promise.allSettled(exits);
		}
		await bus.disconnect();
		await server.stop();
		await storeClient.shutdown();
		await authServer.stop();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("cell code spawns a real child and binds its summary", async () => {
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tempDir);
		const agent = new Agent({
			spec: OWNER_SPEC,
			env,
			client: ownerClient(
				'const r = await spawn("test-leaf", "leaf goal"); await bind("child_summary", r.summary); return r.ok;',
			),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [OWNER_SPEC, LEAF_SPEC as unknown as AgentSpec],
			depth: 0,
			events,
			spawner,
			genomePath: genomeDir,
			resolverSettings: RESOLVER_SETTINGS,
			cellWorkerSpawnFn: () => spawnCellWorkerProcess([process.execPath, WORKER_ENTRY]),
		});

		const result = await agent.run("seam test");
		expect(result.success).toBe(true);
		expect(result.stumbles).toBe(0);

		const primitiveEnd = events
			.collected()
			.find((e) => e.kind === "primitive_end" && e.data.name === "cell");
		expect(primitiveEnd?.data.success).toBe(true);
		expect(String(primitiveEnd?.data.output)).toContain("return: true");
		expect(String(primitiveEnd?.data.output)).toContain("bound: ⟦child_summary⟧");

		// The act events carry the cell-spawn marker and the deterministic name.
		const actStart = events.collected().find((e) => e.kind === "act_start");
		const actEnd = events.collected().find((e) => e.kind === "act_end");
		expect(actStart?.data.cell_spawn).toBe(true);
		expect(actStart?.data.mnemonic_name).toBe("leaf-goal_1");
		expect(actEnd?.data.cell_spawn).toBe(true);
		expect(actEnd?.data.tool_result_message).toBeUndefined();

		// The bound value holds the child's real output.
		const store = new DirectStoreAccess(storeClient, ROOT_SCOPE);
		const bound = new TextDecoder().decode(await store.get("child_summary", { maxBytes: 10_000 }));
		expect(bound).toContain("leaf says hi");
	}, 30_000);
});
