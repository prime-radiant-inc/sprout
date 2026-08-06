import { describe, expect, it } from "bun:test";
import {
	type Program,
	parseProgramMarkdown,
	programsReferencedInCode,
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

const AGENT_SKILLS = `---
name: summarize
description: Summarize a bound log value
version: 1.2.0
platforms:
  - linux
  - macos
license: Apache-2.0
allowed-tools:
  - Read
  - Grep
metadata:
  acme:
    tags:
      - text
    related_skills:
      - distill
params:
  - name: log
    type: string
    description: the value name of the log to summarize
spawns:
  - reader
---
const text = await get(args.log);
return bind("summary", text.slice(0, 100));`;

describe("Agent-Skills-compatible metadata", () => {
	it("parses the Agent-Skills superset fields", () => {
		const program = parseProgramMarkdown(AGENT_SKILLS, "summarize.md");
		expect(program.name).toBe("summarize");
		expect(program.platforms).toEqual(["linux", "macos"]);
		expect(program.license).toBe("Apache-2.0");
		expect(program.allowedTools).toEqual(["Read", "Grep"]);
		expect(program.metadata).toEqual({
			acme: { tags: ["text"], related_skills: ["distill"] },
		});
		// sap-native typed fields survive alongside.
		expect(program.params).toEqual([
			{ name: "log", type: "string", description: "the value name of the log to summarize" },
		]);
		expect(program.spawns).toEqual(["reader"]);
	});

	it("derives the numeric version from a semver string, keeping it authoritative", () => {
		const program = parseProgramMarkdown(AGENT_SKILLS, "summarize.md");
		expect(program.semver).toBe("1.2.0");
		expect(program.version).toBe(1);
		// The linkage shape stays numeric.
		expect(programsReferencedInCode("programs.summarize({});", [program])).toEqual([
			{ name: "summarize", version: 1 },
		]);
	});

	it("round-trips the Agent-Skills fields byte-stable through serialize", () => {
		const program = parseProgramMarkdown(AGENT_SKILLS, "summarize.md");
		const once = serializeProgramMarkdown(program);
		const reparsed = parseProgramMarkdown(once, "summarize.md");
		expect(reparsed.platforms).toEqual(program.platforms);
		expect(reparsed.license).toBe(program.license);
		expect(reparsed.allowedTools).toEqual(program.allowedTools);
		expect(reparsed.metadata).toEqual(program.metadata);
		expect(reparsed.semver).toBe("1.2.0");
		expect(reparsed.version).toBe(1);
		// Serialize is a fixed point on its own output.
		expect(serializeProgramMarkdown(reparsed)).toBe(once);
	});

	it("still rejects an import-bearing Agent-Skills-shaped body", () => {
		const program = parseProgramMarkdown(
			`---\nname: bad\ndescription: sneaky\nversion: 2.0.0\nplatforms:\n  - linux\n---\nawait import("node:fs");`,
			"bad.md",
		);
		expect(validateProgram(program).ok).toBe(false);
	});

	it("leaves a sap-native program (no new fields) unchanged through serialize", () => {
		const program = parseProgramMarkdown(VALID, "summarize.md");
		expect(program.platforms).toBeUndefined();
		expect(program.license).toBeUndefined();
		expect(program.allowedTools).toBeUndefined();
		expect(program.metadata).toBeUndefined();
		expect(program.semver).toBeUndefined();
		const serialized = serializeProgramMarkdown(program);
		expect(serialized).not.toContain("platforms");
		expect(serialized).not.toContain("license");
		expect(serialized).not.toContain("allowed-tools");
		expect(serialized).toContain("version: 2");
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

describe("programsReferencedInCode", () => {
	const prog = (name: string, version: number): Program => ({
		name,
		description: name,
		params: [],
		spawns: [],
		version,
		body: "return 1;",
	});
	const library = [prog("distill", 2), prog("tally", 5)];

	it("resolves an invoked program to its name+version", () => {
		expect(programsReferencedInCode("return programs.distill({ log });", library)).toEqual([
			{ name: "distill", version: 2 },
		]);
	});

	it("resolves multiple distinct program invocations", () => {
		const code = "const a = await programs.distill({});\nreturn programs.tally({ a });";
		expect(programsReferencedInCode(code, library)).toEqual([
			{ name: "distill", version: 2 },
			{ name: "tally", version: 5 },
		]);
	});

	it("returns nothing when no program is referenced", () => {
		expect(programsReferencedInCode("return get('x');", library)).toEqual([]);
	});

	it("does not match a program name that is only a substring", () => {
		expect(programsReferencedInCode("return programs.distillery({});", library)).toEqual([]);
	});
});
