import { AgentEventEmitter } from "../agents/events.ts";
import { createAgent } from "../agents/factory.ts";
import type { Command } from "../kernel/types.ts";
import { ulid } from "../util/ulid.ts";
import type { EventBus } from "./event-bus.ts";
import { SessionMetadata } from "./session-metadata.ts";

/** Minimal agent interface used by the SessionController. */
interface RunnableAgent {
	steer(text: string): void;
	run(
		goal: string,
		signal?: AbortSignal,
	): Promise<{
		output: string;
		success: boolean;
		stumbles: number;
		turns: number;
		timed_out: boolean;
	}>;
}

/** Options passed to the agent factory. */
export interface AgentFactoryOptions {
	genomePath: string;
	bootstrapDir?: string;
	workDir: string;
	rootAgent?: string;
	sessionId: string;
	/** EventBus used as the event emitter. Compatible with AgentEventEmitter. */
	events: EventBus;
}

/** Result returned by the agent factory. */
export interface AgentFactoryResult {
	agent: RunnableAgent;
	learnProcess: { startBackground(): void; stopBackground(): Promise<void> } | null;
}

/** Factory function that creates an agent. Injectable for testing. */
export type AgentFactory = (options: AgentFactoryOptions) => Promise<AgentFactoryResult>;

export interface SessionControllerOptions {
	bus: EventBus;
	genomePath: string;
	sessionsDir: string;
	bootstrapDir?: string;
	rootAgent?: string;
	factory?: AgentFactory;
}

/**
 * Default factory that delegates to createAgent from the agents module.
 * Relays events from the agent's AgentEventEmitter to the EventBus.
 */
async function defaultFactory(options: AgentFactoryOptions): Promise<AgentFactoryResult> {
	const agentEvents = new AgentEventEmitter();

	// Relay agent events to the bus
	agentEvents.on((event) => {
		options.events.emitEvent(event.kind, event.agent_id, event.depth, event.data);
	});

	const result = await createAgent({
		genomePath: options.genomePath,
		bootstrapDir: options.bootstrapDir,
		workDir: options.workDir,
		rootAgent: options.rootAgent,
		events: agentEvents,
	});

	return {
		agent: result.agent,
		learnProcess: result.learnProcess,
	};
}

/**
 * Stateful core that owns the agent lifecycle.
 *
 * Subscribes to EventBus commands (down), routes them to the agent,
 * and relays agent events back through the bus (up).
 */
export class SessionController {
	readonly sessionId: string;
	private agent: RunnableAgent | null = null;
	private abortController = new AbortController();
	private metadata: SessionMetadata;
	private readonly bus: EventBus;
	private readonly genomePath: string;
	private readonly sessionsDir: string;
	private readonly bootstrapDir?: string;
	private readonly rootAgentName?: string;
	private readonly factory: AgentFactory;
	private running = false;

	constructor(options: SessionControllerOptions) {
		this.sessionId = ulid();
		this.bus = options.bus;
		this.genomePath = options.genomePath;
		this.sessionsDir = options.sessionsDir;
		this.bootstrapDir = options.bootstrapDir;
		this.rootAgentName = options.rootAgent;
		this.factory = options.factory ?? defaultFactory;

		this.metadata = new SessionMetadata({
			sessionId: this.sessionId,
			agentSpec: options.rootAgent ?? "root",
			model: "best",
			sessionsDir: this.sessionsDir,
		});

		this.bus.onCommand((cmd) => this.handleCommand(cmd));
	}

	private handleCommand(cmd: Command): void {
		switch (cmd.kind) {
			case "submit_goal":
				this.submitGoal(cmd.data.goal as string);
				break;
			case "steer":
				this.agent?.steer(cmd.data.text as string);
				break;
			case "interrupt":
				this.interrupt();
				break;
			case "quit":
				this.interrupt();
				break;
		}
	}

	private interrupt(): void {
		this.abortController.abort();
		this.abortController = new AbortController();
	}

	async submitGoal(goal: string): Promise<void> {
		if (this.running) {
			this.agent?.steer(goal);
			return;
		}

		this.running = true;
		this.metadata.setStatus("running");
		await this.metadata.save();

		try {
			const { agent, learnProcess } = await this.factory({
				genomePath: this.genomePath,
				bootstrapDir: this.bootstrapDir,
				workDir: process.cwd(),
				rootAgent: this.rootAgentName,
				events: this.bus,
				sessionId: this.sessionId,
			});

			this.agent = agent;

			if (learnProcess) {
				learnProcess.startBackground();
			}

			await agent.run(goal, this.abortController.signal);

			if (learnProcess) {
				await learnProcess.stopBackground();
			}
		} finally {
			this.running = false;
			this.metadata.setStatus("idle");
			await this.metadata.save();
			this.agent = null;
		}
	}

	get isRunning(): boolean {
		return this.running;
	}
}
