import { describe, expect, test } from "bun:test";
import { dispatchSessionCommand } from "../../src/host/session-controller-commands.ts";
import type { Command } from "../../src/kernel/types.ts";

describe("dispatchSessionCommand", () => {
	test("routes each command kind to the matching action", () => {
		const calls: string[] = [];
		let submitGoal: string | undefined;
		let steerText: string | undefined;
		let switchedModel: string | undefined;

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
			switchModel: (model: string | undefined) => {
				calls.push("switch_model");
				switchedModel = model;
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
			{ kind: "switch_model", data: { model: "fast" } },
			{ kind: "quit", data: {} },
		];

		for (const cmd of commands) {
			dispatchSessionCommand(cmd, actions);
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
		expect(switchedModel).toBe("fast");
	});

	test("passes undefined model through switch_model", () => {
		let switchedModel = "unset";

		dispatchSessionCommand(
			{ kind: "switch_model", data: { model: undefined } },
			{
				submitGoal: () => {},
				steer: () => {},
				interrupt: () => {},
				compact: () => {},
				clear: () => {},
				switchModel: (model) => {
					switchedModel = model ?? "undefined";
				},
				quit: () => {},
			},
		);

		expect(switchedModel).toBe("undefined");
	});

	test("throws clear error for unknown command kind", () => {
		expect(() =>
			dispatchSessionCommand(
				{ kind: "not_a_real_command", data: {} } as unknown as Command,
				{
					submitGoal: () => {},
					steer: () => {},
					interrupt: () => {},
					compact: () => {},
					clear: () => {},
					switchModel: () => {},
					quit: () => {},
				},
			),
		).toThrow("Unknown command kind");
	});
});
