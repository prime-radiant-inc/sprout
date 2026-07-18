import { join } from "node:path";
import { Agent } from "../agents/agent.ts";
import { formatDelegationGoal, normalizeTaskPayload } from "../agents/delegation-payload.ts";
import { AgentEventEmitter } from "../agents/events.ts";
import { loadPreambles, scanAgentTree } from "../agents/loader.ts";
import { renderCallerIdentity } from "../agents/plan.ts";
import { loadProjectDocs } from "../agents/project-doc.ts";
import { Genome } from "../genome/genome.ts";
import { ensureMemoryIndexFresh } from "../genome/index-builder.ts";
import { deriveTrustedMemoryWriteAuthorization } from "../genome/memory-write-authorization.ts";
import { createReadOnlyGenome } from "../genome/read-only-genome.ts";
import { AuthChannelClient } from "../host/auth-channel.ts";
import { ChannelHandleRegistrar } from "../host/handle-registrar.ts";
import { ChannelLivenessProbe, LivenessReporter } from "../host/liveness.ts";
import { SessionLogger } from "../host/logger.ts";
import {
	OpenAICodexOAuthService,
	type OpenAICodexRuntimeCredentials,
} from "../host/openai-codex-oauth/service.ts";
import { importSettingsFromEnv } from "../host/settings/env-import.ts";
import {
	createSecretStoreRuntime,
	type SecretStoreRuntime,
} from "../host/settings/secret-store.ts";
import { type SettingsLoadResult, SettingsStore } from "../host/settings/store.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import { SUMMARY_BUDGET_CHARS } from "../kernel/truncation.ts";
import { Client } from "../llm/client.ts";
import { loggingMiddleware } from "../llm/logging-middleware.ts";
import { ProviderRegistry, type ProviderRegistryEntry } from "../llm/provider-registry.ts";
import type { ProviderAdapter } from "../llm/types.ts";
import { ChannelStoreAccess, type StoreAccess } from "../store/store-access.ts";
import { validateValueName } from "../store/value.ts";
import { ensureProjectDirs } from "../util/project-id.ts";
import { BusClient } from "./client.ts";
import { BusLearnForwarder } from "./learn-forwarder.ts";
import { loadCompletedChildHandles, replayHandleLog } from "./resume.ts";
import { AgentSpawner, type SpawnerAuthChannel } from "./spawner.ts";
import { agentEvents, agentInbox, agentReady, agentResult, sessionEvents } from "./topics.ts";
import type {
	AgentMessageMessage,
	ContinueMessage,
	EventMessage,
	ResultMessage,
	StartMessage,
} from "./types.ts";
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
	/** PID of the process that spawned this agent process. */
	parentPid?: number;
	/**
	 * Credentials for the host's authenticated channel. When present, the
	 * process connects at startup (failing fast if refused) and its child
	 * spawner registers grandchildren over that connection.
	 */
	authChannel?: { url: string; token: string };
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
	createOpenAICodexOAuthService?: (options: {
		secretStore: SecretStoreRuntime["secretStore"];
		secretBackend: SecretStoreRuntime["secretRefBackend"];
	}) => {
		resolveCredentials(providerId: string): Promise<OpenAICodexRuntimeCredentials>;
	};
	createClient?: (options: {
		providers: Record<string, ProviderAdapter>;
		logger: SessionLogger;
	}) => Client;
}

function composeAbortSignal(...signals: Array<AbortSignal | undefined>): {
	signal?: AbortSignal;
	cleanup: () => void;
} {
	const activeSignals = signals.filter((sig): sig is AbortSignal => sig !== undefined);
	if (activeSignals.length === 0) return { cleanup: () => {} };
	if (activeSignals.length === 1) return { signal: activeSignals[0], cleanup: () => {} };

	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const sig of activeSignals) {
		if (sig.aborted) {
			controller.abort();
			break;
		}
		sig.addEventListener("abort", abort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			for (const sig of activeSignals) {
				sig.removeEventListener("abort", abort);
			}
		},
	};
}

function monitorParentProcess(
	parentPid: number | undefined,
	controller: AbortController,
): () => void {
	if (parentPid === undefined) return () => {};
	const check = () => {
		if (process.ppid !== parentPid) {
			controller.abort();
		}
	};
	check();
	const timer = setInterval(check, 1000);
	return () => clearInterval(timer);
}

function parseParentPid(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
	return parsed;
}

export async function createAgentProcessClient(
	logger: SessionLogger,
	deps: AgentProcessClientDeps = {},
): Promise<Client> {
	const settingsStore = deps.createSettingsStore?.() ?? new SettingsStore();
	const settingsLoadResult = (await settingsStore.load()) as SettingsLoadResult;
	const secretStoreRuntime =
		deps.createSecretStoreRuntime?.() ?? createSecretStoreRuntime({ env: process.env });
	const openAICodexOAuthService =
		deps.createOpenAICodexOAuthService?.({
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
		}) ??
		new OpenAICodexOAuthService({
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
		});
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
			openAICodexCredentialResolver: (providerId: string) =>
				openAICodexOAuthService.resolveCredentials(providerId),
		}) ??
		new ProviderRegistry({
			settings,
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
			secretBackendState: secretStoreRuntime.secretBackendState,
			openAICodexCredentialResolver: (providerId: string) =>
				openAICodexOAuthService.resolveCredentials(providerId),
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
	const lifecycleController = new AbortController();
	const combined = composeAbortSignal(signal, lifecycleController.signal);
	const runSignal = combined.signal;
	const stopParentMonitor = monitorParentProcess(config.parentPid, lifecycleController);

	// Connect to bus
	const bus = new BusClient(busUrl);
	let stopBusDisconnectAbort = () => {};

	const inboxTopic = agentInbox(sessionId, handleId);
	const eventsTopic = agentEvents(sessionId, handleId);
	const resultTopic = agentResult(sessionId, handleId);
	const readyTopic = agentReady(sessionId, handleId);

	let childSpawner: AgentSpawner | undefined;
	let authClient: AuthChannelClient | undefined;
	let livenessReporter: LivenessReporter | undefined;
	let spawnerAuthChannel: SpawnerAuthChannel | undefined;

	try {
		await bus.connect();
		stopBusDisconnectAbort = bus.onDisconnect(() => lifecycleController.abort());

		// Connect the authenticated channel before signalling ready: refused
		// credentials must fail the process fast, not surface mid-delegation.
		if (config.authChannel) {
			authClient = new AuthChannelClient({
				url: config.authChannel.url,
				handleId,
				token: config.authChannel.token,
			});
			await authClient.connect();
			livenessReporter = new LivenessReporter({ client: authClient });
			livenessReporter.start();
			spawnerAuthChannel = {
				url: config.authChannel.url,
				registrar: new ChannelHandleRegistrar(authClient),
				probe: new ChannelLivenessProbe(authClient),
				store: new ChannelStoreAccess(authClient),
			};
		}

		// Subscribe to inbox and wait for start (or abort)
		const startPayload = await waitForStartWithReady(
			bus,
			inboxTopic,
			readyTopic,
			handleId,
			runSignal,
		);
		if (!startPayload) {
			// Aborted before receiving start
			return;
		}

		const startMsg = parseBusMessage(startPayload) as StartMessage;
		const evalMode = startMsg.eval_mode === true;

		// Load genome and find agent spec
		const genome = new Genome(genomePath, config.rootDir);
		await genome.loadFromDisk();
		if (evalMode) {
			await ensureMemoryIndexFresh(genomePath);
		}
		const runtimeGenome = evalMode ? createReadOnlyGenome(genome) : genome;

		const loadedSpec = runtimeGenome.getAgent(startMsg.self.agentName);
		if (!loadedSpec) {
			// Publish error result and exit
			const errorResult: ResultMessage = {
				kind: "result",
				handle_id: handleId,
				output: `Agent '${startMsg.self.agentName}' not found in genome`,
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
		const writeAuthorization = deriveTrustedMemoryWriteAuthorization({
			agentName: startMsg.self.agentName,
			userInstruction: startMsg.trusted_user_instruction,
		});
		const registry = createPrimitiveRegistry(
			env,
			{
				genome: runtimeGenome,
				agentName: startMsg.self.agentName,
				sessionId,
				...(writeAuthorization ? { writeAuthorization } : {}),
			},
			{ evalMode },
		);
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
		const currentAgentDepth = startMsg.self.depth;
		const resumedCompletedHandles = await loadCompletedChildHandles({
			logPath: priorLogPath,
			handleLogDir: join(dataDir, "logs", sessionId),
			ownerId: startMsg.self.agentName,
		});

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

		// Create a spawner so this agent can delegate to other agents via the bus.
		// Its registrations ride this process's authenticated connection.
		childSpawner = new AgentSpawner(
			bus,
			busUrl,
			sessionId,
			undefined,
			undefined,
			undefined,
			spawnerAuthChannel,
		);
		for (const { handleId, result, agentName, agentId } of resumedCompletedHandles) {
			childSpawner.registerCompletedHandle(handleId, result, startMsg.self.agentName, {
				agentName,
				genomePath,
				caller: startMsg.self,
				workDir,
				agentId,
				evalMode,
				rootDir: config.rootDir,
				projectDataDir: config.projectDataDir,
				providerIdOverride: startMsg.provider_id,
				resolverSettings: startMsg.resolver_settings,
				trustedUserInstruction: startMsg.trusted_user_instruction,
				surfacedMemoryBlock: startMsg.surfaced_memory_block,
			});
		}

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
			depth: currentAgentDepth,
			logBasePath,
			preambles,
			projectDocs,
			genomePostscripts,
			spawner: childSpawner,
			genomePath,
			projectDataDir: config.projectDataDir,
			learnProcess,
			initialHistory: initialHistory.length > 0 ? initialHistory : undefined,
			agentId: startMsg.self.agentId,
			evalMode,
			providerIdOverride: startMsg.provider_id,
			resolverSettings: startMsg.resolver_settings,
			logger: config.logger,
			rootDir: config.rootDir,
			agentTree,
			agentTreeChildren,
			agentTreeSelfPath,
			enableStreaming: true,
			surfacedMemoryBlock: startMsg.surfaced_memory_block,
			trustedUserInstruction: startMsg.trusted_user_instruction,
			self: startMsg.self,
			caller: startMsg.caller,
		});

		// Claim env grants (spec §3): each wire entry (alias → ulid) must match a
		// grant the sender registered; forged or stale entries bind nothing and
		// surface as a warning — never a failed start.
		const claimEnv = async (env?: Record<string, string>): Promise<string | undefined> => {
			const claim = await claimEnvGrants(spawnerAuthChannel?.store, env);
			if (!claim) return undefined;
			for (const warning of claim.warnings) {
				events.emit("warning", startMsg.self.agentId, startMsg.self.depth, { message: warning });
			}
			return claim.announcement;
		};

		const envAnnouncement = await claimEnv(startMsg.env);
		const baseGoal = formatDelegationGoal({
			goal: startMsg.goal,
			hints: startMsg.hints,
			payload: startMsg.payload
				? normalizeTaskPayload(startMsg.payload, "agent start message")
				: undefined,
		});
		const goal = envAnnouncement ? `${baseGoal}\n\n${envAnnouncement}` : baseGoal;

		// Forward steer messages from the inbox to the agent during the initial run.
		// The idleLoop handles steers for shared agents after run() completes,
		// but during the initial run() this is the only path for steers.
		let initialRunActive = true;
		if (bus.connected) {
			await bus.subscribe(inboxTopic, async (payload) => {
				if (!initialRunActive) return;
				try {
					const msg = parseBusMessage(payload);
					if (msg.kind === "steer") {
						agent.steer(msg.message, msg.trusted_user_instruction);
					} else if (msg.kind === "agent_message") {
						const announcement = await claimEnv(msg.env);
						if (announcement !== undefined) agent.steer(announcement);
						agent.receiveAgentMessage(msg.message, msg.from);
						void ackAgentMessage(bus, msg);
					}
				} catch {
					// Ignore malformed messages
				}
			});
		}

		// Run the agent
		let agentResult_: Awaited<ReturnType<typeof agent.run>>;
		try {
			agentResult_ = await agent.run(goal, runSignal);
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
		const storeAccess = spawnerAuthChannel?.store;
		const resultMsg: ResultMessage = {
			kind: "result",
			handle_id: handleId,
			output: await prepareResultOutput(storeAccess, handleId, startMsg.goal, agentResult_.output),
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
		if (!runSignal) {
			throw new Error("Shared agents require an AbortSignal to exit the idle loop");
		}
		await idleLoop(
			bus,
			agent,
			genome,
			inboxTopic,
			resultTopic,
			handleId,
			runSignal,
			storeAccess,
			startMsg.goal,
			claimEnv,
		);
	} finally {
		stopBusDisconnectAbort();
		stopParentMonitor();
		combined.cleanup();
		await childSpawner?.shutdown();
		livenessReporter?.stop();
		await authClient?.disconnect();
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
	storeAccess: StoreAccess | undefined,
	goal: string,
	claimEnv: (env?: Record<string, string>) => Promise<string | undefined>,
): Promise<void> {
	if (signal?.aborted) return;

	let processing = false;
	const continueQueue: ContinueMessage[] = [];

	async function processNext(): Promise<void> {
		processing = true;
		while (continueQueue.length > 0 && !signal.aborted) {
			const continueMsg = continueQueue.shift()!;
			try {
				// Claimed env binds announce via the steering queue, injected into
				// the continue run as a user-role message.
				const announcement = await claimEnv(continueMsg.env);
				if (announcement !== undefined) agent.steer(announcement);
				await genome.loadFromDisk();
				const result = await agent.continue(continueMsg.message, signal, {
					trustedUserInstruction: continueMsg.trusted_user_instruction,
				});
				if (!bus.connected) break;
				const resultMsg: ResultMessage = {
					kind: "result",
					handle_id: handleId,
					output: await prepareResultOutput(storeAccess, handleId, goal, result.output),
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
					// Error text is unbounded (provider messages can embed payloads)
					// — bound it inline exactly like a success result.
					output: await prepareResultOutput(
						storeAccess,
						handleId,
						goal,
						`Continue failed: ${err instanceof Error ? err.message : String(err)}`,
					),
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
				agent.steer(msg.message, msg.trusted_user_instruction);
				return;
			}

			if (msg.kind === "agent_message") {
				const agentMessage = msg as AgentMessageMessage;
				const announcement = await claimEnv(agentMessage.env);
				if (announcement !== undefined) agent.steer(announcement);
				agent.receiveAgentMessage(agentMessage.message, agentMessage.from);
				await ackAgentMessage(bus, agentMessage);
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

/**
 * Claim wire env entries (alias → ulid) against the store's pending grants
 * (spec §3). Each successful claim binds the alias into THIS process's scope
 * and contributes a compact announcement line with the value's first preview
 * line. A claim with no matching grant — a forged bus message, a stale ulid,
 * or no store at all — binds NOTHING and degrades to a bracketed note plus a
 * warning; the start/continue itself never fails on env.
 */
async function claimEnvGrants(
	store: StoreAccess | undefined,
	env: Record<string, string> | undefined,
): Promise<{ announcement: string; warnings: string[] } | undefined> {
	if (env === undefined) return undefined;
	const entries = Object.entries(env);
	if (entries.length === 0) return undefined;
	const claimed: string[] = [];
	const notes: string[] = [];
	const warnings: string[] = [];
	for (const [alias, ulid] of entries) {
		// A wire alias is untrusted text: an invalid one (e.g. carrying ⟧/newline
		// injection) is never echoed into the transcript, even inside a note.
		if (!validateValueName(alias, new Set()).ok) {
			notes.push("[an invalid env alias was ignored]");
			warnings.push("an invalid env alias was ignored");
			continue;
		}
		if (store === undefined) {
			notes.push(`[env ⟦${alias}⟧ was not granted — ignored]`);
			warnings.push(`env ⟦${alias}⟧ was not granted — ignored: no store available`);
			continue;
		}
		try {
			const metadata = await store.claimEnvGrant(alias, ulid);
			claimed.push(`⟦${metadata.name}⟧ (${metadata.preview.split("\n", 1)[0]})`);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			notes.push(`[env ⟦${alias}⟧ was not granted — ignored]`);
			warnings.push(`env ⟦${alias}⟧ was not granted — ignored: ${reason}`);
		}
	}
	const sections: string[] = [];
	if (claimed.length > 0) sections.push(`Values now in your scope:\n${claimed.join("\n")}`);
	sections.push(...notes);
	return { announcement: sections.join("\n"), warnings };
}

/** Fallback inline cap when the store can't take the overflow (today's semantics). */
const RESULT_FALLBACK_TRUNCATION_CHARS = 30_000;

/**
 * Auto-bind name for a run's overflowed result: a slug from the goal's first
 * few words, suffixed `_result` (sap spec §1 Naming #2 — deterministic, no LLM).
 */
function resultValueName(goal: string): string {
	const slug = goal
		.toLowerCase()
		.split(/\s+/)
		.slice(0, 4)
		.map((word) => word.replace(/[^a-z0-9_]/g, ""))
		.filter((word) => word.length > 0)
		.join("_");
	// A slug that is empty or not a valid name head falls back rather than
	// producing a bind the store would reject.
	if (slug.length === 0 || !/^[a-z_]/.test(slug)) return "agent_result";
	const suffix = "_result";
	return `${slug.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * The child-boundary auto-bind (sap spec §2 Auto-bind): output over the
 * summary budget binds the FULL output (auto), publishes it, and sends the
 * head inline with a marked mechanical cut — the marker names the value's
 * final (possibly suffixed) name. If bind or publish fails for any reason,
 * degrade to today's inline truncation with no marker naming a value.
 */
async function prepareResultOutput(
	store: StoreAccess | undefined,
	handleId: string,
	goal: string,
	output: string,
): Promise<string> {
	if (store === undefined || output.length <= SUMMARY_BUDGET_CHARS) return output;
	try {
		const metadata = await store.bind({
			name: resultValueName(goal),
			content: output,
			type: "text",
			provenance: { agentHandleId: handleId, origin: { kind: "delegation" } },
			explicit: false,
		});
		await store.publish(metadata.ulid);
		return (
			`${output.slice(0, SUMMARY_BUDGET_CHARS)}\n` +
			`[... output truncated at the summary budget — full output: ⟦${metadata.name}⟧]`
		);
	} catch {
		if (output.length <= RESULT_FALLBACK_TRUNCATION_CHARS) return output;
		return (
			`${output.slice(0, RESULT_FALLBACK_TRUNCATION_CHARS)}\n` +
			`[... output truncated at ${RESULT_FALLBACK_TRUNCATION_CHARS} chars]`
		);
	}
}

async function ackAgentMessage(bus: BusClient, message: AgentMessageMessage): Promise<void> {
	if (!message.ack_topic || !bus.connected) return;
	await bus.publish(message.ack_topic, "delivered").catch(() => {});
}

// --- Subprocess entry point ---

export async function runAgentProcessFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const busUrl = env.SPROUT_BUS_URL;
	const handleId = env.SPROUT_HANDLE_ID;
	const sessionId = env.SPROUT_SESSION_ID;
	const genomePath = env.SPROUT_GENOME_PATH;
	const workDir = env.SPROUT_WORK_DIR ?? process.cwd();
	const rootDir = env.SPROUT_ROOT_DIR;
	const projectDataDir = env.SPROUT_PROJECT_DATA_DIR;
	const parentPid = parseParentPid(env.SPROUT_PARENT_PID);
	const authUrl = env.SPROUT_AUTH_URL;
	const authToken = env.SPROUT_HANDLE_TOKEN;

	if (!busUrl || !handleId || !sessionId || !genomePath) {
		console.error(
			"Missing required env vars: SPROUT_BUS_URL, SPROUT_HANDLE_ID, SPROUT_SESSION_ID, SPROUT_GENOME_PATH",
		);
		return 1;
	}

	const controller = new AbortController();
	process.on("SIGTERM", () => controller.abort());
	process.on("SIGINT", () => controller.abort());

	const dataDir = projectDataDir ?? genomePath;
	const logPath = join(dataDir, "logs", sessionId, handleId, "session.log.jsonl");
	const logger = new SessionLogger({ logPath, component: "agent-process", sessionId });

	try {
		const client = await createAgentProcessClient(logger);
		await runAgentProcess({
			busUrl,
			handleId,
			sessionId,
			genomePath,
			client,
			workDir,
			rootDir,
			projectDataDir,
			parentPid,
			...(authUrl && authToken ? { authChannel: { url: authUrl, token: authToken } } : {}),
			signal: controller.signal,
			logger,
		});
		return 0;
	} catch (err) {
		console.error("Agent process error:", err);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await runAgentProcessFromEnvironment());
}
