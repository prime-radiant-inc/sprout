import type { Command, EventKind, SessionEvent } from "../kernel/types.ts";

export type EventListener = (event: SessionEvent) => void;
export type CommandListener = (command: Command) => void;

/**
 * Two-channel event bus.
 *
 * Agent events (up): emitted by agents, consumed by TUI/logger/web bridge.
 * Commands (down): emitted by frontends, consumed by session controller.
 *
 * Compatible with AgentEventEmitter interface so Agent doesn't need to change.
 */
const EVENT_CAP = 10_000;

export class EventBus {
	private eventListeners: EventListener[] = [];
	private commandListeners: CommandListener[] = [];
	private events: SessionEvent[] = [];

	/** Subscribe to agent events. Returns unsubscribe function. */
	onEvent(listener: EventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	/** Emit an agent event to all subscribers. */
	emitEvent(
		kind: EventKind,
		agentId: string,
		depth: number,
		data: Record<string, unknown> = {},
	): void {
		const event: SessionEvent = {
			kind,
			timestamp: Date.now(),
			agent_id: agentId,
			depth,
			data,
		};
		this.events.push(event);
		if (this.events.length > EVENT_CAP) {
			this.events.splice(0, this.events.length - EVENT_CAP);
		}
		for (const listener of this.eventListeners) {
			listener(event);
		}
	}

	/** Subscribe to commands. Returns unsubscribe function. */
	onCommand(listener: CommandListener): () => void {
		this.commandListeners.push(listener);
		return () => {
			const idx = this.commandListeners.indexOf(listener);
			if (idx >= 0) this.commandListeners.splice(idx, 1);
		};
	}

	/** Emit a command to all subscribers. */
	emitCommand(command: Command): void {
		for (const listener of this.commandListeners) {
			listener(command);
		}
	}

	// --- AgentEventEmitter compatibility ---

	/** Alias for onEvent — matches AgentEventEmitter.on() signature. */
	on(listener: EventListener): () => void {
		return this.onEvent(listener);
	}

	/** Alias for emitEvent — matches AgentEventEmitter.emit() signature. */
	emit(kind: EventKind, agentId: string, depth: number, data: Record<string, unknown> = {}): void {
		this.emitEvent(kind, agentId, depth, data);
	}

	/** Return all collected events. */
	collected(): SessionEvent[] {
		return [...this.events];
	}

	/** Clear all collected events. */
	clearEvents(): void {
		this.events.length = 0;
	}
}
