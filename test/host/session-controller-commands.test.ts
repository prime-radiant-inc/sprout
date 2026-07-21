import { describe, expect, test } from "bun:test";
import { createSessionCommandHandlers } from "../../src/host/session-controller-commands.ts";
import type { Command } from "../../src/kernel/types.ts";
import type { SessionSelectionRequest } from "../../src/shared/session-selection.ts";

describe("createSessionCommandHandlers", () => {
	test("routes each command kind to the matching action", () => {
		const calls: string[] = [];
		let submitGoal: string | undefined;
		let steerText: string | undefined;
		let switchedModel: unknown;

		const actions = {
			submitGoal: (goal: string) => {
				calls.push("submit_goal");
				submitGoal = goal;
			},
			steer: (text: string) => {
				calls.push("steer");
				steerText = text;
			},
			interrupt: () => {
				calls.push("interrupt");
			},
			compact: () => {
				calls.push("compact");
			},
			clear: () => {
				calls.push("clear");
			},
			switchModel: (selection: SessionSelectionRequest | undefined) => {
				calls.push("switch_model");
				switchedModel = selection;
			},
			quit: () => {
				calls.push("quit");
			},
		};

		const commands: Command[] = [
			{ kind: "submit_goal", data: { goal: "ship it" } },
			{ kind: "steer", data: { text: "focus tests" } },
			{ kind: "interrupt", data: {} },
			{ kind: "compact", data: {} },
			{ kind: "clear", data: {} },
			{ kind: "switch_model", data: { selection: { kind: "tier", tier: "fast" } } },
			{ kind: "quit", data: {} },
		];

		const handlers = createSessionCommandHandlers(actions) as unknown as Record<
			string,
			(data: Record<string, unknown>) => void
		>;
		for (const cmd of commands) {
			handlers[cmd.kind]?.(cmd.data);
		}

		expect(calls).toEqual([
			"submit_goal",
			"steer",
			"interrupt",
			"compact",
			"clear",
			"switch_model",
			"quit",
		]);
		expect(submitGoal).toBe("ship it");
		expect(steerText).toBe("focus tests");
		expect(switchedModel).toEqual({ kind: "tier", tier: "fast" });
	});

	test("passes inherit selection through switch_model", () => {
		let switchedModel: unknown = "unset";

		createSessionCommandHandlers({
			submitGoal: () => {},
			steer: () => {},
			interrupt: () => {},
			compact: () => {},
			clear: () => {},
			switchModel: (selection: SessionSelectionRequest | undefined) => {
				switchedModel = selection;
			},
			quit: () => {},
		}).switch_model({ selection: { kind: "inherit" } });

		expect(switchedModel).toEqual({ kind: "inherit" });
	});
});
