import { join } from "node:path";
import { Agent } from "../agents/agent.ts";
import { AgentEventEmitter } from "../agents/events.ts";
import { loadPreambles } from "../agents/loader.ts";
import { renderCallerIdentity } from "../agents/plan.ts";
import { loadProjectDocs } from "../agents/project-doc.ts";
import { Genome } from "../genome/genome.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import { Client } from "../llm/client.ts";
import { BusClient } from "./client.ts";
import { BusLearnForwarder } from "./learn-forwarder.ts";
import { replayHandleLog } from "./resume.ts";
import { AgentSpawner } from "./spawner.ts";
import { agentEvents, agentInbox, agentReady, agentResult } from "./topics.ts";
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
	/** Path to bootstrap agent YAML files (for preambles). */
	bootstrapDir?: string;
	/** Abort signal for clean shutdown */
	signal?: AbortSignal;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("../host/logger.ts").Logger;
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

		// Load genome and find agent spec
		const genome = new Genome(genomePath);
		await genome.loadFromDisk();

		const loadedSpec = genome.getAgent(startMsg.agent_name);
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
		const registry = createPrimitiveRegistry(env);
		const events = new AgentEventEmitter();
		const preambles = config.bootstrapDir ? await loadPreambles(config.bootstrapDir) : undefined;
		const projectDocs = await loadProjectDocs({ cwd: workDir });
		const genomePostscripts = await genome.loadPostscripts();
		const logBasePath = join(genomePath, "logs", sessionId, handleId);

		// Check for a prior log — if this handle ran before, replay its history
		const priorLogPath = `${logBasePath}.jsonl`;
		const initialHistory = await replayHandleLog(priorLogPath);

		// Forward agent events to the bus (best-effort; ignore if disconnected)
		events.on((event) => {
			if (!bus.connected) return;
			const eventMsg: EventMessage = {
				kind: "event",
				handle_id: handleId,
				event,
			};
			bus.publish(eventsTopic, JSON.stringify(eventMsg));
		});

		// Create a spawner so this agent can delegate to other agents via the bus
		childSpawner = new AgentSpawner(bus, busUrl, sessionId);

		// Wire learn signal forwarding for agents that can learn
		const learnProcess = agentSpec.constraints.can_learn
			? new BusLearnForwarder(bus, sessionId)
			: undefined;

		const agent = new Agent({
			spec: agentSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			sessionId,
			depth: startMsg.caller.depth + 1,
			logBasePath,
			preambles,
			projectDocs,
			genomePostscripts,
			spawner: childSpawner,
			genomePath,
			learnProcess,
			initialHistory: initialHistory.length > 0 ? initialHistory : undefined,
			agentId: startMsg.agent_id,
			logger: config.logger,
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
		const agentResult_ = await agent.run(goal, signal);
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

		// Shared agent: enter idle loop, handle continue messages
		await idleLoop(bus, agent, inboxTopic, resultTopic, handleId, signal);
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
function idleLoop(
	bus: BusClient,
	agent: Agent,
	inboxTopic: string,
	resultTopic: string,
	handleId: string,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return Promise.resolve();

	return new Promise((resolve) => {
		let processing = false;
		const continueQueue: ContinueMessage[] = [];

		const onAbort = () => {
			resolve();
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		async function processNext(): Promise<void> {
			if (continueQueue.length === 0) {
				processing = false;
				return;
			}

			processing = true;
			const continueMsg = continueQueue.shift()!;
			try {
				const result = await agent.continue(continueMsg.message, signal);
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

			await processNext();
		}

		bus.subscribe(inboxTopic, async (payload) => {
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

	if (!busUrl || !handleId || !sessionId || !genomePath) {
		console.error(
			"Missing required env vars: SPROUT_BUS_URL, SPROUT_HANDLE_ID, SPROUT_SESSION_ID, SPROUT_GENOME_PATH",
		);
		process.exit(1);
	}

	const controller = new AbortController();
	process.on("SIGTERM", () => controller.abort());
	process.on("SIGINT", () => controller.abort());

	const logPath = join(genomePath, "logs", sessionId, handleId, "session.log.jsonl");
	const { SessionLogger } = await import("../host/logger.ts");
	const { loggingMiddleware } = await import("../llm/logging-middleware.ts");
	const logger = new SessionLogger({ logPath, component: "agent-process", sessionId });
	const client = Client.fromEnv({ middleware: [loggingMiddleware(logger)] });

	runAgentProcess({
		busUrl,
		handleId,
		sessionId,
		genomePath,
		client,
		workDir,
		signal: controller.signal,
		logger,
	})
		.then(() => process.exit(0))
		.catch((err) => {
			console.error("Agent process error:", err);
			process.exit(1);
		});
}
