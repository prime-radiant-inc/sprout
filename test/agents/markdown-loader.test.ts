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
		expect(spec.tools).toEqual(["read_file", "grep"]);
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

	test("accepts bare model ids in frontmatter", () => {
		const content = [
			"---",
			"name: coder",
			'description: "writes code"',
			"model: claude-sonnet-4-6",
			"---",
			"Build features.",
		].join("\n");

		const spec = parseAgentMarkdown(content, "coder.md");
		expect(spec.model).toBe("claude-sonnet-4-6");
	});

	test("rejects provider-qualified model refs in frontmatter", () => {
		const content = [
			"---",
			"name: coder",
			'description: "writes code"',
			"model: openai:gpt-4.1",
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
});
