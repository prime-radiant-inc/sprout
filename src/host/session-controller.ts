import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentEventEmitter } from "../agents/events.ts";
import { createAgent } from "../agents/factory.ts";
import type { Command, SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import { Msg } from "../llm/types.ts";
import { ulid } from "../util/ulid.ts";
import { shouldCompact } from "./compaction.ts";
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
	/** Prior conversation history for resume/continuation. */
	initialHistory?: Message[];
	/** Model override from /model command. */
	model?: string;
}

/** Result returned by the agent factory. */
export interface AgentFactoryResult {
	agent: RunnableAgent;
	learnProcess: { startBackground(): void; stopBackground(): Promise<void> } | null;
	compact?: (
		history: Message[],
		logPath: string,
	) => Promise<{ summary: string; beforeCount: number; afterCount: number }>;
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
	sessionId?: string;
	initialHistory?: Message[];
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
		sessionId: options.sessionId,
		initialHistory: options.initialHistory,
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
	private readonly logPath: string;
	private history: Message[] = [];
	private running = false;
	private modelOverride?: string;
	private hasRun = false;
	private compactFn?: AgentFactoryResult["compact"];

	constructor(options: SessionControllerOptions) {
		this.sessionId = options.sessionId ?? ulid();
		this.bus = options.bus;
		this.genomePath = options.genomePath;
		this.sessionsDir = options.sessionsDir;
		this.bootstrapDir = options.bootstrapDir;
		this.rootAgentName = options.rootAgent;
		this.factory = options.factory ?? defaultFactory;
		this.logPath = join(options.sessionsDir, `${this.sessionId}.jsonl`);
		this.history = options.initialHistory ? [...options.initialHistory] : [];

		this.metadata = new SessionMetadata({
			sessionId: this.sessionId,
			agentSpec: options.rootAgent ?? "root",
			model: "best",
			sessionsDir: this.sessionsDir,
		});

		this.bus.onCommand((cmd) => this.handleCommand(cmd));
		this.bus.onEvent((event) => this.handleEvent(event));
	}

	private handleCommand(cmd: Command): void {
		switch (cmd.kind) {
			case "submit_goal":
				this.submitGoal(cmd.data.goal as string).catch((err) => {
					this.bus.emitEvent("error", "session", 0, { error: String(err) });
				});
				break;
			case "steer":
				this.agent?.steer(cmd.data.text as string);
				break;
			case "interrupt":
				this.interrupt();
				break;
			case "clear":
				this.history = [];
				break;
			case "switch_model":
				this.modelOverride = cmd.data.model as string | undefined;
				break;
			case "compact":
				this.runCompaction().catch((err) => {
					this.bus.emitEvent("error", "session", 0, { error: String(err) });
				});
				break;
			case "quit":
				this.interrupt();
				break;
		}
	}

	private async handleEvent(event: SessionEvent): Promise<void> {
		// Accumulate history synchronously before async operations
		if (event.depth === 0) {
			switch (event.kind) {
				case "perceive": {
					const goal = event.data.goal as string | undefined;
					if (goal) this.history.push(Msg.user(goal));
					break;
				}
				case "steering": {
					const text = event.data.text as string | undefined;
					if (text) this.history.push(Msg.user(text));
					break;
				}
				case "plan_end": {
					const msg = event.data.assistant_message as Message | undefined;
					if (msg) this.history.push(msg);
					break;
				}
				case "primitive_end": {
					const msg = event.data.tool_result_message as Message | undefined;
					if (msg) this.history.push(msg);
					break;
				}
				case "act_end": {
					const msg = event.data.tool_result_message as Message | undefined;
					if (msg) this.history.push(msg);
					break;
				}
				case "compaction": {
					const summary = event.data.summary as string | undefined;
					if (summary) this.history = [Msg.user(summary)];
					break;
				}
			}
		}

		await this.appendLog(event);

		if (event.kind === "plan_end" && event.depth === 0) {
			const turn = (event.data.turn as number) ?? 0;
			const contextTokens = (event.data.context_tokens as number) ?? 0;
			const contextWindowSize = (event.data.context_window_size as number) ?? 0;
			this.metadata.updateTurn(turn, contextTokens, contextWindowSize);
			await this.metadata.save();
			this.bus.emitEvent("context_update", "session", 0, {
				context_tokens: contextTokens,
				context_window_size: contextWindowSize,
			});
			if (shouldCompact(contextTokens, contextWindowSize)) {
				this.runCompaction().catch((err) => {
					this.bus.emitEvent("error", "session", 0, { error: String(err) });
				});
			}
		}
	}

	private async appendLog(event: SessionEvent): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });
		await appendFile(this.logPath, JSON.stringify(event) + "\n");
	}

	private async runCompaction(): Promise<void> {
		if (!this.compactFn || this.history.length === 0) return;
		const result = await this.compactFn(this.history, this.logPath);
		this.bus.emitEvent("compaction", "session", 0, {
			summary: result.summary,
			beforeCount: result.beforeCount,
			afterCount: result.afterCount,
		});
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

		if (!this.hasRun && this.history.length > 0) {
			this.bus.emitEvent("session_resume", "session", 0, {
				history_length: this.history.length,
			});
		}
		this.hasRun = true;

		this.running = true;
		this.metadata.setStatus("running");
		await this.metadata.save();

		let learnProcess: AgentFactoryResult["learnProcess"] = null;

		try {
			const result = await this.factory({
				genomePath: this.genomePath,
				bootstrapDir: this.bootstrapDir,
				workDir: process.cwd(),
				rootAgent: this.rootAgentName,
				events: this.bus,
				sessionId: this.sessionId,
				initialHistory: this.history.length > 0 ? [...this.history] : undefined,
				model: this.modelOverride,
			});

			this.agent = result.agent;
			learnProcess = result.learnProcess;
			this.compactFn = result.compact;

			if (learnProcess) {
				learnProcess.startBackground();
			}

			await result.agent.run(goal, this.abortController.signal);
		} finally {
			if (learnProcess) {
				await learnProcess.stopBackground();
			}
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
