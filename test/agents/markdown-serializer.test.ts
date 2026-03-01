import { describe, expect, test } from "bun:test";
import { parseAgentMarkdown, serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: "reader",
		description: "Find and read files",
		system_prompt: "You are a reader.\n\nRead files and return information.",
		model: "fast",
		tools: ["read_file", "grep"],
		agents: [],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 20, max_depth: 0, can_spawn: false },
		tags: ["core"],
		version: 2,
		...overrides,
	};
}

describe("serializeAgentMarkdown", () => {
	test("basic round-trip: parse(serialize(spec)) matches original", () => {
		const original = makeSpec();
		const serialized = serializeAgentMarkdown(original);
		const parsed = parseAgentMarkdown(serialized, "round-trip.md");

		expect(parsed.name).toBe(original.name);
		expect(parsed.description).toBe(original.description);
		expect(parsed.system_prompt).toBe(original.system_prompt);
		expect(parsed.model).toBe(original.model);
		expect(parsed.tools).toEqual(original.tools);
		expect(parsed.agents).toEqual(original.agents);
		expect(parsed.constraints).toEqual(original.constraints);
		expect(parsed.tags).toEqual(original.tags);
		expect(parsed.version).toBe(original.version);
	});

	test("system prompt is markdown body, not a YAML field", () => {
		const spec = makeSpec({ system_prompt: "# Title\n\nSome **bold** text.\n\n- list item" });
		const serialized = serializeAgentMarkdown(spec);

		// system_prompt should NOT appear in the frontmatter
		const fmEnd = serialized.indexOf("\n---\n", 4);
		const frontmatter = serialized.slice(0, fmEnd);
		expect(frontmatter).not.toContain("system_prompt");

		// system_prompt should be the body after the closing ---
		const body = serialized.slice(fmEnd + 5); // skip \n---\n
		expect(body.trim()).toBe(spec.system_prompt);
	});

	test("thinking field preserved through round-trip", () => {
		const spec = makeSpec({ thinking: { budget_tokens: 5000 } });
		const serialized = serializeAgentMarkdown(spec);
		const parsed = parseAgentMarkdown(serialized, "thinking.md");
		expect(parsed.thinking).toEqual({ budget_tokens: 5000 });
	});

	test("thinking boolean preserved through round-trip", () => {
		const spec = makeSpec({ thinking: true });
		const serialized = serializeAgentMarkdown(spec);
		const parsed = parseAgentMarkdown(serialized, "thinking-bool.md");
		expect(parsed.thinking).toBe(true);
	});

	test("unknown frontmatter fields survive via _extra", () => {
		const content = [
			"---",
			"name: reader",
			'description: "Find and read files"',
			"model: fast",
			"custom_field: hello",
			"another_thing: 42",
			"---",
			"You are a reader.",
		].join("\n");

		const parsed = parseAgentMarkdown(content, "extra.md");
		expect(parsed._extra).toEqual({ custom_field: "hello", another_thing: 42 });

		const serialized = serializeAgentMarkdown(parsed);
		const reparsed = parseAgentMarkdown(serialized, "extra-rt.md");
		expect(reparsed._extra).toEqual({ custom_field: "hello", another_thing: 42 });
	});

	test("_extra itself does not appear in serialized output", () => {
		const spec = makeSpec({ _extra: { custom: "value" } });
		const serialized = serializeAgentMarkdown(spec);
		expect(serialized).not.toContain("_extra");
	});

	test("capabilities does not appear in frontmatter", () => {
		const spec = makeSpec();
		const serialized = serializeAgentMarkdown(spec);
		const fmEnd = serialized.indexOf("\n---\n", 4);
		const frontmatter = serialized.slice(0, fmEnd);
		expect(frontmatter).not.toContain("capabilities");
	});
});
