import { describe, expect, test } from "bun:test";
import { parseAgentMarkdown, serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";

describe("parseAgentMarkdown", () => {
	test("parses frontmatter and markdown body", () => {
		const content = [
			"---",
			"name: reader",
			'description: "Find and read files"',
			"model: fast",
			"tools:",
			"  - read_file",
			"  - grep",
			"agents: []",
			"constraints:",
			"  max_turns: 20",
			"  can_spawn: false",
			"  requires_tool_use: true",
			"tags: [core]",
			"version: 2",
			"---",
			"You are a reader.",
			"",
			"Read files and return information.",
		].join("\n");

		const spec = parseAgentMarkdown(content, "reader.md");
		expect(spec.name).toBe("reader");
		expect(spec.description).toBe("Find and read files");
		expect(spec.system_prompt).toBe("You are a reader.\n\nRead files and return information.");
		expect(spec.model).toBe("fast");
		expect(spec.tools).toEqual(["read_file", "grep"]);
		expect(spec.agents).toEqual([]);
		expect(spec.tools).toEqual(["read_file", "grep"]);
		expect(spec.constraints.can_spawn).toBe(false);
		expect(spec.constraints.requires_tool_use).toBe(true);
	});

	test("throws on missing frontmatter delimiter", () => {
		expect(() => parseAgentMarkdown("no frontmatter here", "bad.md")).toThrow();
	});

	test("throws on missing required fields", () => {
		const noName = ["---", "description: test", "model: fast", "---", "prompt"].join("\n");
		expect(() => parseAgentMarkdown(noName, "bad.md")).toThrow(/name/);
	});

	test("defaults tools and agents to empty arrays", () => {
		const content = [
			"---",
			"name: minimal",
			'description: "A minimal agent"',
			"model: fast",
			"---",
			"You are minimal.",
		].join("\n");
		const spec = parseAgentMarkdown(content, "minimal.md");
		expect(spec.tools).toEqual([]);
		expect(spec.agents).toEqual([]);
	});

	test("trims trailing whitespace from markdown body", () => {
		const content = ["---", "name: t", 'description: "t"', "model: fast", "---", "body  \n\n"].join(
			"\n",
		);
		const spec = parseAgentMarkdown(content, "t.md");
		expect(spec.system_prompt).toBe("body");
	});

	test("parses CRLF line endings correctly", () => {
		const content = [
			"---",
			"name: crlf-agent",
			'description: "CRLF test"',
			"model: fast",
			"tools:",
			"  - read_file",
			"---",
			"Body with CRLF.",
		].join("\r\n");
		const spec = parseAgentMarkdown(content, "crlf.md");
		expect(spec.name).toBe("crlf-agent");
		expect(spec.description).toBe("CRLF test");
		expect(spec.tools).toEqual(["read_file"]);
		expect(spec.system_prompt).toBe("Body with CRLF.");
	});

	test("non-overridden constraints retain DEFAULT_CONSTRAINTS values", () => {
		const content = [
			"---",
			"name: partial",
			'description: "partial constraints"',
			"model: fast",
			"constraints:",
			"  can_spawn: false",
			"---",
			"Prompt.",
		].join("\n");
		const spec = parseAgentMarkdown(content, "partial.md");
		expect(spec.constraints.can_spawn).toBe(false);
		expect(spec.constraints.max_turns).toBe(50);
		expect("max_depth" in spec.constraints).toBe(false);
		expect(spec.constraints.timeout_ms).toBe(300_000);
		expect(spec.constraints.can_learn).toBe(false);
	});

	test("rejects removed constraint keys", () => {
		const content = [
			"---",
			"name: t",
			'description: "t"',
			"model: fast",
			"constraints:",
			"  max_depth: 3",
			"---",
			"body",
		].join("\n");

		expect(() => parseAgentMarkdown(content, "t.md")).toThrow(/max_depth/);
	});

	test("throws when tools is not an array", () => {
		const content = [
			"---",
			"name: t",
			'description: "t"',
			"model: fast",
			"tools: read_file",
			"---",
			"body",
		].join("\n");
		expect(() => parseAgentMarkdown(content, "t.md")).toThrow(/tools.*array/);
	});

	test("throws when agents is not an array", () => {
		const content = [
			"---",
			"name: t",
			'description: "t"',
			"model: fast",
			"agents: helper",
			"---",
			"body",
		].join("\n");
		expect(() => parseAgentMarkdown(content, "t.md")).toThrow(/agents.*array/);
	});

	test("parses thinking field when present", () => {
		const content = [
			"---",
			"name: thinker",
			'description: "thinks"',
			"model: best",
			"thinking:",
			"  budget_tokens: 5000",
			"---",
			"Think deeply.",
		].join("\n");
		const spec = parseAgentMarkdown(content, "thinker.md");
		expect(spec.thinking).toEqual({ budget_tokens: 5000 });
	});

	test("rejects invalid thinking config", () => {
		const cases: Array<[string, RegExp]> = [
			["thinking: maybe", /thinking.*boolean or object/],
			["thinking:\n  enabled: true", /unknown thinking key 'enabled'/],
			["thinking:\n  budget_tokens: 0", /thinking\.budget_tokens.*positive integer/],
			["thinking:\n  budget_tokens: 1023", /thinking\.budget_tokens.*at least 1024/],
			["thinking:\n  budget_tokens: 1.5", /thinking\.budget_tokens.*positive integer/],
			["thinking:\n  budget_tokens: lots", /thinking\.budget_tokens.*positive integer/],
		];

		for (const [thinking, error] of cases) {
			const content = [
				"---",
				"name: thinker",
				'description: "thinks"',
				"model: best",
				thinking,
				"---",
				"Think deeply.",
			].join("\n");
			expect(() => parseAgentMarkdown(content, "thinker.md")).toThrow(error);
		}
	});

	test("parses sampling config when present", () => {
		const content = [
			"---",
			"name: exact-editor",
			'description: "edits exactly"',
			"model: fast",
			"sampling:",
			"  temperature: 0",
			"---",
			"Edit exactly.",
		].join("\n");
		const spec = parseAgentMarkdown(content, "exact-editor.md");
		expect(spec.sampling).toEqual({ temperature: 0 });
	});

	test("rejects invalid sampling config", () => {
		const cases: Array<[string, RegExp]> = [
			["sampling: false", /sampling.*object/],
			["sampling:\n  temperature: cold", /sampling\.temperature.*number/],
			["sampling:\n  temperature: -1", /sampling\.temperature.*between 0 and 2/],
			["sampling:\n  top_p: 0.5", /unknown sampling key 'top_p'/],
		];

		for (const [sampling, error] of cases) {
			const content = [
				"---",
				"name: exact-editor",
				'description: "edits exactly"',
				"model: fast",
				sampling,
				"---",
				"Edit exactly.",
			].join("\n");
			expect(() => parseAgentMarkdown(content, "exact-editor.md")).toThrow(error);
		}
	});

	test("parses subcortical recall config when present", () => {
		const content = [
			"---",
			"name: root",
			'description: "coordinates work"',
			"model: best",
			"subcortical_recall:",
			"  enabled: true",
			"  max_tokens: 300",
			"---",
			"Coordinate work.",
		].join("\n");
		const spec = parseAgentMarkdown(content, "root.md");
		expect(spec.subcortical_recall).toEqual({ enabled: true, max_tokens: 300 });
	});

	test("rejects invalid subcortical recall config", () => {
		const cases: Array<[string, RegExp]> = [
			['subcortical_recall: "false"', /subcortical_recall.*boolean or object/],
			["subcortical_recall:\n  enabled: yes", /subcortical_recall\.enabled.*boolean/],
			["subcortical_recall:\n  max_tokens: 0", /subcortical_recall\.max_tokens.*positive/],
			["subcortical_recall:\n  model: fast", /unknown subcortical_recall key 'model'/],
		];

		for (const [frontmatter, error] of cases) {
			const content = [
				"---",
				"name: root",
				'description: "coordinates work"',
				"model: best",
				frontmatter,
				"---",
				"Coordinate work.",
			].join("\n");

			expect(() => parseAgentMarkdown(content, "root.md")).toThrow(error);
		}
	});

	test("accepts provider-qualified model refs in frontmatter", () => {
		const content = [
			"---",
			"name: coder",
			'description: "writes code"',
			"model: openai:gpt-4.1",
			"---",
			"Build features.",
		].join("\n");

		const spec = parseAgentMarkdown(content, "coder.md");
		expect(spec.model).toBe("openai:gpt-4.1");
	});

	test("rejects bare model ids in frontmatter", () => {
		const content = [
			"---",
			"name: coder",
			'description: "writes code"',
			"model: claude-sonnet-4-6",
			"---",
			"Build features.",
		].join("\n");

		expect(() => parseAgentMarkdown(content, "coder.md")).toThrow(/provider-qualified/);
	});

	test("rejects inherit in frontmatter", () => {
		const content = [
			"---",
			"name: coder",
			'description: "writes code"',
			"model: inherit",
			"---",
			"Build features.",
		].join("\n");

		expect(() => parseAgentMarkdown(content, "coder.md")).toThrow(/inherit/);
	});

	test("parses static observer configs", () => {
		const content = [
			"---",
			"name: root",
			'description: "coordinates work"',
			"model: best",
			"observers:",
			"  - agent: metacognitive",
			"    target: root",
			"    events: [plan_end, warning, error, primitive_end, act_end, compaction, interrupted]",
			"    trigger:",
			"      every: 3",
			"      event: plan_end",
			"    delivery:",
			"      max_events: 24",
			"      max_chars: 6000",
			"observe_delegates:",
			"  - agent: metacognitive",
			"    trigger: on_delegate_final",
			"    events: [plan_end, warning, error, act_end]",
			"    delivery:",
			"      max_events: 12",
			"      max_chars: 3000",
			"---",
			"Coordinate work.",
		].join("\n");

		const spec = parseAgentMarkdown(content, "root.md");
		expect(spec.observers).toEqual([
			{
				agent: "metacognitive",
				target: "root",
				events: [
					"plan_end",
					"warning",
					"error",
					"primitive_end",
					"act_end",
					"compaction",
					"interrupted",
				],
				trigger: { every: 3, event: "plan_end" },
				delivery: { max_events: 24, max_chars: 6000 },
			},
		]);
		expect(spec.observe_delegates).toEqual([
			{
				agent: "metacognitive",
				trigger: "on_delegate_final",
				events: ["plan_end", "warning", "error", "act_end"],
				delivery: { max_events: 12, max_chars: 3000 },
			},
		]);
	});

	test("serializes observer configs as known frontmatter", () => {
		const spec = parseAgentMarkdown(
			[
				"---",
				"name: root",
				'description: "coordinates work"',
				"model: best",
				"observers:",
				"  - agent: metacognitive",
				"    target: session",
				"    events: [plan_end]",
				"    trigger:",
				"      every: 1",
				"      event: plan_end",
				"---",
				"Coordinate work.",
			].join("\n"),
			"root.md",
		);

		const serialized = serializeAgentMarkdown(spec);
		expect(serialized).toContain("observers:");
		expect(serialized).toContain("target: session");
		expect(serialized).not.toContain("_extra");
	});

	test("rejects invalid observer configs", () => {
		const cases: Array<[string, RegExp]> = [
			["observers: nope", /observers.*array/],
			[
				"observers:\n  - agent: metacognitive\n    target: delegate\n    events: [plan_end]\n    trigger:\n      every: 1\n      event: plan_end",
				/target.*root or session/,
			],
			[
				"observers:\n  - agent: metacognitive\n    target: root\n    events: [not_real]\n    trigger:\n      every: 1\n      event: not_real",
				/not a known event kind/,
			],
			[
				"observers:\n  - agent: metacognitive\n    target: root\n    events: [warning]\n    trigger:\n      every: 1\n      event: plan_end",
				/trigger.*event.*listed in events/,
			],
			[
				"observers:\n  - agent: metacognitive\n    target: root\n    events: [plan_end]\n    trigger:\n      every: 0\n      event: plan_end",
				/every.*positive integer/,
			],
			[
				"observers:\n  - agent: metacognitive\n    target: root\n    events: [plan_end]\n    trigger:\n      every: 1\n      event: plan_end\n    comments:\n      can_message: [root]",
				/unknown .* key 'comments'/,
			],
			[
				"observe_delegates:\n  - agent: metacognitive\n    trigger: every_turn\n    events: [act_end]",
				/observe_delegates\[0\]\.trigger.*on_delegate_final/,
			],
			[
				"observe_delegates:\n  - agent: metacognitive\n    trigger: on_delegate_final\n    events: [plan_end]",
				/observe_delegates\[0\]\.events.*act_end/,
			],
		];

		for (const [frontmatter, error] of cases) {
			const content = [
				"---",
				"name: root",
				'description: "coordinates work"',
				"model: best",
				frontmatter,
				"---",
				"Coordinate work.",
			].join("\n");

			expect(() => parseAgentMarkdown(content, "root.md")).toThrow(error);
		}
	});
});
