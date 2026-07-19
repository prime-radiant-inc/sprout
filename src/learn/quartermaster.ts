/**
 * The quartermaster (sap spec §7 / Phase 7 design). Pure analysis over recorded
 * cell_end observations + the current program library. Two jobs:
 *
 *   1. Program fabrication + repair — spot cell code shapes that recur across
 *      runs (fabricate a program from them) and programs whose invocations
 *      stumble at a high rate (flag them for repair/retirement).
 *   2. Curator pass — propose retirement of never-invoked programs and
 *      consolidation of near-duplicate programs, so the library does not rot.
 *
 * EVERYTHING here is a PROPOSAL, never an action. A fabricated program, a
 * repair, a retirement, a consolidation — each is a genome MUTATION and MUST go
 * through the SAME 7B gates as any other mutation (shouldAcceptMutation from
 * ./multi-run-ab.ts over N pinned eval runs, then the hidden canary suite from
 * ./canary-suite.ts) before adoption. The quartermaster never deletes or edits
 * the genome unilaterally.
 *
 * This module imports only genome types (Program) — NO host/, NO runtime. It is
 * a decision layer the live learn loop consumes, not a mutator.
 */

import { type Program, validateProgram } from "../genome/program.ts";

/**
 * One recorded cell run, derived from a cell_end event (spec §8). `program` is
 * present when the cell invoked a genome program (the cell_end code+program
 * linkage); `stumbled` is whether the run stumbled. The caller builds these
 * from the event stream — the quartermaster reasons only over the derived shape.
 */
export interface CellObservation {
	code: string;
	program?: { name: string; version: number };
	stumbled: boolean;
}

export interface FabricationCandidate {
	/** A representative instance of the recurring code (the first seen). */
	code: string;
	/** How many observations share this normalization key. */
	occurrences: number;
	/** A valid `programs.<name>` name proposed for the fabricated program. */
	proposedName: string;
}

export interface RepairCandidate {
	programName: string;
	version: number;
	/** Total invocations observed in the window. */
	occurrences: number;
	/** Fraction of invocations that stumbled (0..1). */
	stumbleRate: number;
}

export interface CurationProposal {
	action: "retire" | "consolidate";
	/** Program names the proposal targets. */
	targets: string[];
	rationale: string;
}

export interface DetectPatternsOptions {
	/** Minimum runs sharing a shape before it is a fabrication candidate. */
	minOccurrences?: number;
}

export interface RepairOptions {
	/** Stumble-rate threshold above which a program is flagged. Default 0.5. */
	stumbleThreshold?: number;
	/** Minimum invocations before a program can be flagged. Default 3. */
	minOccurrences?: number;
}

const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_STUMBLE_THRESHOLD = 0.5;
const DEFAULT_REPAIR_MIN_OCCURRENCES = 3;

/**
 * Normalize cell code to a structural key for grouping. This is a HEURISTIC,
 * NOT semantic equivalence:
 *   - line (`// ...`) and block (`/* ... *\/`) comments are stripped,
 *   - all runs of whitespace collapse to a single space, then trim.
 *
 * Documented limits (over/under-grouping is acceptable and expected):
 *   - UNDER-groups: two cells that differ only in a variable name, literal, or
 *     statement order get different keys — they will NOT be merged even though a
 *     human would call them "the same shape".
 *   - OVER-groups: two genuinely different cells whose token streams coincide
 *     after whitespace collapse get the SAME key (rare, but possible).
 *   - The comment strip is textual, so a `//` or `/*` sequence inside a string
 *     literal is treated as a comment. Cells rarely embed those; the mis-strip
 *     only changes the grouping key, never correctness of anything downstream.
 */
export function normalizeCellCode(code: string): string {
	return code
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Short, stable, name-charset digest of a normalization key. */
function keyDigest(key: string): string {
	let hash = 2166136261;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

/**
 * Find cell code shapes that recur across N+ runs and are NOT already a program
 * invocation. Observations that carry a `program` are excluded — a recurring
 * program call is not a fabrication target (the program already exists). Groups
 * are keyed by normalizeCellCode; a group at or above minOccurrences becomes a
 * candidate carrying its first-seen code, occurrence count, and a proposed name.
 */
export function detectRecurringPatterns(
	observations: CellObservation[],
	opts: DetectPatternsOptions = {},
): FabricationCandidate[] {
	const minOccurrences = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
	const groups = new Map<string, { code: string; count: number }>();

	for (const obs of observations) {
		if (obs.program !== undefined) continue;
		const key = normalizeCellCode(obs.code);
		if (key.length === 0) continue;
		const existing = groups.get(key);
		if (existing) {
			existing.count++;
		} else {
			groups.set(key, { code: obs.code, count: 1 });
		}
	}

	const candidates: FabricationCandidate[] = [];
	for (const [key, group] of groups) {
		if (group.count < minOccurrences) continue;
		candidates.push({
			code: group.code,
			occurrences: group.count,
			proposedName: `fabricated_${keyDigest(key)}`,
		});
	}
	return candidates;
}

/**
 * Turn a fabrication candidate into a valid Program. The body is the recurring
 * code verbatim; params are inferred conservatively as empty (a v1 fabricated
 * program takes no typed args — parameterization is a later refinement). Runs
 * validateProgram and throws if the result is invalid (e.g. the recurring code
 * contained an import/require token).
 *
 * The returned Program is a genome MUTATION PROPOSAL. The caller MUST run it
 * through shouldAcceptMutation (N-run A/B) AND the canary suite before adopting
 * it into the genome — fabrication does NOT bypass the 7B gates.
 *
 * NOTE: the candidate body comes from cell_end `code`, which is redaction-
 * scrubbed for sensitive transcript content. A fabricated body may therefore
 * carry redaction placeholders and be semantically broken; the A/B gate is what
 * keeps such a body from ever being adopted (it shows no significant win).
 */
export function proposeProgramFromCandidate(candidate: FabricationCandidate): Program {
	const program: Program = {
		name: candidate.proposedName,
		description: `Fabricated from a cell pattern recurring across ${candidate.occurrences} runs.`,
		params: [],
		spawns: [],
		version: 1,
		provenance: "fabricated-from-pattern",
		body: candidate.code,
	};
	const result = validateProgram(program);
	if (!result.ok) {
		throw new Error(`cannot fabricate program '${candidate.proposedName}': ${result.reason}`);
	}
	return program;
}

/**
 * Flag programs whose invocations stumble at a high rate for repair/retirement.
 * Only observations that carry a `program` count; a program is flagged when it
 * has at least minOccurrences invocations AND its stumble rate is at or above
 * stumbleThreshold. Healthy programs (low stumble rate) and rarely-seen ones are
 * left alone.
 */
export function detectRepairCandidates(
	observations: CellObservation[],
	opts: RepairOptions = {},
): RepairCandidate[] {
	const stumbleThreshold = opts.stumbleThreshold ?? DEFAULT_STUMBLE_THRESHOLD;
	const minOccurrences = opts.minOccurrences ?? DEFAULT_REPAIR_MIN_OCCURRENCES;

	const byProgram = new Map<string, { version: number; total: number; stumbles: number }>();
	for (const obs of observations) {
		if (obs.program === undefined) continue;
		const stats = byProgram.get(obs.program.name) ?? {
			version: obs.program.version,
			total: 0,
			stumbles: 0,
		};
		stats.version = obs.program.version;
		stats.total++;
		if (obs.stumbled) stats.stumbles++;
		byProgram.set(obs.program.name, stats);
	}

	const candidates: RepairCandidate[] = [];
	for (const [name, stats] of byProgram) {
		if (stats.total < minOccurrences) continue;
		const stumbleRate = stats.stumbles / stats.total;
		if (stumbleRate < stumbleThreshold) continue;
		candidates.push({
			programName: name,
			version: stats.version,
			occurrences: stats.total,
			stumbleRate,
		});
	}
	return candidates;
}

/**
 * Curator pass over the program library (library rot). Proposes:
 *   - RETIREMENT of programs never invoked over the observation window (zero
 *     occurrences), and
 *   - CONSOLIDATION of near-duplicate programs — those whose bodies share a
 *     normalization key (see normalizeCellCode's documented limits).
 *
 * A healthy program (invoked at least once, unique body) is left alone. Each
 * proposal is a genome MUTATION and is gated exactly like any other mutation
 * (N-run A/B + canary suite); the curator NEVER deletes or merges unilaterally.
 *
 * TODO(agents/memories): the same rot analysis generalizes to agents and
 * memories, but there is no clean library-view API over those here yet. When a
 * genome-view exposes agents/memories with usage counts, extend curation to
 * cover them; for now it is scoped to programs.
 */
export function curatePrograms(
	programs: Program[],
	observations: CellObservation[],
): CurationProposal[] {
	const invoked = new Set<string>();
	for (const obs of observations) {
		if (obs.program !== undefined) invoked.add(obs.program.name);
	}

	const proposals: CurationProposal[] = [];

	for (const program of programs) {
		if (!invoked.has(program.name)) {
			proposals.push({
				action: "retire",
				targets: [program.name],
				rationale: `Program '${program.name}' was never invoked over the observation window.`,
			});
		}
	}

	const byBody = new Map<string, string[]>();
	for (const program of programs) {
		const key = normalizeCellCode(program.body);
		const names = byBody.get(key) ?? [];
		names.push(program.name);
		byBody.set(key, names);
	}
	for (const names of byBody.values()) {
		if (names.length < 2) continue;
		proposals.push({
			action: "consolidate",
			targets: names,
			rationale: `Programs ${names.map((n) => `'${n}'`).join(", ")} share a normalized body (near-duplicates).`,
		});
	}

	return proposals;
}
