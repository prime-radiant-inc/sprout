import { describe, expect, test } from "bun:test";
import { isGenomeCommand, renderGenomeSyncResult } from "../../src/host/cli-genome.ts";

describe("isGenomeCommand", () => {
	test("returns true for genome maintenance commands", () => {
		expect(isGenomeCommand({ kind: "genome-list", genomePath: "/tmp/g" })).toBe(true);
		expect(isGenomeCommand({ kind: "genome-log", genomePath: "/tmp/g" })).toBe(true);
		expect(
			isGenomeCommand({ kind: "genome-rollback", genomePath: "/tmp/g", commit: "abc123" }),
		).toBe(true);
		expect(isGenomeCommand({ kind: "genome-export", genomePath: "/tmp/g" })).toBe(true);
		expect(isGenomeCommand({ kind: "genome-sync", genomePath: "/tmp/g" })).toBe(true);
		expect(
			isGenomeCommand({
				kind: "genome-maintain",
				genomePath: "/tmp/g",
				apply: false,
				scope: "all",
			}),
		).toBe(true);
	});

	test("returns false for non-genome commands", () => {
		expect(isGenomeCommand({ kind: "help" })).toBe(false);
		expect(isGenomeCommand({ kind: "list", genomePath: "/tmp/g" })).toBe(false);
		expect(
			isGenomeCommand({
				kind: "oneshot",
				genomePath: "/tmp/g",
				goal: "hi",
			}),
		).toBe(false);
	});
});

describe("renderGenomeSyncResult", () => {
	test("reports up to date only when nothing changed", () => {
		expect(
			renderGenomeSyncResult({
				added: [],
				conflicts: [],
				addedPrograms: [],
				programConflicts: [],
			}),
		).toEqual(["Genome is up to date with root agents."]);
	});

	test("reports added programs instead of claiming up to date (A-F11)", () => {
		const lines = renderGenomeSyncResult({
			added: [],
			conflicts: [],
			addedPrograms: ["prog-a"],
			programConflicts: [],
		});
		expect(lines.join("\n")).not.toContain("up to date");
		expect(lines.join("\n")).toContain("prog-a");
	});

	test("reports program conflicts instead of claiming up to date (A-F11)", () => {
		const lines = renderGenomeSyncResult({
			added: [],
			conflicts: [],
			addedPrograms: [],
			programConflicts: ["prog-b"],
		});
		expect(lines.join("\n")).not.toContain("up to date");
		expect(lines.join("\n")).toContain("prog-b");
	});

	test("reports agent and program changes together", () => {
		const lines = renderGenomeSyncResult({
			added: ["agent-a"],
			conflicts: ["agent-b"],
			addedPrograms: ["prog-a"],
			programConflicts: ["prog-b"],
		});
		const output = lines.join("\n");
		expect(output).toContain("agent-a");
		expect(output).toContain("agent-b");
		expect(output).toContain("prog-a");
		expect(output).toContain("prog-b");
		expect(output).not.toContain("up to date");
	});
});
