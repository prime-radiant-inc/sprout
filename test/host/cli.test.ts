import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/host/cli.ts";

const defaultGenomePath = join(homedir(), ".local/share/sprout-genome");

describe("parseArgs", () => {
	test("no args → interactive mode", () => {
		const result = parseArgs([]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt returns oneshot mode", () => {
		const result = parseArgs(["--prompt", "Fix the bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with multiple words joins them", () => {
		const result = parseArgs(["--prompt", "Fix", "the", "bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with no goal returns help", () => {
		const result = parseArgs(["--prompt"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("bare goal returns oneshot mode", () => {
		const result = parseArgs(["Fix the bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume returns resume mode", () => {
		const result = parseArgs(["--resume", "01ABC123"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC123",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume with no session ID returns help", () => {
		const result = parseArgs(["--resume"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--resume-last returns resume-last mode", () => {
		const result = parseArgs(["--resume-last"]);
		expect(result).toEqual({
			kind: "resume-last",
			genomePath: defaultGenomePath,
		});
	});

	test("--list returns list mode", () => {
		const result = parseArgs(["--list"]);
		expect(result).toEqual({
			kind: "list",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome list → genome-list command", () => {
		const result = parseArgs(["--genome", "list"]);
		expect(result).toEqual({
			kind: "genome-list",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome log → genome-log command", () => {
		const result = parseArgs(["--genome", "log"]);
		expect(result).toEqual({
			kind: "genome-log",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome rollback <commit> → genome-rollback command", () => {
		const result = parseArgs(["--genome", "rollback", "abc123"]);
		expect(result).toEqual({
			kind: "genome-rollback",
			genomePath: defaultGenomePath,
			commit: "abc123",
		});
	});

	test("--genome-path with goal → oneshot with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path", "Fix bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix bug",
			genomePath: "/custom/path",
		});
	});

	test("--genome-path with no args → interactive with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: "/custom/path",
		});
	});

	test("--help → help", () => {
		const result = parseArgs(["--help"]);
		expect(result).toEqual({ kind: "help" });
	});
});
