import { describe, expect, test } from "bun:test";
import { AgentEventEmitter, COLLECTED_EVENT_CAP } from "../../src/agents/events.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";

describe("AgentEventEmitter", () => {
	test("emit delivers events to listeners", () => {
		const emitter = new AgentEventEmitter();
		const received: SessionEvent[] = [];
		emitter.on((e) => received.push(e));

		emitter.emit("session_start", "agent-1", 0, { goal: "test" });

		expect(received).toHaveLength(1);
		expect(received[0]!.kind).toBe("session_start");
		expect(received[0]!.agent_id).toBe("agent-1");
		expect(received[0]!.depth).toBe(0);
		expect(received[0]!.data.goal).toBe("test");
	});

	test("unsubscribe removes listener", () => {
		const emitter = new AgentEventEmitter();
		const received: SessionEvent[] = [];
		const unsub = emitter.on((e) => received.push(e));

		emitter.emit("plan_start", "a", 0);
		unsub();
		emitter.emit("plan_end", "a", 0);

		expect(received).toHaveLength(1);
	});

	test("multiple listeners all receive events", () => {
		const emitter = new AgentEventEmitter();
		let count1 = 0;
		let count2 = 0;
		emitter.on(() => count1++);
		emitter.on(() => count2++);

		emitter.emit("perceive", "a", 0);

		expect(count1).toBe(1);
		expect(count2).toBe(1);
	});

	test("collected() returns all emitted events", () => {
		const emitter = new AgentEventEmitter();
		emitter.emit("session_start", "a", 0);
		emitter.emit("plan_start", "a", 0);
		emitter.emit("session_end", "a", 0);

		expect(emitter.collected()).toHaveLength(3);
		expect(emitter.collected()[0]!.kind).toBe("session_start");
	});

	test("retention is bounded: old events roll off past the window", () => {
		// The emitter previously retained every event for the process lifetime;
		// the learn loop's collected() scans are recent-biased, so a generous
		// ring buffer keeps them intact while long sessions stop growing.
		const emitter = new AgentEventEmitter();
		for (let i = 0; i < COLLECTED_EVENT_CAP + 250; i++) {
			emitter.emit("plan_start", `agent-${i}`, 0);
		}

		const collected = emitter.collected();
		expect(collected).toHaveLength(COLLECTED_EVENT_CAP);
		// The newest events survive; the oldest rolled off.
		expect(collected.at(-1)!.agent_id).toBe(`agent-${COLLECTED_EVENT_CAP + 249}`);
		expect(collected[0]!.agent_id).toBe("agent-250");
	});
});
