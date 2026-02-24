import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/host/event-bus.ts";
import type { Command, SessionEvent } from "../../src/kernel/types.ts";

describe("EventBus", () => {
	describe("agent events (up channel)", () => {
		test("emits events to subscribers", () => {
			const bus = new EventBus();
			const received: SessionEvent[] = [];
			bus.onEvent((e) => received.push(e));

			bus.emitEvent("session_start", "root", 0, { goal: "test" });

			expect(received).toHaveLength(1);
			expect(received[0]!.kind).toBe("session_start");
			expect(received[0]!.data.goal).toBe("test");
		});

		test("supports multiple subscribers", () => {
			const bus = new EventBus();
			let count1 = 0;
			let count2 = 0;
			bus.onEvent(() => count1++);
			bus.onEvent(() => count2++);

			bus.emitEvent("session_start", "root", 0);

			expect(count1).toBe(1);
			expect(count2).toBe(1);
		});

		test("unsubscribe stops delivery", () => {
			const bus = new EventBus();
			let count = 0;
			const unsub = bus.onEvent(() => count++);

			bus.emitEvent("session_start", "root", 0);
			unsub();
			bus.emitEvent("session_end", "root", 0);

			expect(count).toBe(1);
		});

		test("collected() returns all emitted events", () => {
			const bus = new EventBus();
			bus.emitEvent("session_start", "root", 0);
			bus.emitEvent("plan_start", "root", 0, { turn: 1 });

			const events = bus.collected();
			expect(events).toHaveLength(2);
			expect(events[0]!.kind).toBe("session_start");
			expect(events[1]!.kind).toBe("plan_start");
		});
	});

	describe("commands (down channel)", () => {
		test("delivers commands to subscribers", () => {
			const bus = new EventBus();
			const received: Command[] = [];
			bus.onCommand((c) => received.push(c));

			bus.emitCommand({ kind: "steer", data: { text: "try a different approach" } });

			expect(received).toHaveLength(1);
			expect(received[0]!.kind).toBe("steer");
			expect(received[0]!.data.text).toBe("try a different approach");
		});

		test("supports multiple command subscribers", () => {
			const bus = new EventBus();
			let count1 = 0;
			let count2 = 0;
			bus.onCommand(() => count1++);
			bus.onCommand(() => count2++);

			bus.emitCommand({ kind: "interrupt", data: {} });

			expect(count1).toBe(1);
			expect(count2).toBe(1);
		});

		test("unsubscribe stops command delivery", () => {
			const bus = new EventBus();
			let count = 0;
			const unsub = bus.onCommand(() => count++);

			bus.emitCommand({ kind: "interrupt", data: {} });
			unsub();
			bus.emitCommand({ kind: "quit", data: {} });

			expect(count).toBe(1);
		});
	});

	describe("compatibility with AgentEventEmitter interface", () => {
		test("emit() method matches AgentEventEmitter signature", () => {
			const bus = new EventBus();
			const received: SessionEvent[] = [];
			bus.on((e) => received.push(e));

			// Agent calls: this.events.emit(kind, agentId, depth, data)
			bus.emit("plan_end", "root", 0, { turn: 1, text: "hello" });

			expect(received).toHaveLength(1);
			expect(received[0]!.kind).toBe("plan_end");
		});

		test("on() returns unsubscribe function", () => {
			const bus = new EventBus();
			let count = 0;
			const unsub = bus.on(() => count++);

			bus.emit("session_start", "root", 0);
			unsub();
			bus.emit("session_end", "root", 0);

			expect(count).toBe(1);
		});
	});

	describe("event collection management", () => {
		test("clearEvents() empties the collected events", () => {
			const bus = new EventBus();
			bus.emitEvent("session_start", "root", 0);
			bus.emitEvent("plan_start", "root", 0);
			expect(bus.collected()).toHaveLength(2);

			bus.clearEvents();
			expect(bus.collected()).toHaveLength(0);
		});

		test("events array is capped at maximum", () => {
			const bus = new EventBus();
			// Emit more than the cap
			for (let i = 0; i < 11000; i++) {
				bus.emitEvent("plan_start", "root", 0, { turn: i });
			}
			// Should be capped, not 11000
			expect(bus.collected().length).toBeLessThanOrEqual(10000);
		});
	});
});
