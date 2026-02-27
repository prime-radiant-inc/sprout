import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import type { ServerMessage } from "../../../src/web/protocol.ts";
import { EventStore } from "./useEvents.ts";

// --- Helpers ---

function makeEvent(kind: SessionEvent["kind"], data: Record<string, unknown> = {}): SessionEvent {
	return { kind, timestamp: Date.now(), agent_id: "root", depth: 0, data };
}

function eventMessage(event: SessionEvent): ServerMessage {
	return { type: "event", event };
}

function snapshotMessage(
	events: SessionEvent[],
	session: { id: string; status: string } = { id: "test-session", status: "idle" },
): ServerMessage {
	return { type: "snapshot", events, session };
}

// --- Tests ---

describe("EventStore", () => {
	describe("initial state", () => {
		test("starts with empty events and idle status", () => {
			const store = new EventStore();

			expect(store.events).toEqual([]);
			expect(store.status).toEqual({
				status: "idle",
				model: "",
				turns: 0,
				inputTokens: 0,
				outputTokens: 0,
				contextTokens: 0,
				contextWindowSize: 0,
				sessionId: "",
			});
		});
	});

	describe("snapshot handling", () => {
		test("replaces events array on snapshot", () => {
			const store = new EventStore();
			const events = [
				makeEvent("session_start", { model: "claude-sonnet-4-6" }),
				makeEvent("plan_start", { turn: 1 }),
			];

			store.processMessage(snapshotMessage(events));

			expect(store.events).toEqual(events);
		});

		test("sets sessionId from snapshot", () => {
			const store = new EventStore();

			store.processMessage(snapshotMessage([], { id: "snap-session", status: "running" }));

			expect(store.status.sessionId).toBe("snap-session");
		});

		test("replays events in snapshot to derive status", () => {
			const store = new EventStore();
			const events = [
				makeEvent("session_start", { model: "gpt-4o" }),
				makeEvent("plan_end", { turn: 1, usage: { input_tokens: 100, output_tokens: 50 } }),
				makeEvent("context_update", { context_tokens: 500, context_window_size: 128000 }),
			];

			store.processMessage(snapshotMessage(events, { id: "s1", status: "running" }));

			expect(store.status.model).toBe("gpt-4o");
			expect(store.status.status).toBe("running");
			expect(store.status.turns).toBe(1);
			expect(store.status.inputTokens).toBe(100);
			expect(store.status.outputTokens).toBe(50);
			expect(store.status.contextTokens).toBe(500);
			expect(store.status.contextWindowSize).toBe(128000);
		});

		test("second snapshot replaces first", () => {
			const store = new EventStore();

			store.processMessage(snapshotMessage([makeEvent("session_start", { model: "gpt-4o" })]));
			expect(store.events).toHaveLength(1);
			expect(store.status.model).toBe("gpt-4o");

			const newEvents = [makeEvent("session_start", { model: "claude-sonnet-4-6" })];
			store.processMessage(snapshotMessage(newEvents, { id: "s2", status: "idle" }));

			expect(store.events).toEqual(newEvents);
			expect(store.status.model).toBe("claude-sonnet-4-6");
			expect(store.status.sessionId).toBe("s2");
		});
	});

	describe("event appending", () => {
		test("appends events to the array", () => {
			const store = new EventStore();
			const e1 = makeEvent("session_start", { model: "claude-sonnet-4-6" });
			const e2 = makeEvent("plan_start", { turn: 1 });

			store.processMessage(eventMessage(e1));
			store.processMessage(eventMessage(e2));

			expect(store.events).toEqual([e1, e2]);
		});
	});

	describe("status derivation: session_start", () => {
		test("sets status to running and captures model", () => {
			const store = new EventStore();

			store.processMessage(eventMessage(makeEvent("session_start", { model: "claude-opus-4-6" })));

			expect(store.status.status).toBe("running");
			expect(store.status.model).toBe("claude-opus-4-6");
		});

		test("preserves existing model when event has no model", () => {
			const store = new EventStore();
			store.processMessage(eventMessage(makeEvent("session_start", { model: "gpt-4o" })));
			store.processMessage(eventMessage(makeEvent("session_end")));
			store.processMessage(eventMessage(makeEvent("session_start", {})));

			expect(store.status.model).toBe("gpt-4o");
		});
	});

	describe("status derivation: session_end", () => {
		test("sets status to idle and resets tokens", () => {
			const store = new EventStore();
			store.processMessage(eventMessage(makeEvent("session_start", { model: "gpt-4o" })));
			store.processMessage(
				eventMessage(makeEvent("plan_end", { turn: 1, usage: { input_tokens: 100, output_tokens: 50 } })),
			);

			store.processMessage(eventMessage(makeEvent("session_end")));

			expect(store.status.status).toBe("idle");
			expect(store.status.inputTokens).toBe(0);
			expect(store.status.outputTokens).toBe(0);
		});
	});

	describe("status derivation: interrupted", () => {
		test("sets status to interrupted", () => {
			const store = new EventStore();
			store.processMessage(eventMessage(makeEvent("session_start", { model: "gpt-4o" })));

			store.processMessage(eventMessage(makeEvent("interrupted")));

			expect(store.status.status).toBe("interrupted");
		});
	});

	describe("status derivation: session_clear", () => {
		test("resets events and updates sessionId", () => {
			const store = new EventStore();
			store.processMessage(eventMessage(makeEvent("session_start", { model: "gpt-4o" })));
			store.processMessage(
				eventMessage(makeEvent("plan_end", { turn: 1, usage: { input_tokens: 100, output_tokens: 50 } })),
			);

			store.processMessage(eventMessage(makeEvent("session_clear", { new_session_id: "new-session" })));

			// session_clear event itself is preserved so the UI can show "New session started"
			expect(store.events).toHaveLength(1);
			expect(store.events[0]!.kind).toBe("session_clear");
			expect(store.status.sessionId).toBe("new-session");
			expect(store.status.status).toBe("idle");
			expect(store.status.inputTokens).toBe(0);
			expect(store.status.outputTokens).toBe(0);
			expect(store.status.turns).toBe(0);
			expect(store.status.contextTokens).toBe(0);
			expect(store.status.contextWindowSize).toBe(0);
			expect(store.status.model).toBe("");
		});
	});

	describe("status derivation: context_update", () => {
		test("updates context tokens and window size", () => {
			const store = new EventStore();

			store.processMessage(
				eventMessage(makeEvent("context_update", { context_tokens: 1234, context_window_size: 200000 })),
			);

			expect(store.status.contextTokens).toBe(1234);
			expect(store.status.contextWindowSize).toBe(200000);
		});

		test("preserves existing values when fields are missing", () => {
			const store = new EventStore();
			store.processMessage(
				eventMessage(makeEvent("context_update", { context_tokens: 500, context_window_size: 128000 })),
			);

			store.processMessage(eventMessage(makeEvent("context_update", { context_tokens: 600 })));

			expect(store.status.contextTokens).toBe(600);
			expect(store.status.contextWindowSize).toBe(128000);
		});
	});

	describe("status derivation: plan_end", () => {
		test("accumulates input/output tokens and updates turns", () => {
			const store = new EventStore();

			store.processMessage(
				eventMessage(makeEvent("plan_end", { turn: 1, usage: { input_tokens: 100, output_tokens: 50 } })),
			);
			store.processMessage(
				eventMessage(makeEvent("plan_end", { turn: 2, usage: { input_tokens: 200, output_tokens: 75 } })),
			);

			expect(store.status.turns).toBe(2);
			expect(store.status.inputTokens).toBe(300);
			expect(store.status.outputTokens).toBe(125);
		});

		test("handles missing usage gracefully", () => {
			const store = new EventStore();

			store.processMessage(eventMessage(makeEvent("plan_end", { turn: 1 })));

			expect(store.status.turns).toBe(1);
			expect(store.status.inputTokens).toBe(0);
			expect(store.status.outputTokens).toBe(0);
		});
	});

	describe("events that don't affect status", () => {
		test("appends events without changing status", () => {
			const store = new EventStore();

			store.processMessage(eventMessage(makeEvent("plan_start", { turn: 1 })));
			store.processMessage(eventMessage(makeEvent("perceive")));
			store.processMessage(eventMessage(makeEvent("recall")));

			expect(store.events).toHaveLength(3);
			expect(store.status.status).toBe("idle");
		});
	});

	describe("sendCommand helper", () => {
		test("wraps command in CommandMessage and sends via callback", () => {
			const sent: object[] = [];
			const store = new EventStore();
			const sendCommand = store.createSendCommand((msg: object) => sent.push(msg));

			sendCommand({ kind: "submit_goal", data: { goal: "hello" } });

			expect(sent).toHaveLength(1);
			expect(sent[0]).toEqual({
				type: "command",
				command: { kind: "submit_goal", data: { goal: "hello" } },
			});
		});

		test("sends interrupt command", () => {
			const sent: object[] = [];
			const store = new EventStore();
			const sendCommand = store.createSendCommand((msg: object) => sent.push(msg));

			sendCommand({ kind: "interrupt", data: {} });

			expect((sent[0] as Record<string, unknown>).type).toBe("command");
			const command = (sent[0] as { command: { kind: string } }).command;
			expect(command.kind).toBe("interrupt");
		});
	});

	describe("full session lifecycle", () => {
		test("tracks a complete session from start to end", () => {
			const store = new EventStore();

			// Connect and get snapshot
			store.processMessage(snapshotMessage([], { id: "session-1", status: "idle" }));
			expect(store.status.sessionId).toBe("session-1");
			expect(store.status.status).toBe("idle");

			// Session starts
			store.processMessage(eventMessage(makeEvent("session_start", { model: "claude-sonnet-4-6" })));
			expect(store.status.status).toBe("running");
			expect(store.status.model).toBe("claude-sonnet-4-6");

			// Agent does work
			store.processMessage(eventMessage(makeEvent("plan_start", { turn: 1 })));
			store.processMessage(eventMessage(makeEvent("plan_delta", { text: "thinking..." })));
			store.processMessage(
				eventMessage(makeEvent("plan_end", { turn: 1, usage: { input_tokens: 500, output_tokens: 200 } })),
			);
			expect(store.status.turns).toBe(1);
			expect(store.status.inputTokens).toBe(500);

			// Context update
			store.processMessage(
				eventMessage(makeEvent("context_update", { context_tokens: 700, context_window_size: 200000 })),
			);
			expect(store.status.contextTokens).toBe(700);

			// Second turn
			store.processMessage(
				eventMessage(makeEvent("plan_end", { turn: 2, usage: { input_tokens: 600, output_tokens: 300 } })),
			);
			expect(store.status.turns).toBe(2);
			expect(store.status.inputTokens).toBe(1100);
			expect(store.status.outputTokens).toBe(500);

			// Session ends
			store.processMessage(eventMessage(makeEvent("session_end")));
			expect(store.status.status).toBe("idle");
			expect(store.status.inputTokens).toBe(0);
			expect(store.status.outputTokens).toBe(0);

			// All events accumulated
			expect(store.events).toHaveLength(7);
		});
	});

	describe("change notification", () => {
		test("notifies subscribers on processMessage", () => {
			const store = new EventStore();
			let notifyCount = 0;
			store.subscribe(() => {
				notifyCount++;
			});

			store.processMessage(eventMessage(makeEvent("session_start", { model: "gpt-4o" })));
			expect(notifyCount).toBe(1);

			store.processMessage(eventMessage(makeEvent("plan_start")));
			expect(notifyCount).toBe(2);
		});

		test("unsubscribe stops notifications", () => {
			const store = new EventStore();
			let notifyCount = 0;
			const unsub = store.subscribe(() => {
				notifyCount++;
			});

			store.processMessage(eventMessage(makeEvent("session_start", { model: "gpt-4o" })));
			expect(notifyCount).toBe(1);

			unsub();

			store.processMessage(eventMessage(makeEvent("plan_start")));
			expect(notifyCount).toBe(1);
		});
	});
});
