import { describe, expect, test } from "bun:test";
import type {
	SettingsCommandResult,
	SettingsSnapshot,
} from "../../../src/host/settings/control-plane.ts";
import type { SessionSelectionSnapshot } from "../../../src/host/session-selection.ts";
import { createEmptySettings } from "../../../src/host/settings/types.ts";
import { EVENT_CAP } from "@kernel/constants.ts";
import type { BrowserCommand } from "@kernel/protocol.ts";
import type { SessionEvent } from "@kernel/types.ts";
import type { ServerMessage } from "../../../src/web/protocol.ts";
import { EventStore } from "./useEvents.ts";

// --- Helpers ---

function makeEvent(kind: SessionEvent["kind"], data: Record<string, unknown> = {}): SessionEvent {
	return { kind, timestamp: Date.now(), agent_id: "root", depth: 0, data };
}

function eventMessage(event: SessionEvent): ServerMessage {
	return { type: "event", event };
}

function makeSettingsSnapshot(): SettingsSnapshot {
	return {
		runtime: {
			secretBackend: {
				backend: "memory",
				available: true,
			},
			warnings: [],
		},
		settings: createEmptySettings(),
		providers: [],
		catalog: [],
	};
}

function makeCurrentSelection(): SessionSelectionSnapshot {
	return {
		selection: {
			kind: "model",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		},
		resolved: {
			providerId: "anthropic-main",
			modelId: "claude-sonnet-4-6",
		},
		source: "session",
	};
}

function snapshotMessage(
	events: SessionEvent[],
	session: {
		id: string;
		status: string;
		availableModels?: string[];
		currentModel?: string | null;
		currentSelection?: SessionSelectionSnapshot;
	} = { id: "test-session", status: "idle" },
	settings: SettingsSnapshot | null = null,
): ServerMessage {
	return {
		type: "snapshot",
		events,
		session: {
			id: session.id,
			status: session.status,
			availableModels: session.availableModels ?? [],
			currentModel: session.currentModel ?? null,
			currentSelection: session.currentSelection ?? makeCurrentSelection(),
			pricingTable: null,
		},
		settings,
	} as ServerMessage;
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
				availableModels: [],
				currentSelection: {
					selection: { kind: "inherit" },
					source: "runtime-fallback",
				},
				sessionStartedAt: null,
				pricingTable: null,
			});
			expect(store.settings).toBeNull();
			expect(store.lastSettingsResult).toBeNull();
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

		test("populates availableModels from snapshot session", () => {
			const store = new EventStore();
			const models = ["best", "balanced", "fast", "claude-opus-4-6", "claude-sonnet-4-6"];

			store.processMessage(
				snapshotMessage([], {
					id: "s1",
					status: "idle",
					availableModels: models,
					currentModel: "claude-sonnet-4-6",
				}),
			);

			expect(store.status.availableModels).toEqual(models);
		});

		test("defaults availableModels to empty array", () => {
			const store = new EventStore();

			store.processMessage(snapshotMessage([], { id: "s1", status: "idle" }));

			expect(store.status.availableModels).toEqual([]);
		});

		test("uses snapshot status and currentModel as authoritative", () => {
			const store = new EventStore();
			const events = [makeEvent("session_end")];

			store.processMessage(
				snapshotMessage(events, {
					id: "snap-session",
					status: "running",
					availableModels: ["best", "fast"],
					currentModel: "claude-sonnet-4-6",
				}),
			);

			expect(store.status.sessionId).toBe("snap-session");
			expect(store.status.status).toBe("running");
			expect(store.status.model).toBe("claude-sonnet-4-6");
			expect(store.status.availableModels).toEqual(["best", "fast"]);
		});

		test("stores currentSelection and settings from snapshot", () => {
			const store = new EventStore();
			const currentSelection = makeCurrentSelection();
			const settings = makeSettingsSnapshot();

			store.processMessage(
				snapshotMessage(
					[],
					{
						id: "snap-session",
						status: "idle",
						currentSelection,
					},
					settings,
				),
			);

			expect(store.status.currentSelection).toEqual(currentSelection);
			expect(store.settings).toEqual(settings);
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

		test("caps retained events to the most recent EVENT_CAP while appending", () => {
			const store = new EventStore();

			for (let index = 1; index <= EVENT_CAP + 3; index++) {
				store.processMessage(
					eventMessage(
						makeEvent("warning", {
							message: `event-${index}`,
						}),
					),
				);
			}

			expect(store.events).toHaveLength(EVENT_CAP);
			expect((store.events[0]!.data.message as string) ?? "").toBe("event-4");
			expect((store.events[store.events.length - 1]!.data.message as string) ?? "").toBe(
				`event-${EVENT_CAP + 3}`,
			);
		});

		test("prepends older history without changing current status", () => {
			const store = new EventStore();
			store.processMessage(
				snapshotMessage([makeEvent("session_start", { model: "gpt-4o" })], {
					id: "s1",
					status: "running",
					currentModel: "gpt-4o",
				}),
			);

			store.prependHistory([
				makeEvent("perceive", { goal: "older-goal" }),
				makeEvent("plan_end", { turn: 99, usage: { input_tokens: 1, output_tokens: 1 } }),
			]);

			expect(store.events).toHaveLength(3);
			expect(store.events[0]!.kind).toBe("perceive");
			expect(store.status.status).toBe("running");
			expect(store.status.model).toBe("gpt-4o");
			expect(store.status.turns).toBe(0);
		});

		test("deduplicates overlap when prepending older history", () => {
			const store = new EventStore();
			const shared = makeEvent("warning", { message: "shared" });
			store.processMessage(snapshotMessage([shared, makeEvent("warning", { message: "new" })]));

			store.prependHistory([makeEvent("warning", { message: "old" }), shared]);

			expect(store.events).toHaveLength(3);
			expect(store.events.map((event) => event.data.message)).toEqual(["old", "shared", "new"]);
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

		test("preserves availableModels across session_clear", () => {
			const store = new EventStore();
			store.processMessage(
				snapshotMessage([], {
					id: "s1",
					status: "idle",
					availableModels: ["best", "balanced", "fast"],
				}),
			);

			store.processMessage(eventMessage(makeEvent("session_clear", { new_session_id: "s2" })));

			expect(store.status.sessionId).toBe("s2");
			expect(store.status.availableModels).toEqual(["best", "balanced", "fast"]);
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

	describe("settings transport", () => {
		test("applies live settings_updated messages", () => {
			const store = new EventStore();
			const settings = makeSettingsSnapshot();

			store.processMessage(
				{
					type: "settings_updated",
					snapshot: settings,
				} as unknown as ServerMessage,
			);

			expect(store.settings).toEqual(settings);
		});

		test("retains runtime warnings from snapshots and successful settings results", () => {
			const store = new EventStore();
			const snapshot = makeSettingsSnapshot();
			snapshot.runtime.warnings = [
				{
					code: "invalid_settings_recovered",
					message: "Recovered invalid settings file to /tmp/settings.invalid.2026-03-12.json",
				},
			];

			store.processMessage(snapshotMessage([], undefined, snapshot));
			expect(store.settings?.runtime.warnings).toEqual(snapshot.runtime.warnings);

			const updated = structuredClone(snapshot);
			updated.runtime.warnings = [
				...updated.runtime.warnings,
				{
					code: "secret_backend_unavailable",
					message: "Unsupported secret backend for platform: win32",
				},
			];

			store.processMessage({
				type: "settings_result",
				result: {
					ok: true,
					snapshot: updated,
				},
			} as unknown as ServerMessage);

			expect(store.settings?.runtime.warnings).toEqual(updated.runtime.warnings);
		});

		test("retains the latest settings_result payload including field errors", () => {
			const store = new EventStore();
			const result: SettingsCommandResult = {
				ok: false,
				code: "validation_failed",
				message: "Provider label is required",
				fieldErrors: {
					label: "Label is required",
				},
			};

			store.processMessage(
				{
					type: "settings_result",
					result,
				} as unknown as ServerMessage,
			);

			expect(store.lastSettingsResult).toEqual(result);
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

		test("accepts settings commands", () => {
			const sent: object[] = [];
			const store = new EventStore();
			const sendCommand = store.createSendCommand((msg: object) => sent.push(msg));
			const command: BrowserCommand = { kind: "get_settings", data: {} };

			sendCommand(command);

			expect(sent[0]).toEqual({
				type: "command",
				command: { kind: "get_settings", data: {} },
			});
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
