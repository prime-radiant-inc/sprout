import { describe, expect, test } from "bun:test";
import { registerInteractiveSigint } from "../../src/host/cli-sigint.ts";

interface Event {
	kind: string;
	data: Record<string, unknown>;
}

class FakeBus {
	readonly commands: Array<{ kind: string; data: Record<string, unknown> }> = [];
	readonly events: Event[] = [];
	private eventListeners: Array<(event: Event) => void> = [];

	emitCommand(cmd: { kind: string; data: Record<string, unknown> }) {
		this.commands.push(cmd);
	}

	emitEvent(kind: string, _agentId: string, _depth: number, data: Record<string, unknown>) {
		const event = { kind, data };
		this.events.push(event);
		for (const listener of this.eventListeners) listener(event);
	}

	onEvent(listener: (event: Event) => void) {
		this.eventListeners.push(listener);
	}
}

describe("registerInteractiveSigint", () => {
	test("first Ctrl+C while running emits interrupt; second emits quit and exits", () => {
		const bus = new FakeBus();
		const controller = { isRunning: true };
		let exited = 0;

		const registration = registerInteractiveSigint({
			bus: bus as any,
			controller,
			onExitNow: () => {
				exited++;
			},
			registerProcessListener: false,
			setTimer: (() => 1) as any,
			clearTimer: () => {},
		});

		registration.onSignal();
		expect(bus.commands.map((c) => c.kind)).toEqual(["interrupt"]);
		expect(exited).toBe(0);

		registration.onSignal();
		expect(bus.commands.map((c) => c.kind)).toEqual(["interrupt", "quit"]);
		expect(exited).toBe(1);
	});

	test("first Ctrl+C while idle shows exit hint and timer hides it", () => {
		const bus = new FakeBus();
		const controller = { isRunning: false };
		const timerRef: { current?: () => void } = {};

		const registration = registerInteractiveSigint({
			bus: bus as any,
			controller,
			onExitNow: () => {},
			registerProcessListener: false,
			setTimer: ((handler: () => void) => {
				timerRef.current = handler;
				return 9;
			}) as any,
			clearTimer: () => {},
		});

		registration.onSignal();
		expect(bus.events).toEqual([{ kind: "exit_hint", data: { visible: true } }]);

		timerRef.current?.();
		expect(bus.events).toEqual([
			{ kind: "exit_hint", data: { visible: true } },
			{ kind: "exit_hint", data: { visible: false } },
		]);
	});

	test("perceive and hidden exit_hint events clear pending state", () => {
		const bus = new FakeBus();
		const controller = { isRunning: false };

		const registration = registerInteractiveSigint({
			bus: bus as any,
			controller,
			onExitNow: () => {},
			registerProcessListener: false,
			setTimer: (() => 1) as any,
			clearTimer: () => {},
		});

		registration.onSignal();
		expect(bus.events.at(-1)).toEqual({ kind: "exit_hint", data: { visible: true } });

		bus.emitEvent("perceive", "root", 0, { goal: "new goal" });

		registration.onSignal();
		expect(bus.events.filter((e) => e.kind === "exit_hint")).toEqual([
			{ kind: "exit_hint", data: { visible: true } },
			{ kind: "exit_hint", data: { visible: true } },
		]);
		expect(bus.commands.map((c) => c.kind)).toEqual([]);
	});
});
