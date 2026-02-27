import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Command, SessionEvent } from "../../../src/kernel/types.ts";
import type { ServerMessage } from "../../../src/web/protocol.ts";

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
};

/**
 * Pure state management for session events and derived status.
 * Separated from React so it can be tested without a DOM.
 */
export class EventStore {
	events: SessionEvent[] = [];
	status: SessionStatus = { ...INITIAL_STATUS };

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
			case "snapshot":
				this.events = msg.events;
				this.status = { ...INITIAL_STATUS, sessionId: msg.session.id };
				// Replay all events in the snapshot to derive current status
				for (const event of msg.events) {
					this.applyEventToStatus(event);
				}
				break;

			case "event":
				this.events = [...this.events, msg.event];
				this.applyEventToStatus(msg.event);
				if (msg.event.kind === "session_clear") {
					// Clear prior events but keep the session_clear event itself
					// so the UI can render a "New session started" message.
					this.events = [msg.event];
				}
				break;
		}

		this.notify();
	}

	/** Create a sendCommand function bound to a specific send callback. */
	createSendCommand(send: (msg: object) => void): (command: Command) => void {
		return (command: Command) => {
			send({ type: "command", command });
		};
	}

	private applyEventToStatus(event: SessionEvent): void {
		switch (event.kind) {
			case "session_start":
				this.status = {
					...this.status,
					status: "running",
					model: (event.data.model as string) ?? this.status.model,
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
				this.status = { ...INITIAL_STATUS, sessionId: (event.data.new_session_id as string) ?? this.status.sessionId };
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
	};
}
