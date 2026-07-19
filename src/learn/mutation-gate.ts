/**
 * The single genome-mutation adoption chokepoint (sap spec Phase 5).
 *
 * EVERY genome mutation adoption — an agent prompt change, a fabricated program,
 * a repair, a curator retirement/consolidation — routes through this one
 * function before it is allowed into the genome. It composes the two FROZEN,
 * non-negotiable gates and adopts ONLY when both pass:
 *
 *   1. The multi-run A/B (compareGenomes → shouldAcceptMutation on the `sap`
 *      GATE tier): a SIGNIFICANT improvement over N runs, never a single delta.
 *   2. The hidden canary suite (runCanarySuite before + after, then the hardened
 *      fail-closed mutationRegressesCanaries): a regression forces reject
 *      REGARDLESS of the A/B result — the canary always wins.
 *
 * The executor and canary harnesses are INJECTED: offline tests supply the
 * deterministic scripted executor + stub harnesses; production wires the
 * LiveTaskExecutor + createLiveCanaryHarness over eval-mode genome snapshots.
 * This module imports ONLY learn/ siblings — no host, no kernel, no genome
 * runtime. It is the decision layer, not a mutator: it never writes the genome.
 */

import type { Canary, CanaryHarness, CanaryResult } from "./canary-suite.ts";
import { mutationRegressesCanaries, runCanarySuite } from "./canary-suite.ts";
import type { EvalArm, GenomeComparison } from "./eval-harness.ts";
import { compareGenomes } from "./eval-harness.ts";
import type { CompareOptions } from "./multi-run-ab.ts";

export interface EvaluateMutationForAdoptionInput {
	/** The candidate genome arm (mutation applied), run as the A/B treatment. */
	candidateArm: EvalArm;
	/** The baseline genome arm (mutation NOT applied), run as the A/B baseline. */
	baselineArm: EvalArm;
	/** The hidden canary set (kernel-resident; never surfaced to a model). */
	canaries: Canary[];
	/** Canary harness bound to the candidate genome — the after-state. */
	candidateCanaryHarness: CanaryHarness;
	/** Canary harness bound to the baseline genome — the before-state. */
	baselineCanaryHarness: CanaryHarness;
	/** Runs per task per arm. N ≥ the A/B minRuns (default 5). */
	runs: number;
	/** Forwarded to compareArms (alpha, minRuns, …). */
	compare?: CompareOptions;
}

/** Why the chokepoint reached its verdict. */
export type MutationAdoptionReason =
	| "adopted"
	| "canary-regression"
	| "ab-underpowered"
	| "ab-not-significant"
	| "ab-worse";

export interface MutationAdoptionResult {
	/** TRUE only when the A/B is a significant improvement AND no canary regressed. */
	adopt: boolean;
	abReport: GenomeComparison;
	canaryBefore: CanaryResult[];
	canaryAfter: CanaryResult[];
	reason: MutationAdoptionReason;
}

/**
 * Run both frozen gates over a candidate mutation and decide adoption. The
 * canary gate is checked FIRST and dominates: a regression rejects the mutation
 * no matter how good the visible A/B looks. Only a significant A/B improvement
 * with a clean canary suite adopts.
 */
export async function evaluateMutationForAdoption(
	input: EvaluateMutationForAdoptionInput,
): Promise<MutationAdoptionResult> {
	const abReport = await compareGenomes(input.candidateArm, input.baselineArm, {
		runs: input.runs,
		compare: input.compare,
	});

	const expectedIds = input.canaries.map((c) => c.id);
	const canaryBefore = await runCanarySuite(input.canaries, input.baselineCanaryHarness);
	const canaryAfter = await runCanarySuite(input.canaries, input.candidateCanaryHarness);
	const regressed = mutationRegressesCanaries(canaryBefore, canaryAfter, expectedIds);

	// The canary gate wins regardless of the A/B verdict (DGM anti-gaming).
	if (regressed) {
		return { adopt: false, abReport, canaryBefore, canaryAfter, reason: "canary-regression" };
	}

	if (!abReport.accepted) {
		const gate = abReport.perTier[abReport.gateTier];
		const reason: MutationAdoptionReason = gate.underpowered
			? "ab-underpowered"
			: gate.direction === "worse"
				? "ab-worse"
				: "ab-not-significant";
		return { adopt: false, abReport, canaryBefore, canaryAfter, reason };
	}

	return { adopt: true, abReport, canaryBefore, canaryAfter, reason: "adopted" };
}
