import type { EventKind, SessionEvent } from "../kernel/types.ts";

export type EventListener = (event: SessionEvent) => void;

/**
 * How many events collected() retains (a ring: oldest roll off). The learn
 * loop's scans — quartermaster cell observations, extraction evidence — are
 * recent-biased, so a generous window keeps them intact while a long session
 * stops growing without bound.
 */
export const COLLECTED_EVENT_CAP = 5_000;

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
		if (this.events.length > COLLECTED_EVENT_CAP) {
			this.events.splice(0, this.events.length - COLLECTED_EVENT_CAP);
		}
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	collected(): SessionEvent[] {
		return [...this.events];
	}
}
