import { join } from "node:path";
import { AgentEventEmitter } from "../agents/events.ts";
import { createAgent } from "../agents/factory.ts";
import type { Command, SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import { Msg } from "../llm/types.ts";
import { ulid } from "../util/ulid.ts";
import { compactHistory } from "./compaction.ts";
import type { EventBus } from "./event-bus.ts";
import { SessionMetadata } from "./session-metadata.ts";

/** Minimal agent interface used by the SessionController. */
interface RunnableAgent {
	steer(text: string): void;
	requestCompaction(): void;
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
	/** Compact conversation history via LLM summarization. Available after agent creation. */
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
	/** Directory for session metadata. Defaults to genomePath/sessions. */
	sessionsDir?: string;
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
		model: options.model,
	});

	return {
		agent: result.agent,
		learnProcess: result.learnProcess,
		compact: (history, logPath) =>
			compactHistory({
				history,
				client: result.client,
				model: result.model,
				provider: result.provider,
				logPath,
			}),
	};
}

/**
 * Stateful core that owns the agent lifecycle.
 *
 * Subscribes to EventBus commands (down), routes them to the agent,
 * and relays agent events back through the bus (up).
 */
export class SessionController {
	private _sessionId: string;
	private agent: RunnableAgent | null = null;
	private abortController = new AbortController();
	private metadata: SessionMetadata;
	private readonly bus: EventBus;
	private readonly genomePath: string;
	private readonly sessionsDir: string;
	private readonly bootstrapDir?: string;
	private readonly rootAgentName?: string;
	private readonly factory: AgentFactory;
	private history: Message[] = [];
	private running = false;
	private modelOverride?: string;
	private hasRun = false;
	private compactFn?: AgentFactoryResult["compact"];

	get sessionId(): string {
		return this._sessionId;
	}

	constructor(options: SessionControllerOptions) {
		this._sessionId = options.sessionId ?? ulid();
		this.bus = options.bus;
		this.genomePath = options.genomePath;
		this.sessionsDir = options.sessionsDir ?? join(options.genomePath, "sessions");
		this.bootstrapDir = options.bootstrapDir;
		this.rootAgentName = options.rootAgent;
		this.factory = options.factory ?? defaultFactory;
		this.history = options.initialHistory ? [...options.initialHistory] : [];

		this.metadata = new SessionMetadata({
			sessionId: this._sessionId,
			agentSpec: options.rootAgent ?? "root",
			model: "best",
			sessionsDir: this.sessionsDir,
		});

		this.bus.onCommand((cmd) => this.handleCommand(cmd));
		this.bus.onEvent((event) => {
			this.handleEvent(event).catch((err) => {
				console.error("Error handling event:", err);
			});
		});
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
			case "clear": {
				this.history = [];
				this.hasRun = false;
				this._sessionId = ulid();
				this.metadata = new SessionMetadata({
					sessionId: this._sessionId,
					agentSpec: this.rootAgentName ?? "root",
					model: this.modelOverride ?? "best",
					sessionsDir: this.sessionsDir,
				});
				this.bus.emitEvent("session_clear", "session", 0, {
					new_session_id: this._sessionId,
				});
				break;
			}
			case "switch_model":
				this.modelOverride = cmd.data.model as string | undefined;
				break;
			case "compact":
				if (this.agent) {
					this.agent.requestCompaction();
				} else if (this.compactFn && this.history.length > 0) {
					this.compactWhileIdle();
				} else {
					this.bus.emitEvent("warning", "session", 0, {
						message: "Nothing to compact",
					});
				}
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

		if (event.kind === "plan_end" && event.depth === 0) {
			const turn = (event.data.turn as number) ?? 0;
			const contextTokens = (event.data.context_tokens as number) ?? 0;
			const contextWindowSize = (event.data.context_window_size as number) ?? 0;
			this.metadata.updateTurn(turn, contextTokens, contextWindowSize);
			await this.metadata.save();
			// Safe to re-emit into the bus from within an event handler: EventBus
			// delivers events synchronously to all listeners in registration order.
			// context_update is informational only (no handlers modify controller
			// state in response), so re-entrancy cannot cause loops or corruption.
			this.bus.emitEvent("context_update", "session", 0, {
				context_tokens: contextTokens,
				context_window_size: contextWindowSize,
			});
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

		// Emit session_resume on first run when prior history exists (including
		// compacted single-message history). The TUI uses history_length to show
		// how much context was carried forward.
		if (!this.hasRun && this.history.length > 0) {
			this.bus.emitEvent("session_resume", "session", 0, {
				history_length: this.history.length,
			});
		}
		this.hasRun = true;

		// Task 19: If resuming a session with stuck "running" metadata, recover it
		if (this.history.length > 0) {
			const metaPath = join(this.sessionsDir, `${this._sessionId}.meta.json`);
			await this.metadata.loadIfExists(metaPath);
		}

		this.running = true;
		this.metadata.setStatus("running");
		await this.metadata.save();

		let learnProcess: AgentFactoryResult["learnProcess"] = null;
		const signal = this.abortController.signal;

		try {
			const result = await this.factory({
				genomePath: this.genomePath,
				bootstrapDir: this.bootstrapDir,
				workDir: process.cwd(),
				rootAgent: this.rootAgentName,
				events: this.bus,
				sessionId: this._sessionId,
				initialHistory: this.history.length > 0 ? [...this.history] : undefined,
				model: this.modelOverride,
			});

			this.agent = result.agent;
			learnProcess = result.learnProcess;
			if (result.compact) {
				this.compactFn = result.compact;
			}

			if (learnProcess) {
				learnProcess.startBackground();
			}

			await result.agent.run(goal, signal);
		} finally {
			if (learnProcess) {
				await learnProcess.stopBackground();
			}
			this.running = false;
			this.metadata.setStatus(signal.aborted ? "interrupted" : "idle");
			await this.metadata.save();
			this.agent = null;
		}
	}

	private async compactWhileIdle(): Promise<void> {
		if (!this.compactFn) return;
		const logPath = join(this.genomePath, "logs", this._sessionId);
		try {
			const result = await this.compactFn(this.history, logPath);
			if (result.summary) {
				this.bus.emitEvent("warning", "session", 0, {
					message: `Compacted: ${result.beforeCount} → ${result.afterCount} messages`,
				});
			} else {
				this.bus.emitEvent("warning", "session", 0, {
					message: `History too short to compact (${result.beforeCount} messages)`,
				});
			}
		} catch (err) {
			this.bus.emitEvent("error", "session", 0, { error: String(err) });
		}
	}

	get isRunning(): boolean {
		return this.running;
	}

	get currentModel(): string | undefined {
		return this.modelOverride;
	}
}
