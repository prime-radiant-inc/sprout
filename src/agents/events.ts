import type { EventKind, SessionEvent } from "../kernel/types.ts";

export type EventListener = (event: SessionEvent) => void;

export class AgentEventEmitter {
	private listeners: EventListener[] = [];
	private events: SessionEvent[] = [];

	on(listener: EventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	emit(kind: EventKind, agentId: string, depth: number, data: Record<string, unknown> = {}): void {
		const event: SessionEvent = {
			kind,
			timestamp: Date.now(),
			agent_id: agentId,
			depth,
			data,
		};
		this.events.push(event);
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	collected(): SessionEvent[] {
		return [...this.events];
	}
}
