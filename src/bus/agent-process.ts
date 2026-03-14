import { join } from "node:path";
import { Agent } from "../agents/agent.ts";
import { AgentEventEmitter } from "../agents/events.ts";
import { loadPreambles, scanAgentTree } from "../agents/loader.ts";
import { renderCallerIdentity } from "../agents/plan.ts";
import { loadProjectDocs } from "../agents/project-doc.ts";
import { Genome } from "../genome/genome.ts";
import { createReadOnlyGenome } from "../genome/read-only-genome.ts";
import { SessionLogger } from "../host/logger.ts";
import { importSettingsFromEnv } from "../host/settings/env-import.ts";
import {
	createSecretStoreRuntime,
	type SecretStoreRuntime,
} from "../host/settings/secret-store.ts";
import { type SettingsLoadResult, SettingsStore } from "../host/settings/store.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import { Client } from "../llm/client.ts";
import { loggingMiddleware } from "../llm/logging-middleware.ts";
import { ProviderRegistry, type ProviderRegistryEntry } from "../llm/provider-registry.ts";
import type { ProviderAdapter } from "../llm/types.ts";
import { ensureProjectDirs } from "../util/project-id.ts";
import { BusClient } from "./client.ts";
import { BusLearnForwarder } from "./learn-forwarder.ts";
import { replayHandleLog } from "./resume.ts";
import { AgentSpawner } from "./spawner.ts";
import { agentEvents, agentInbox, agentReady, agentResult, sessionEvents } from "./topics.ts";
import type { ContinueMessage, EventMessage, ResultMessage, StartMessage } from "./types.ts";
import { parseBusMessage } from "./types.ts";

export interface AgentProcessConfig {
	/** WebSocket URL of the bus server */
	busUrl: string;
	/** Unique handle ID for this agent process */
	handleId: string;
	/** Session ID this agent belongs to */
	sessionId: string;
	/** Path to the genome directory */
	genomePath: string;
	/** Pre-configured LLM client */
	client: Client;
	/** Working directory for the agent */
	workDir: string;
	/** Path to root agent directory (for overlay resolution and preambles). */
	rootDir?: string;
	/** Per-project data directory (sessions, logs, memory). Defaults to genomePath. */
	projectDataDir?: string;
	/** Abort signal for clean shutdown */
	signal?: AbortSignal;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("../host/logger.ts").Logger;
}

interface AgentProcessClientDeps {
	createSettingsStore?: () => Pick<SettingsStore, "load">;
	createSecretStoreRuntime?: () => SecretStoreRuntime;
	importSettingsFromEnv?: typeof importSettingsFromEnv;
	createProviderRegistry?: (options: ConstructorParameters<typeof ProviderRegistry>[0]) => {
		getEntries(): Promise<ProviderRegistryEntry[]>;
	};
	createClient?: (options: {
		providers: Record<string, ProviderAdapter>;
		logger: SessionLogger;
	}) => Client;
}

export async function createAgentProcessClient(
	logger: SessionLogger,
	deps: AgentProcessClientDeps = {},
): Promise<Client> {
	const settingsStore = deps.createSettingsStore?.() ?? new SettingsStore();
	const settingsLoadResult = (await settingsStore.load()) as SettingsLoadResult;
	const secretStoreRuntime =
		deps.createSecretStoreRuntime?.() ?? createSecretStoreRuntime({ env: process.env });
	const importFromEnv = deps.importSettingsFromEnv ?? importSettingsFromEnv;
	let settings = settingsLoadResult.settings;
	if (settingsLoadResult.source === "missing") {
		const imported = await importFromEnv({
			env: process.env,
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
		});
		if (imported.settings.providers.length > 0) {
			settings = imported.settings;
		}
	}
	const registry =
		deps.createProviderRegistry?.({
			settings,
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
			secretBackendState: secretStoreRuntime.secretBackendState,
		}) ??
		new ProviderRegistry({
			settings,
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
			secretBackendState: secretStoreRuntime.secretBackendState,
		});

	const providers: Record<string, ProviderAdapter> = {};
	for (const entry of await registry.getEntries()) {
		if (!entry.provider.enabled || entry.validationErrors.length > 0 || !entry.adapter) {
			continue;
		}
		providers[entry.provider.id] = entry.adapter;
	}

	return (
		deps.createClient?.({ providers, logger }) ??
		Client.fromProviders(providers, {
			middleware: [loggingMiddleware(logger)],
		})
	);
}

/**
 * Run an agent process that connects to the bus, waits for a start message,
 * runs the agent loop, publishes results, and handles continue messages.
 *
 * Lifecycle:
 * 1. Connect to bus, subscribe to inbox
 * 2. Wait for a start message
 * 3. Load genome, create Agent, run agent loop
 * 4. Publish result to the agent's result topic
 * 5. If shared: stay in idle, handle continue messages
 * 6. If not shared: disconnect and return
 * 7. On abort signal: disconnect and return at any point
 */
export async function runAgentProcess(config: AgentProcessConfig): Promise<void> {
	const { busUrl, handleId, sessionId, genomePath, client, workDir, signal } = config;

	// Connect to bus
	const bus = new BusClient(busUrl);
	await bus.connect();

	const inboxTopic = agentInbox(sessionId, handleId);
	const eventsTopic = agentEvents(sessionId, handleId);
	const resultTopic = agentResult(sessionId, handleId);
	const readyTopic = agentReady(sessionId, handleId);

	let childSpawner: AgentSpawner | undefined;

	try {
		// Subscribe to inbox and wait for start (or abort)
		const startPayload = await waitForStartWithReady(bus, inboxTopic, readyTopic, handleId, signal);
		if (!startPayload) {
			// Aborted before receiving start
			return;
		}

		const startMsg = parseBusMessage(startPayload) as StartMessage;
		const evalMode = startMsg.eval_mode === true;

		// Load genome and find agent spec
		const genome = new Genome(genomePath, config.rootDir);
		await genome.loadFromDisk();
		const runtimeGenome = evalMode ? createReadOnlyGenome(genome) : genome;

		const loadedSpec = runtimeGenome.getAgent(startMsg.agent_name);
		if (!loadedSpec) {
			// Publish error result and exit
			const errorResult: ResultMessage = {
				kind: "result",
				handle_id: handleId,
				output: `Agent '${startMsg.agent_name}' not found in genome`,
				success: false,
				stumbles: 0,
				turns: 0,
				timed_out: false,
			};
			await bus.publish(resultTopic, JSON.stringify(errorResult));
			return;
		}

		// Shallow-copy the spec so we don't mutate the genome's in-memory data
		const agentSpec = { ...loadedSpec };

		// Inject caller identity into the agent's system prompt
		agentSpec.system_prompt += renderCallerIdentity(startMsg.caller);

		// Wire up the agent
		const env = new LocalExecutionEnvironment(workDir);
		const registry = createPrimitiveRegistry(env, undefined, { evalMode });
		const events = new AgentEventEmitter();
		const preambles = config.rootDir ? await loadPreambles(config.rootDir) : undefined;
		const projectDocs = await loadProjectDocs({ cwd: workDir });
		const genomePostscripts = await runtimeGenome.loadPostscripts();
		const dataDir = config.projectDataDir ?? genomePath;
		await ensureProjectDirs(dataDir);
		const logBasePath = join(dataDir, "logs", sessionId, handleId);

		// Check for a prior log — if this handle ran before, replay its history
		const priorLogPath = `${logBasePath}.jsonl`;
		const initialHistory = await replayHandleLog(priorLogPath);

		// Forward agent events to the bus (best-effort; ignore if disconnected).
		// Publishes to both the per-handle topic (for spawner result tracking)
		// and the session-wide topic (so the UI sees events at any depth without
		// needing a relay chain through intermediate spawners).
		const sessionEventsTopic = sessionEvents(sessionId);
		events.on((event) => {
			if (!bus.connected) return;
			const eventMsg: EventMessage = {
				kind: "event",
				handle_id: handleId,
				event,
			};
			const payload = JSON.stringify(eventMsg);
			bus.publish(eventsTopic, payload);
			bus.publish(sessionEventsTopic, payload);
		});

		// Create a spawner so this agent can delegate to other agents via the bus
		childSpawner = new AgentSpawner(bus, busUrl, sessionId);

		// Wire learn signal forwarding for agents that can learn
		const learnProcess =
			!evalMode && agentSpec.constraints.can_learn
				? new BusLearnForwarder(bus, sessionId)
				: undefined;

		// Build agent tree so bus-spawned agents can resolve their child agents
		// (e.g., tech-lead needs to discover engineer, spec-reviewer, quality-reviewer)
		const agentTree = config.rootDir ? await scanAgentTree(config.rootDir) : undefined;
		const agentName = agentSpec.name;
		// Find this agent's path in the tree to determine its children
		let agentTreeSelfPath: string | undefined;
		let agentTreeChildren: string[] | undefined;
		if (agentTree) {
			for (const [path, entry] of agentTree) {
				if (entry.spec.name === agentName) {
					agentTreeSelfPath = path;
					agentTreeChildren = entry.children;
					break;
				}
			}
		}

		const agent = new Agent({
			spec: agentSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: runtimeGenome.allAgents(),
			genome: runtimeGenome,
			events,
			sessionId,
			depth: startMsg.caller.depth + 1,
			logBasePath,
			preambles,
			projectDocs,
			genomePostscripts,
			spawner: childSpawner,
			genomePath,
			projectDataDir: config.projectDataDir,
			learnProcess,
			initialHistory: initialHistory.length > 0 ? initialHistory : undefined,
			agentId: startMsg.agent_id,
			evalMode,
			providerIdOverride: startMsg.provider_id,
			resolverSettings: startMsg.resolver_settings,
			logger: config.logger,
			rootDir: config.rootDir,
			agentTree,
			agentTreeChildren,
			agentTreeSelfPath,
			enableStreaming: true,
		});

		// Build goal with hints
		let goal = startMsg.goal;
		if (startMsg.hints && startMsg.hints.length > 0) {
			goal += `\n\nHints:\n${startMsg.hints.map((h) => `- ${h}`).join("\n")}`;
		}

		// Forward steer messages from the inbox to the agent during the initial run.
		// The idleLoop handles steers for shared agents after run() completes,
		// but during the initial run() this is the only path for steers.
		let initialRunActive = true;
		if (bus.connected) {
			await bus.subscribe(inboxTopic, (payload) => {
				if (!initialRunActive) return;
				try {
					const msg = parseBusMessage(payload);
					if (msg.kind === "steer") {
						agent.steer(msg.message);
					}
				} catch {
					// Ignore malformed messages
				}
			});
		}

		// Run the agent
		let agentResult_: Awaited<ReturnType<typeof agent.run>>;
		try {
			agentResult_ = await agent.run(goal, signal);
		} catch (err) {
			initialRunActive = false;
			// Publish a failed result so the parent spawner doesn't hang waiting.
			if (bus.connected) {
				const errorResult: ResultMessage = {
					kind: "result",
					handle_id: handleId,
					output: `Initial run failed: ${err instanceof Error ? err.message : String(err)}`,
					success: false,
					stumbles: 0,
					turns: 0,
					timed_out: false,
				};
				await bus.publish(resultTopic, JSON.stringify(errorResult));
			}
			return;
		}
		initialRunActive = false;

		// Publish result (may fail if bus disconnected during shutdown)
		const resultMsg: ResultMessage = {
			kind: "result",
			handle_id: handleId,
			output: agentResult_.output,
			success: agentResult_.success,
			stumbles: agentResult_.stumbles,
			turns: agentResult_.turns,
			timed_out: agentResult_.timed_out,
		};
		if (!bus.connected) return;
		await bus.publish(resultTopic, JSON.stringify(resultMsg));

		// If not shared, we're done
		if (!startMsg.shared) {
			return;
		}

		// Shared agent: enter idle loop, handle continue messages.
		// Signal is required for shared agents — without it, idleLoop hangs forever.
		if (!signal) {
			throw new Error("Shared agents require an AbortSignal to exit the idle loop");
		}
		await idleLoop(bus, agent, genome, inboxTopic, resultTopic, handleId, signal);
	} finally {
		childSpawner?.shutdown();
		await bus.disconnect();
	}
}

/**
 * Subscribe to inbox (awaiting server ack), publish ready signal,
 * then wait for a start message.
 * Returns the raw payload, or null if aborted before receiving one.
 */
async function waitForStartWithReady(
	bus: BusClient,
	inboxTopic: string,
	readyTopic: string,
	handleId: string,
	signal?: AbortSignal,
): Promise<string | null> {
	if (signal?.aborted) return null;

	let resolveStart: ((payload: string | null) => void) | null = null;
	const startPromise = new Promise<string | null>((resolve) => {
		resolveStart = resolve;
	});

	const onAbort = () => {
		if (resolveStart) {
			const resolve = resolveStart;
			resolveStart = null;
			resolve(null);
		}
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	// Subscribe to inbox (awaits server ack, so subscription is confirmed)
	await bus.subscribe(inboxTopic, (payload) => {
		// Note: This callback remains registered after start is received, but
		// short-circuits via the null resolveStart check. We don't unsubscribe
		// because the idleLoop (for shared agents) subscribes to the same topic
		// and unsubscribing would remove its callback too.
		if (!resolveStart) return;
		try {
			const msg = parseBusMessage(payload);
			if (msg.kind === "start") {
				if (signal) signal.removeEventListener("abort", onAbort);
				const resolve = resolveStart;
				resolveStart = null;
				resolve(payload);
			}
		} catch {
			// Ignore malformed messages
		}
	});

	// Signal to spawner that inbox subscription is confirmed and we're ready
	await bus.publish(readyTopic, JSON.stringify({ kind: "ready", handle_id: handleId }));

	// Wait for start message
	return startPromise;
}

/**
 * Idle loop for shared agents. Waits for continue and steer messages,
 * runs agent.continue(), and publishes results. Continue messages that
 * arrive while a previous continue is processing are queued and
 * processed sequentially. Steer messages are queued via agent.steer()
 * for injection into the next continue cycle. Exits on abort signal.
 */
async function idleLoop(
	bus: BusClient,
	agent: Agent,
	genome: Genome,
	inboxTopic: string,
	resultTopic: string,
	handleId: string,
	signal: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;

	let processing = false;
	const continueQueue: ContinueMessage[] = [];

	async function processNext(): Promise<void> {
		processing = true;
		while (continueQueue.length > 0 && !signal.aborted) {
			const continueMsg = continueQueue.shift()!;
			try {
				await genome.loadFromDisk();
				const result = await agent.continue(continueMsg.message, signal);
				if (!bus.connected) break;
				const resultMsg: ResultMessage = {
					kind: "result",
					handle_id: handleId,
					output: result.output,
					success: result.success,
					stumbles: result.stumbles,
					turns: result.turns,
					timed_out: result.timed_out,
				};
				await bus.publish(resultTopic, JSON.stringify(resultMsg));
			} catch (err) {
				if (!bus.connected) break;
				const errorResult: ResultMessage = {
					kind: "result",
					handle_id: handleId,
					output: `Continue failed: ${err instanceof Error ? err.message : String(err)}`,
					success: false,
					stumbles: 0,
					turns: 0,
					timed_out: false,
				};
				await bus.publish(resultTopic, JSON.stringify(errorResult));
			}
		}
		processing = false;
	}

	// Await the subscribe so the callback is confirmed before entering idle
	await bus.subscribe(inboxTopic, async (payload) => {
		try {
			const msg = parseBusMessage(payload);

			// Steer messages are queued regardless of processing state
			if (msg.kind === "steer") {
				agent.steer(msg.message);
				return;
			}

			if (msg.kind === "continue") {
				continueQueue.push(msg as ContinueMessage);
				if (!processing) {
					await processNext();
				}
				return;
			}
		} catch {
			// Ignore malformed messages
		}
	});

	return new Promise((resolve) => {
		if (signal) {
			if (signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener("abort", () => resolve(), { once: true });
		}
	});
}

// --- Subprocess entry point ---
// When run as `bun src/bus/agent-process.ts`, reads config from env vars.

if (import.meta.main) {
	const busUrl = process.env.SPROUT_BUS_URL;
	const handleId = process.env.SPROUT_HANDLE_ID;
	const sessionId = process.env.SPROUT_SESSION_ID;
	const genomePath = process.env.SPROUT_GENOME_PATH;
	const workDir = process.env.SPROUT_WORK_DIR ?? process.cwd();
	const rootDir = process.env.SPROUT_ROOT_DIR;
	const projectDataDir = process.env.SPROUT_PROJECT_DATA_DIR;

	if (!busUrl || !handleId || !sessionId || !genomePath) {
		console.error(
			"Missing required env vars: SPROUT_BUS_URL, SPROUT_HANDLE_ID, SPROUT_SESSION_ID, SPROUT_GENOME_PATH",
		);
		process.exit(1);
	}

	const controller = new AbortController();
	process.on("SIGTERM", () => controller.abort());
	process.on("SIGINT", () => controller.abort());

	const dataDir = projectDataDir ?? genomePath;
	const logPath = join(dataDir, "logs", sessionId, handleId, "session.log.jsonl");
	const logger = new SessionLogger({ logPath, component: "agent-process", sessionId });

	createAgentProcessClient(logger)
		.then((client) =>
			runAgentProcess({
				busUrl,
				handleId,
				sessionId,
				genomePath,
				client,
				workDir,
				rootDir,
				projectDataDir,
				signal: controller.signal,
				logger,
			}),
		)
		.then(() => process.exit(0))
		.catch((err) => {
			console.error("Agent process error:", err);
			process.exit(1);
		});
}
