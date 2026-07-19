import { describe, expect, it } from "bun:test";
import {
	parseProgramMarkdown,
	serializeProgramMarkdown,
	validateProgram,
} from "../../src/genome/program";

const VALID = `---
name: summarize
description: Summarize a bound log value
params:
  - name: log
    type: string
    description: the value name of the log to summarize
spawns:
  - reader
  - editor
version: 2
---
const text = await get(args.log);
return bind("summary", text.slice(0, 100));`;

describe("parseProgramMarkdown", () => {
	it("parses frontmatter and body into a Program", () => {
		const program = parseProgramMarkdown(VALID, "summarize.md");
		expect(program.name).toBe("summarize");
		expect(program.description).toBe("Summarize a bound log value");
		expect(program.version).toBe(2);
		expect(program.body).toContain("await get(args.log)");
		expect(program.body).not.toContain("---");
	});

	it("round-trips typed params", () => {
		const program = parseProgramMarkdown(VALID, "summarize.md");
		expect(program.params).toEqual([
			{ name: "log", type: "string", description: "the value name of the log to summarize" },
		]);
		const reparsed = parseProgramMarkdown(serializeProgramMarkdown(program), "summarize.md");
		expect(reparsed.params).toEqual(program.params);
	});

	it("round-trips the spawns list", () => {
		const program = parseProgramMarkdown(VALID, "summarize.md");
		expect(program.spawns).toEqual(["reader", "editor"]);
		const reparsed = parseProgramMarkdown(serializeProgramMarkdown(program), "summarize.md");
		expect(reparsed.spawns).toEqual(["reader", "editor"]);
		expect(reparsed.body).toBe(program.body);
	});

	it("defaults params and spawns to empty arrays", () => {
		const program = parseProgramMarkdown(
			`---\nname: noop\ndescription: does nothing\n---\nreturn 1;`,
			"noop.md",
		);
		expect(program.params).toEqual([]);
		expect(program.spawns).toEqual([]);
		expect(program.version).toBe(1);
	});
});

describe("validateProgram", () => {
	it("accepts a valid program", () => {
		expect(validateProgram(parseProgramMarkdown(VALID, "summarize.md"))).toEqual({ ok: true });
	});

	it("rejects a body with dynamic import", () => {
		const program = parseProgramMarkdown(
			`---\nname: bad\ndescription: sneaky\n---\nawait import("node:child_process");`,
			"bad.md",
		);
		const result = validateProgram(program);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("import");
	});

	it("rejects a body with require(", () => {
		const program = parseProgramMarkdown(
			`---\nname: bad\ndescription: sneaky\n---\nconst cp = require("child_process");`,
			"bad.md",
		);
		expect(validateProgram(program).ok).toBe(false);
	});

	it("over-rejects the literal word import inside a string (v1 behavior, matches cells)", () => {
		const program = parseProgramMarkdown(
			`---\nname: talky\ndescription: mentions import in prose\n---\nreturn "please import this data";`,
			"talky.md",
		);
		expect(validateProgram(program).ok).toBe(false);
	});

	it("rejects an invalid program name", () => {
		const program = parseProgramMarkdown(
			`---\nname: Bad-Name\ndescription: x\n---\nreturn 1;`,
			"bad.md",
		);
		expect(validateProgram(program).ok).toBe(false);
	});
});
