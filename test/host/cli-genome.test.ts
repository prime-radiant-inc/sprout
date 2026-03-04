import { describe, expect, test } from "bun:test";
import { isGenomeCommand } from "../../src/host/cli-genome.ts";

describe("isGenomeCommand", () => {
	test("returns true for genome maintenance commands", () => {
		expect(isGenomeCommand({ kind: "genome-list", genomePath: "/tmp/g" })).toBe(true);
		expect(isGenomeCommand({ kind: "genome-log", genomePath: "/tmp/g" })).toBe(true);
		expect(
			isGenomeCommand({ kind: "genome-rollback", genomePath: "/tmp/g", commit: "abc123" }),
		).toBe(true);
		expect(isGenomeCommand({ kind: "genome-export", genomePath: "/tmp/g" })).toBe(true);
		expect(isGenomeCommand({ kind: "genome-sync", genomePath: "/tmp/g" })).toBe(true);
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
