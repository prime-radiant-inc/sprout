import { describe, expect, test } from "bun:test";
import { validateAgentSpec } from "../../src/agents/markdown-loader.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import { makeSpec } from "../helpers/make-spec.ts";

describe("validateAgentSpec — code-mode surface (sap §6)", () => {
	test("rejects a code-mode spec granting a real primitive", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					act: "code",
					tools: ["exec"],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: true },
				}),
			),
		).toThrow(/code mode grants no primitive tools/);
	});

	test("rejects a code-mode spec with can_spawn: false", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					act: "code",
					tools: [],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false },
				}),
			),
		).toThrow(/requires can_spawn: true/);
	});

	test("accepts a code-mode spec with an agents allowlist and no tools", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					act: "code",
					tools: [],
					agents: ["leaf"],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: true },
				}),
			),
		).not.toThrow();
	});

	test("accepts a code-mode spec granting only value_* reads", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					act: "code",
					tools: ["value_grep", "cell"],
					agents: ["leaf"],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: true },
				}),
			),
		).not.toThrow();
	});
});

describe("validateAgentSpec — flag-off-empty (sap §6)", () => {
	test("rejects a value_*-only leaf that cannot spawn", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					tools: ["value_grep"],
					agents: [],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false, max_turns: 5 },
				}),
			),
		).toThrow(/empty under data-plane-off/);
	});

	test("accepts the same value_*-only leaf when it can spawn", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					tools: ["value_grep"],
					agents: [],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: true, max_turns: 5 },
				}),
			),
		).not.toThrow();
	});

	test("accepts a spec whose real tool survives flag-off", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					tools: ["value_grep", "read_file"],
					agents: [],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false, max_turns: 5 },
				}),
			),
		).not.toThrow();
	});

	test("accepts the max_turns:1 completion exemption", () => {
		expect(() =>
			validateAgentSpec(
				makeSpec({
					tools: [],
					agents: [],
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false, max_turns: 1 },
				}),
			),
		).not.toThrow();
	});
});
