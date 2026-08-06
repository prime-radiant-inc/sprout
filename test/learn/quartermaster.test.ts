import { describe, expect, test } from "bun:test";
import type { Program } from "../../src/genome/program.ts";
import { validateProgram } from "../../src/genome/program.ts";
import type { Memory } from "../../src/kernel/types.ts";
import {
	type CellObservation,
	type CuratedAgent,
	curateAgents,
	curateMemories,
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

function agent(name: string, systemPrompt: string, description = `${name} agent`): CuratedAgent {
	return { name, description, system_prompt: systemPrompt };
}

describe("curateAgents", () => {
	test("retires never-delegated agents, consolidates near-duplicates, leaves healthy ones alone", () => {
		const agents: CuratedAgent[] = [
			agent("busy", "You review code."),
			agent("idle", "You write docs."),
			agent("dup_a", "You summarize   logs.", "Summarizer"),
			agent("dup_b", "You summarize logs.", "Summarizer"),
		];
		const proposals = curateAgents(agents, {
			delegatedAgentNames: new Set(["busy", "dup_a", "dup_b"]),
		});

		const retire = proposals.filter((p) => p.action === "retire");
		expect(retire).toHaveLength(1);
		expect(retire[0]!.targets).toEqual(["idle"]);

		const consolidate = proposals.filter((p) => p.action === "consolidate");
		expect(consolidate).toHaveLength(1);
		expect(consolidate[0]!.targets.sort()).toEqual(["dup_a", "dup_b"]);

		expect(proposals.some((p) => p.targets.includes("busy"))).toBe(false);
	});

	test("never proposes retiring the root agent even when it is never a delegation target", () => {
		const proposals = curateAgents([agent("root", "You are the root orchestrator.")], {
			delegatedAgentNames: new Set(),
		});
		expect(proposals).toHaveLength(0);
	});
});

const DAY_MS = 24 * 60 * 60 * 1000;

function memory(id: string, overrides: Partial<Memory> = {}): Memory {
	const now = Date.now();
	return {
		id,
		content: `memory ${id}`,
		tags: [],
		source: "test",
		created: now,
		last_used: now,
		use_count: 0,
		confidence: 0.8,
		...overrides,
	};
}

describe("curateMemories", () => {
	test("retires stale, low-confidence, never-used memories only", () => {
		const now = Date.now();
		const memories: Memory[] = [
			// stale + low confidence + never used → retire
			memory("stale_low", { created: now - 60 * DAY_MS, confidence: 0.2 }),
			// used → keep
			memory("used", { created: now - 60 * DAY_MS, confidence: 0.2, use_count: 3 }),
			// high confidence → keep
			memory("confident", { created: now - 60 * DAY_MS, confidence: 0.9 }),
			// too young → keep
			memory("young", { confidence: 0.1 }),
			// already archived → left alone
			memory("archived", { created: now - 60 * DAY_MS, confidence: 0.1, archived_at: now }),
		];
		const proposals = curateMemories(memories, { now });
		const retire = proposals.filter((p) => p.action === "retire");
		expect(retire).toHaveLength(1);
		expect(retire[0]!.targets).toEqual(["stale_low"]);
	});

	test("consolidates near-duplicate memory content by normalized key", () => {
		const memories: Memory[] = [
			memory("m1", { content: "Use tabs for  indentation." }),
			memory("m2", { content: "use tabs for indentation." }),
			memory("m3", { content: "Prefer bun over npm." }),
		];
		const proposals = curateMemories(memories);
		const consolidate = proposals.filter((p) => p.action === "consolidate");
		expect(consolidate).toHaveLength(1);
		expect(consolidate[0]!.targets.sort()).toEqual(["m1", "m2"]);
	});
});

describe("program parameterization (fabrication)", () => {
	const AMBIENT_NAMES = [
		"bind",
		"publish",
		"peek",
		"slice",
		"lines",
		"grep",
		"parse",
		"size",
		"get",
		"spawn",
		"args",
		"programs",
	];

	test("occurrences differing only in one string literal group into one candidate with a typed string param", () => {
		const observations: CellObservation[] = [
			{ code: "const v = await get('logs');\nreturn grep(v, 'alpha');", stumbled: false },
			{ code: "const v = await get('logs');\nreturn grep(v, 'beta');", stumbled: false },
			{ code: "const v = await get('logs');\nreturn grep(v, 'gamma');", stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.occurrences).toBe(3);

		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(validateProgram(prog).ok).toBe(true);
		expect(prog.params).toHaveLength(1);
		expect(prog.params[0]!.type).toBe("string");
		// The varying literal is lifted; the constant one stays.
		expect(prog.body).toContain(`args.${prog.params[0]!.name}`);
		expect(prog.body).toContain("'logs'");
		expect(prog.body).not.toContain("'alpha'");
	});

	test("occurrences differing only in a number literal produce a typed number param", () => {
		const observations: CellObservation[] = [
			{ code: "return slice(x, 0, 5);", stumbled: false },
			{ code: "return slice(x, 0, 9);", stumbled: false },
			{ code: "return slice(x, 0, 12);", stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(prog.params).toHaveLength(1);
		expect(prog.params[0]!.type).toBe("number");
		expect(prog.body).toContain("slice(x, 0, args.");
	});

	test("boolean literal variance produces a typed boolean param", () => {
		const observations: CellObservation[] = [
			{ code: "return parse(x, true);", stumbled: false },
			{ code: "return parse(x, false);", stumbled: false },
			{ code: "return parse(x, true);", stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(prog.params).toHaveLength(1);
		expect(prog.params[0]!.type).toBe("boolean");
	});

	test("structurally different occurrences do NOT group (fallback: no candidate)", () => {
		const observations: CellObservation[] = [
			{ code: "return grep(x, 'a');", stumbled: false },
			{ code: "return lines(grep(x, 'a'));", stumbled: false },
			{ code: "return grep(y, 'a');", stumbled: false },
		];
		expect(detectRecurringPatterns(observations)).toHaveLength(0);
	});

	test("identical occurrences keep today's exact behavior: no params, raw body", () => {
		const code = "const s = await get('summary');\nreturn lines(s).length;";
		const observations: CellObservation[] = [
			{ code, stumbled: false },
			{ code, stumbled: false },
			{ code, stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(prog.params).toEqual([]);
		expect(prog.body).toBe(code);
	});

	test("too many varying literals falls back to no params", () => {
		const observations: CellObservation[] = [
			{ code: "return bind('a', slice(x, 1, 2, 3, 4));", stumbled: false },
			{ code: "return bind('b', slice(x, 5, 6, 7, 8));", stumbled: false },
			{ code: "return bind('c', slice(x, 9, 10, 11, 12));", stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(prog.params).toEqual([]);
		expect(prog.body).toBe("return bind('a', slice(x, 1, 2, 3, 4));");
	});

	test("template literals are never masked: variance inside backticks does not group", () => {
		const observations: CellObservation[] = [
			{ code: "return bind('k', `v-` + a);", stumbled: false },
			{ code: "return bind('k', `w-` + a);", stumbled: false },
			{ code: "return bind('k', `x-` + a);", stumbled: false },
		];
		expect(detectRecurringPatterns(observations)).toHaveLength(0);
	});

	test("multiline semicolon-less occurrences keep their newlines in the inferred body", () => {
		const observations: CellObservation[] = [
			{ code: "let a = 1\nlet b = a + 5\nreturn b", stumbled: false },
			{ code: "let a = 1\nlet b = a + 9\nreturn b", stumbled: false },
			{ code: "let a = 1\nlet b = a + 12\nreturn b", stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(prog.params).toHaveLength(1);
		expect(prog.body).toContain("\n");
		expect(prog.body).toContain(`args.${prog.params[0]!.name}`);
		// The body must be valid when wrapped the way the cell worker wraps program
		// bodies (a function body receiving `args`).
		const fn = new Function("args", prog.body);
		expect(fn({ [prog.params[0]!.name]: 5 })).toBe(6);
	});

	test("ASI-sensitive bodies keep the newline after a bare return", () => {
		const observations: CellObservation[] = [
			{ code: "const t = 'x'\nfunction f(){\nreturn\n1\n}\nreturn f()", stumbled: false },
			{ code: "const t = 'y'\nfunction f(){\nreturn\n1\n}\nreturn f()", stumbled: false },
			{ code: "const t = 'z'\nfunction f(){\nreturn\n1\n}\nreturn f()", stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(prog.params).toHaveLength(1);
		// ASI: `return\n1` must stay two lines — collapsing it to `return 1`
		// silently changes the value the body produces.
		expect(prog.body).toContain("return\n1");
		const fn = new Function("args", prog.body);
		expect(fn({ [prog.params[0]!.name]: "x" })).toBeUndefined();
	});

	test("a varying string literal in object-key position bails to no params", () => {
		const observations: CellObservation[] = [
			{ code: "return bind('out', {'alpha': 1});", stumbled: false },
			{ code: "return bind('out', {'beta': 1});", stumbled: false },
			{ code: "return bind('out', {'gamma': 1});", stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		// `{args.arg1: 1}` would be a syntax error — conservative fallback wins.
		expect(prog.params).toEqual([]);
		expect(prog.body).toBe("return bind('out', {'alpha': 1});");
	});

	test("a template-literal-bearing group bails to no params with the verbatim body", () => {
		const code = "const k = `v-` + 1\nreturn bind('k', k);";
		const observations: CellObservation[] = [
			{ code, stumbled: false },
			{ code, stumbled: false },
			{ code, stumbled: false },
		];
		const candidates = detectRecurringPatterns(observations);
		expect(candidates).toHaveLength(1);
		const prog = proposeProgramFromCandidate(candidates[0]!);
		expect(prog.params).toEqual([]);
		expect(prog.body).toBe(code);
	});

	test("inferred param names are valid identifiers and avoid ambient API names", () => {
		const observations: CellObservation[] = [
			{ code: "return grep(get('x'), 'one');", stumbled: false },
			{ code: "return grep(get('x'), 'two');", stumbled: false },
			{ code: "return grep(get('x'), 'three');", stumbled: false },
		];
		const prog = proposeProgramFromCandidate(detectRecurringPatterns(observations)[0]!);
		for (const param of prog.params) {
			expect(param.name).toMatch(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
			expect(AMBIENT_NAMES).not.toContain(param.name);
		}
	});
});
