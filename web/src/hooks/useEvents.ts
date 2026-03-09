import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { EVENT_CAP } from "@kernel/constants.ts";
import { createCommandMessage, type ServerMessage } from "@kernel/protocol.ts";
import type { Command, SessionEvent } from "@kernel/types.ts";
import type { PricingTable } from "@kernel/pricing.ts";
import { setPricingTable } from "../utils/pricing.ts";

function eventKey(event: SessionEvent): string {
	return JSON.stringify(event);
}

function dedupeEvents(events: SessionEvent[]): SessionEvent[] {
	const seen = new Set<string>();
	const result: SessionEvent[] = [];
	for (const event of events) {
		const key = eventKey(event);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(event);
	}
	return result;
}

/** Status state derived from the event stream, mirroring the TUI's App.tsx logic. */
export interface SessionStatus {
	status: "idle" | "running" | "interrupted";
	model: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	contextTokens: number;
	contextWindowSize: number;
	sessionId: string;
	availableModels: string[];
	sessionStartedAt: number | null;
	pricingTable: PricingTable | null;
}

const INITIAL_STATUS: SessionStatus = {
	status: "idle",
	model: "",
	turns: 0,
	inputTokens: 0,
	outputTokens: 0,
	contextTokens: 0,
	contextWindowSize: 0,
	sessionId: "",
	availableModels: [],
	sessionStartedAt: null,
	pricingTable: null,
};

function coerceSessionStatus(status: string): SessionStatus["status"] {
	if (status === "running" || status === "interrupted") {
		return status;
	}
	return "idle";
}

/**
 * Pure state management for session events and derived status.
 * Separated from React so it can be tested without a DOM.
 */
export class EventStore {
	events: SessionEvent[] = [];
	status: SessionStatus = { ...INITIAL_STATUS };
	private historyExtended = false;
	private eventKeys = new Set<string>();

	private listeners: Array<() => void> = [];

	/** Subscribe to state changes. Returns unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/** Process an incoming server message, updating events and status. */
	processMessage(msg: ServerMessage): void {
		switch (msg.type) {
			case "snapshot": {
				const snapshotStatus = coerceSessionStatus(msg.session.status);
				const snapshotModel =
					typeof msg.session.currentModel === "string" ? msg.session.currentModel : undefined;
				const snapshotAvailableModels = msg.session.availableModels ?? [];

				this.historyExtended = false;
				this.replaceEvents(dedupeEvents(msg.events));
				if (this.events.length > EVENT_CAP) {
					this.replaceEvents(this.events.slice(-EVENT_CAP));
				}
				this.status = {
					...INITIAL_STATUS,
					status: snapshotStatus,
					model: snapshotModel ?? INITIAL_STATUS.model,
					sessionId: msg.session.id,
					availableModels: snapshotAvailableModels,
				};
				// Replay all events in the snapshot to derive current status
				for (const event of msg.events) {
					this.applyEventToStatus(event);
				}
				// Snapshot session metadata is authoritative on reconnect.
				this.status = {
					...this.status,
					status: snapshotStatus,
					model: snapshotModel ?? this.status.model,
					sessionId: msg.session.id,
					availableModels: snapshotAvailableModels,
					pricingTable: Array.isArray(msg.session.pricingTable)
						? msg.session.pricingTable
						: null,
				};
				setPricingTable(this.status.pricingTable);
				break;
			}

			case "event":
				this.appendEvent(msg.event);
				if (!this.historyExtended && this.events.length > EVENT_CAP) {
					this.replaceEvents(this.events.slice(-EVENT_CAP));
				}
				this.applyEventToStatus(msg.event);
				if (msg.event.kind === "session_clear") {
					this.historyExtended = false;
					// Clear prior events but keep the session_clear event itself
					// so the UI can render a "New session started" message.
					this.replaceEvents([msg.event]);
				}
				break;
		}

		this.notify();
	}

	prependHistory(events: SessionEvent[]): void {
		if (events.length === 0) return;
		this.historyExtended = true;
		this.replaceEvents(dedupeEvents([...events, ...this.events]));
		this.notify();
	}

	/** Create a sendCommand function bound to a specific send callback. */
	createSendCommand(send: (msg: object) => void): (command: Command) => void {
		return (command: Command) => {
			send(createCommandMessage(command));
		};
	}

	private applyEventToStatus(event: SessionEvent): void {
		switch (event.kind) {
			case "session_start":
				this.status = {
					...this.status,
					status: "running",
					model: (event.data.model as string) ?? this.status.model,
					sessionStartedAt: this.status.sessionStartedAt ?? event.timestamp,
				};
				break;

			case "session_end":
				this.status = {
					...this.status,
					status: "idle",
					inputTokens: 0,
					outputTokens: 0,
				};
				break;

			case "interrupted":
				this.status = { ...this.status, status: "interrupted" };
				break;

			case "session_clear":
				this.status = {
					...INITIAL_STATUS,
					sessionId: (event.data.new_session_id as string) ?? this.status.sessionId,
					availableModels: this.status.availableModels,
				};
				break;

			case "context_update":
				this.status = {
					...this.status,
					contextTokens: (event.data.context_tokens as number) ?? this.status.contextTokens,
					contextWindowSize: (event.data.context_window_size as number) ?? this.status.contextWindowSize,
				};
				break;

			case "plan_end": {
				const usage = event.data.usage as { input_tokens: number; output_tokens: number } | undefined;
				this.status = {
					...this.status,
					turns: (event.data.turn as number) ?? this.status.turns,
					inputTokens: this.status.inputTokens + (usage?.input_tokens ?? 0),
					outputTokens: this.status.outputTokens + (usage?.output_tokens ?? 0),
				};
				break;
			}
		}
	}

	private replaceEvents(events: SessionEvent[]): void {
		this.events = events;
		this.eventKeys = new Set(events.map((event) => eventKey(event)));
	}

	private appendEvent(event: SessionEvent): void {
		const key = eventKey(event);
		if (this.eventKeys.has(key)) return;
		this.events = [...this.events, event];
		this.eventKeys.add(key);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

// --- React hook ---

interface UseEventsResult {
	events: SessionEvent[];
	status: SessionStatus;
	sendCommand: (command: Command) => void;
	prependHistory: (events: SessionEvent[]) => void;
}

/**
 * React hook that processes incoming WebSocket messages into
 * an event stream and derived session status.
 *
 * Takes the WebSocket hook's output as input.
 */
export function useEvents(
	onMessage: (listener: (msg: ServerMessage) => void) => () => void,
	send: (msg: object) => void,
): UseEventsResult {
	const storeRef = useRef<EventStore | null>(null);
	if (!storeRef.current) {
		storeRef.current = new EventStore();
	}
	const store = storeRef.current;

	// Subscribe directly to the WebSocket message stream.
	// This ensures EVERY message is processed, even when multiple arrive
	// between React renders (which would drop messages via lastMessage).
	useEffect(() => {
		return onMessage((msg) => {
			store.processMessage(msg);
		});
	}, [onMessage, store]);

	// Snapshot for useSyncExternalStore
	const snapshotRef = useRef({ events: store.events, status: store.status });

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			return store.subscribe(() => {
				snapshotRef.current = { events: store.events, status: store.status };
				onStoreChange();
			});
		},
		[store],
	);

	const getSnapshot = () => snapshotRef.current;
	const state = useSyncExternalStore(subscribe, getSnapshot);

	const sendCommandRef = useRef(store.createSendCommand(send));
	// Update sendCommand if send changes
	useEffect(() => {
		sendCommandRef.current = store.createSendCommand(send);
	}, [send, store]);

	return {
		events: state.events,
		status: state.status,
		sendCommand: (cmd: Command) => sendCommandRef.current(cmd),
		prependHistory: (events: SessionEvent[]) => store.prependHistory(events),
	};
}
