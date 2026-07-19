import { describe, expect, test } from "bun:test";
import type { Program } from "../../src/genome/program.ts";
import { validateProgram } from "../../src/genome/program.ts";
import {
	type CellObservation,
	curatePrograms,
	detectRecurringPatterns,
	detectRepairCandidates,
	normalizeCellCode,
	proposeProgramFromCandidate,
} from "../../src/learn/quartermaster.ts";

function program(name: string, body: string, version = 1): Program {
	return { name, description: name, params: [], spawns: [], version, body };
}

describe("normalizeCellCode", () => {
	test("groups two cells that differ only in whitespace/comments", () => {
		const a = "const x = await get('a');\nreturn slice(x, 0, 5);";
		const b = "const x = await get('a');   // fetch\n\n  return slice(x,   0, 5);";
		expect(normalizeCellCode(a)).toBe(normalizeCellCode(b));
	});

	test("does NOT group two semantically different cells", () => {
		const a = "return slice(x, 0, 5);";
		const b = "return grep(x, 'needle');";
		expect(normalizeCellCode(a)).not.toBe(normalizeCellCode(b));
	});
});

describe("detectRecurringPatterns", () => {
	test("groups recurring cells, ignores singletons and already-program cells", () => {
		const recurring = "const s = await get('summary');\nreturn lines(s).length;";
		const observations: CellObservation[] = [
			{ code: recurring, stumbled: false },
			{ code: `${recurring}  // annotated`, stumbled: false },
			{ code: recurring.replace(/\n/g, "\n\n"), stumbled: false },
			// a one-off cell — must not become a candidate
			{ code: "return 42;", stumbled: false },
			// already a program invocation — excluded even though it repeats
			{
				code: "return programs.distill({});",
				program: { name: "distill", version: 1 },
				stumbled: false,
			},
			{
				code: "return programs.distill({});",
				program: { name: "distill", version: 1 },
				stumbled: false,
			},
			{
				code: "return programs.distill({});",
				program: { name: "distill", version: 1 },
				stumbled: false,
			},
		];

		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.occurrences).toBe(3);
		expect(candidates[0]!.code).toBe(recurring);
		expect(candidates[0]!.proposedName).toMatch(/^fabricated_[a-z0-9]+$/);
	});

	test("respects a custom minOccurrences", () => {
		const code = "return get('x');";
		const observations: CellObservation[] = [
			{ code, stumbled: false },
			{ code, stumbled: false },
		];
		expect(detectRecurringPatterns(observations)).toHaveLength(0);
		expect(detectRecurringPatterns(observations, { minOccurrences: 2 })).toHaveLength(1);
	});
});

describe("proposeProgramFromCandidate", () => {
	test("produces a validateProgram-passing Program", () => {
		const candidate = {
			code: "const s = await get('summary');\nreturn lines(s).length;",
			occurrences: 4,
			proposedName: "fabricated_abc123",
		};
		const prog = proposeProgramFromCandidate(candidate);
		expect(validateProgram(prog).ok).toBe(true);
		expect(prog.body).toBe(candidate.code);
		expect(prog.provenance).toBe("fabricated-from-pattern");
		expect(prog.version).toBe(1);
	});

	test("throws when the recurring code would fail validation", () => {
		const candidate = {
			code: "const x = require('fs');",
			occurrences: 5,
			proposedName: "fabricated_bad",
		};
		expect(() => proposeProgramFromCandidate(candidate)).toThrow();
	});
});

describe("detectRepairCandidates", () => {
	test("flags a high-stumble program and ignores a healthy one", () => {
		const observations: CellObservation[] = [
			// broken: 3/4 stumble
			{ code: "programs.broken({})", program: { name: "broken", version: 2 }, stumbled: true },
			{ code: "programs.broken({})", program: { name: "broken", version: 2 }, stumbled: true },
			{ code: "programs.broken({})", program: { name: "broken", version: 2 }, stumbled: true },
			{ code: "programs.broken({})", program: { name: "broken", version: 2 }, stumbled: false },
			// healthy: 0/4 stumble
			{ code: "programs.healthy({})", program: { name: "healthy", version: 1 }, stumbled: false },
			{ code: "programs.healthy({})", program: { name: "healthy", version: 1 }, stumbled: false },
			{ code: "programs.healthy({})", program: { name: "healthy", version: 1 }, stumbled: false },
			{ code: "programs.healthy({})", program: { name: "healthy", version: 1 }, stumbled: false },
		];
		const flagged = detectRepairCandidates(observations);
		expect(flagged).toHaveLength(1);
		expect(flagged[0]!.programName).toBe("broken");
		expect(flagged[0]!.version).toBe(2);
		expect(flagged[0]!.occurrences).toBe(4);
		expect(flagged[0]!.stumbleRate).toBeCloseTo(0.75);
	});

	test("does not flag a high-stumble program seen too few times", () => {
		const observations: CellObservation[] = [
			{ code: "programs.rare({})", program: { name: "rare", version: 1 }, stumbled: true },
			{ code: "programs.rare({})", program: { name: "rare", version: 1 }, stumbled: true },
		];
		expect(detectRepairCandidates(observations)).toHaveLength(0);
	});
});

describe("curatePrograms", () => {
	test("retires uninvoked, consolidates duplicates, leaves a healthy unique alone", () => {
		const programs: Program[] = [
			program("used_unique", "return get('a');"),
			program("never_used", "return get('b');"),
			program("dup_one", "return slice(x, 0, 5);"),
			program("dup_two", "return slice(x, 0, 5);   // same shape"),
		];
		const observations: CellObservation[] = [
			{
				code: "programs.used_unique({})",
				program: { name: "used_unique", version: 1 },
				stumbled: false,
			},
			{ code: "programs.dup_one({})", program: { name: "dup_one", version: 1 }, stumbled: false },
			{ code: "programs.dup_two({})", program: { name: "dup_two", version: 1 }, stumbled: false },
		];

		const proposals = curatePrograms(programs, observations);

		const retire = proposals.filter((p) => p.action === "retire");
		expect(retire).toHaveLength(1);
		expect(retire[0]!.targets).toEqual(["never_used"]);

		const consolidate = proposals.filter((p) => p.action === "consolidate");
		expect(consolidate).toHaveLength(1);
		expect(consolidate[0]!.targets.sort()).toEqual(["dup_one", "dup_two"]);

		// used_unique is invoked and unique — no proposal touches it.
		expect(proposals.some((p) => p.targets.includes("used_unique"))).toBe(false);
	});
});
