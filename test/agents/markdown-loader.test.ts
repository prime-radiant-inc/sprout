import { describe, expect, test } from "bun:test";
import { parseAgentMarkdown } from "../../src/agents/markdown-loader.ts";

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
			"  max_depth: 0",
			"  can_spawn: false",
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
		expect(spec.constraints.can_spawn).toBe(false);
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
});
