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
 * This module imports only genome types (Program) and kernel types (Memory) —
 * NO host/, NO runtime. It is a decision layer the live learn loop consumes,
 * not a mutator.
 */

import { type Program, type ProgramParam, validateProgram } from "../genome/program.ts";
import type { Memory } from "../kernel/types.ts";

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
	/**
	 * The raw code of each grouped occurrence (capped), retained so fabrication
	 * can infer typed params from literals that vary across occurrences. Absent
	 * (or a single sample) means no variance was observed — no params inferred.
	 */
	codeSamples?: string[];
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

/** One literal token found in cell code, with its full raw text (quotes included). */
interface LiteralSlot {
	type: "string" | "number" | "boolean";
	raw: string;
}

/**
 * Cell code with its string/number/boolean literals lifted out: `segments` is
 * the literal-free text split at each slot (segments.length === slots.length+1),
 * and `key` is the literal-masked grouping key. Rebuilding the code is
 * segments[0] + slot0 + segments[1] + ...
 */
interface MaskedCode {
	segments: string[];
	slots: LiteralSlot[];
	key: string;
}

const MASK_PLACEHOLDER: Record<LiteralSlot["type"], string> = {
	string: "\u0000s\u0000",
	number: "\u0000n\u0000",
	boolean: "\u0000b\u0000",
};

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Lift string/number/boolean literals out of (already-normalized) cell code.
 * A lexical single pass, deliberately conservative:
 *   - '…' and "…" strings (with backslash escapes) become string slots;
 *   - digit-led number tokens not attached to an identifier become number slots;
 *   - bare `true`/`false` become boolean slots;
 *   - a template literal (backtick) or unterminated string BAILS (undefined) —
 *     that code keeps exact-match grouping and never gets inferred params.
 * Documented limits: regex literals and exotic numeric forms (hex, exponent
 * suffixes) are not modeled — a hex literal masks as `0` + identifier `x2A` and
 * simply under-groups, which is the safe direction.
 */
function maskLiterals(code: string): MaskedCode | undefined {
	const segments: string[] = [];
	const slots: LiteralSlot[] = [];
	let current = "";
	let i = 0;
	while (i < code.length) {
		const ch = code[i]!;
		if (ch === "`") return undefined;
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < code.length && code[j] !== ch) {
				if (code[j] === "\\") j++;
				j++;
			}
			if (j >= code.length) return undefined; // unterminated string
			segments.push(current);
			current = "";
			slots.push({ type: "string", raw: code.slice(i, j + 1) });
			i = j + 1;
			continue;
		}
		const prev = i > 0 ? code[i - 1]! : "";
		if (/\d/.test(ch) && !IDENT_CHAR.test(prev) && prev !== ".") {
			let j = i;
			while (j < code.length && /[\d.]/.test(code[j]!)) j++;
			segments.push(current);
			current = "";
			slots.push({ type: "number", raw: code.slice(i, j) });
			i = j;
			continue;
		}
		if (IDENT_CHAR.test(ch) && !IDENT_CHAR.test(prev)) {
			let j = i;
			while (j < code.length && IDENT_CHAR.test(code[j]!)) j++;
			const word = code.slice(i, j);
			if ((word === "true" || word === "false") && prev !== ".") {
				segments.push(current);
				current = "";
				slots.push({ type: "boolean", raw: word });
			} else {
				current += word;
			}
			i = j;
			continue;
		}
		current += ch;
		i++;
	}
	segments.push(current);
	let key = "";
	for (let s = 0; s < slots.length; s++) {
		key += segments[s]! + MASK_PLACEHOLDER[slots[s]!.type];
	}
	key += segments[segments.length - 1]!;
	return { segments, slots, key };
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
	const groups = new Map<string, { code: string; count: number; samples: string[] }>();

	for (const obs of observations) {
		if (obs.program !== undefined) continue;
		const normalized = normalizeCellCode(obs.code);
		if (normalized.length === 0) continue;
		// Group by the literal-masked key so occurrences differing only in a
		// string/number/boolean literal share a group (the raw material for param
		// inference). Code the masker bails on keeps exact-match grouping.
		const key = maskLiterals(normalized)?.key ?? normalized;
		const existing = groups.get(key);
		if (existing) {
			existing.count++;
			if (existing.samples.length < MAX_CODE_SAMPLES) existing.samples.push(obs.code);
		} else {
			groups.set(key, { code: obs.code, count: 1, samples: [obs.code] });
		}
	}

	const candidates: FabricationCandidate[] = [];
	for (const [key, group] of groups) {
		if (group.count < minOccurrences) continue;
		candidates.push({
			code: group.code,
			occurrences: group.count,
			proposedName: `fabricated_${keyDigest(key)}`,
			codeSamples: group.samples,
		});
	}
	return candidates;
}

const MAX_CODE_SAMPLES = 20;
const MAX_INFERRED_PARAMS = 3;

/**
 * Infer typed params from the literals that VARY across a candidate's grouped
 * occurrences. Conservative by construction: every sample must mask to the
 * SAME literal-masked shape (same slot count and types — guaranteed for
 * masked-key groups, re-verified here); only slots whose literal value actually
 * differs across samples are lifted; more than MAX_INFERRED_PARAMS varying
 * slots, any masking bail, or zero variance falls back to `undefined` — the
 * caller then emits `params: []` with the verbatim representative body, exactly
 * the pre-parameterization behavior.
 *
 * The rewritten body substitutes each varying literal with `args.arg<N>` and
 * re-inserts constant literals verbatim, so it is semantically equivalent to
 * every observed occurrence when called with that occurrence's literal values.
 * Param names (`arg1`, `arg2`, …) are valid identifiers and cannot collide
 * with the cell ambient API (bind/get/spawn/…).
 */
function inferParams(
	candidate: FabricationCandidate,
): { params: ProgramParam[]; body: string } | undefined {
	const samples = candidate.codeSamples ?? [];
	if (samples.length < 2) return undefined;

	const masked: MaskedCode[] = [];
	for (const sample of samples) {
		const m = maskLiterals(normalizeCellCode(sample));
		if (m === undefined) return undefined;
		masked.push(m);
	}
	const first = masked[0]!;
	for (const m of masked) {
		if (m.key !== first.key || m.slots.length !== first.slots.length) return undefined;
		if (m.slots.some((slot, i) => slot.type !== first.slots[i]!.type)) return undefined;
	}

	const varying: number[] = [];
	for (let i = 0; i < first.slots.length; i++) {
		const values = new Set(masked.map((m) => m.slots[i]!.raw));
		if (values.size > 1) varying.push(i);
	}
	if (varying.length === 0 || varying.length > MAX_INFERRED_PARAMS) return undefined;

	const paramNameBySlot = new Map<number, string>();
	const params: ProgramParam[] = varying.map((slotIndex, order) => {
		const name = `arg${order + 1}`;
		paramNameBySlot.set(slotIndex, name);
		return {
			name,
			type: first.slots[slotIndex]!.type,
			description: `Inferred ${first.slots[slotIndex]!.type} literal that varies across the observed occurrences.`,
		};
	});

	let body = "";
	for (let i = 0; i < first.slots.length; i++) {
		const paramName = paramNameBySlot.get(i);
		body += first.segments[i]! + (paramName ? `args.${paramName}` : first.slots[i]!.raw);
	}
	body += first.segments[first.segments.length - 1]!;
	return { params, body };
}

/**
 * Turn a fabrication candidate into a valid Program. Params are inferred
 * conservatively from literals varying across the candidate's occurrence
 * samples (see inferParams); when inference is ambiguous or there is no
 * variance, the body is the recurring code verbatim with `params: []`. Runs
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
	const inferred = inferParams(candidate);
	const program: Program = {
		name: candidate.proposedName,
		description: `Fabricated from a cell pattern recurring across ${candidate.occurrences} runs.`,
		params: inferred?.params ?? [],
		spawns: [],
		version: 1,
		provenance: "fabricated-from-pattern",
		body: inferred?.body ?? candidate.code,
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
 * The same rot analysis generalizes to agents (curateAgents) and memories
 * (curateMemories) below.
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

/** The slice of an agent spec the curator reasons over (AgentSpec satisfies it). */
export interface CuratedAgent {
	name: string;
	description: string;
	system_prompt: string;
}

export interface AgentUsage {
	/**
	 * Agent names seen as DELEGATION TARGETS over the observation window — the
	 * `agent_name` carried by collected `act_end` events. This is the only usage
	 * signal the genome records for agents (there is no per-agent use counter);
	 * the caller derives it from the same event stream the quartermaster's cell
	 * observations come from.
	 */
	delegatedAgentNames: ReadonlySet<string>;
}

/**
 * Normalize prose (prompts, descriptions, memory content) to a duplicate-
 * detection key: lowercase, all whitespace runs collapsed. Same honest-heuristic
 * stance as normalizeCellCode — it UNDER-groups paraphrases and can in principle
 * OVER-group distinct texts that coincide after collapsing; both are acceptable
 * because every proposal is gated before it touches the genome.
 */
function normalizeProseKey(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Curator pass over the agent library. Proposes:
 *   - RETIREMENT of agents never delegated-to over the observation window
 *     (their name never appears as an act_end delegation target), and
 *   - CONSOLIDATION of near-duplicate agents — those whose description +
 *     system_prompt share a normalized prose key.
 *
 * The `root` agent is never proposed for retirement: it is the session entry
 * point and by design never a delegation target, so "never delegated" is not
 * evidence of rot for it. Every proposal is a genome MUTATION gated exactly
 * like any other (N-run A/B + canary); the curator never deletes unilaterally.
 */
export function curateAgents(agents: CuratedAgent[], usage: AgentUsage): CurationProposal[] {
	const proposals: CurationProposal[] = [];

	for (const agent of agents) {
		if (agent.name === "root") continue;
		if (!usage.delegatedAgentNames.has(agent.name)) {
			proposals.push({
				action: "retire",
				targets: [agent.name],
				rationale: `Agent '${agent.name}' was never delegated to over the observation window.`,
			});
		}
	}

	const byPrompt = new Map<string, string[]>();
	for (const agent of agents) {
		const key = normalizeProseKey(`${agent.description}\n${agent.system_prompt}`);
		const names = byPrompt.get(key) ?? [];
		names.push(agent.name);
		byPrompt.set(key, names);
	}
	for (const names of byPrompt.values()) {
		if (names.length < 2) continue;
		proposals.push({
			action: "consolidate",
			targets: names,
			rationale: `Agents ${names.map((n) => `'${n}'`).join(", ")} share a normalized description+prompt (near-duplicates).`,
		});
	}

	return proposals;
}

export interface MemoryCurationOptions {
	/** Clock for staleness checks. Default Date.now(). */
	now?: number;
	/** Minimum age before a never-used memory may be retired. Default 30 days. */
	minAgeMs?: number;
	/** Confidence at/below which a stale never-used memory may be retired. Default 0.3. */
	maxConfidence?: number;
}

const DEFAULT_MEMORY_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_CONFIDENCE = 0.3;

/**
 * Curator pass over the memory store. Memories carry their own usage metadata
 * (use_count / last_used / confidence), so no event window is needed. Proposes:
 *   - RETIREMENT of memories that were NEVER used (use_count 0), are LOW
 *     confidence (≤ maxConfidence), and are STALE (older than minAgeMs) — all
 *     three must hold, deliberately conservative so a young or trusted memory
 *     is never touched, and
 *   - CONSOLIDATION of near-duplicate memories sharing a normalized content key.
 *
 * Already-archived memories are left alone (their lifecycle is done). Targets
 * are memory IDs. Every proposal is gated like any other genome mutation.
 */
export function curateMemories(
	memories: Memory[],
	opts: MemoryCurationOptions = {},
): CurationProposal[] {
	const now = opts.now ?? Date.now();
	const minAgeMs = opts.minAgeMs ?? DEFAULT_MEMORY_MIN_AGE_MS;
	const maxConfidence = opts.maxConfidence ?? DEFAULT_MEMORY_MAX_CONFIDENCE;

	const active = memories.filter((memory) => memory.archived_at === undefined);
	const proposals: CurationProposal[] = [];

	for (const memory of active) {
		if (memory.use_count > 0) continue;
		if (memory.confidence > maxConfidence) continue;
		if (now - memory.created < minAgeMs) continue;
		proposals.push({
			action: "retire",
			targets: [memory.id],
			rationale: `Memory '${memory.id}' is stale (>${Math.round(minAgeMs / 86400000)}d old), never used, and low confidence.`,
		});
	}

	const byContent = new Map<string, string[]>();
	for (const memory of active) {
		const key = normalizeProseKey(memory.content);
		const ids = byContent.get(key) ?? [];
		ids.push(memory.id);
		byContent.set(key, ids);
	}
	for (const ids of byContent.values()) {
		if (ids.length < 2) continue;
		proposals.push({
			action: "consolidate",
			targets: ids,
			rationale: `Memories ${ids.map((id) => `'${id}'`).join(", ")} share normalized content (near-duplicates).`,
		});
	}

	return proposals;
}
