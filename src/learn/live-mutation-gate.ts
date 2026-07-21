/**
 * The production `MutationGate`: snapshot-isolate, mutate the copy, measure.
 *
 * This is the caller that makes the chokepoint's contract REAL: the candidate
 * arm/canary harness genuinely reflect the proposed mutation. `evaluate()`
 * takes TWO fresh eval snapshots of the live genome, applies the mutation to
 * the CANDIDATE copy only (via the same genome operations the live adoption
 * path uses), runs the frozen two-gate decision (`evaluateMutationForAdoption`)
 * over the two arms, and cleans everything up. The LIVE genome is only ever
 * READ (copied by `createEvalSnapshot`) — a rejected mutation is refused before
 * the live genome is ever written.
 *
 * The executor/harness builders are INJECTED so this module stays host-free:
 * production supplies `LiveTaskExecutor` + `createLiveCanaryHarness` (composed
 * host-side, see session-controller.ts); offline tests supply deterministic
 * builders that inspect the snapshot they were handed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome } from "../genome/genome.ts";
import type { Canary, CanaryHarness } from "./canary-suite.ts";
import type { EvalTask, GenomeSnapshot, TaskExecutor } from "./eval-harness.ts";
import { createEvalSnapshot } from "./eval-harness.ts";
import type { LearnMutation, MutationGate, MutationGateDecision } from "./learn-process.ts";
import { applyMutationToGenome, mutationIntent } from "./learn-process.ts";
import type { CompareOptions } from "./multi-run-ab.ts";
import { evaluateMutationForAdoption } from "./mutation-gate.ts";

/** The host-composed builders the gate needs (host-only pieces stay injected). */
export interface SnapshotMutationGateBuilders {
	/** Build the executor that runs eval tasks against the given snapshot. */
	buildExecutor: (snapshotPath: string, workDir: string) => TaskExecutor;
	/** Build the canary harness bound to the given snapshot + work dir. */
	buildCanaryHarness: (
		executor: TaskExecutor,
		snapshot: GenomeSnapshot,
		workDir: string,
	) => CanaryHarness;
}

export interface SnapshotMutationGateOptions extends SnapshotMutationGateBuilders {
	/** The live genome directory. Only ever READ (snapshot-copied), never written. */
	liveGenomePath: string;
	/**
	 * The root/ overlay dir the live genome was constructed with. Root-defined
	 * agents live ONLY here (overlay, not the genome's agents/ dir), so the
	 * candidate genome must see it or an update_agent on a built-in agent throws
	 * 'not found' instead of being evaluated. Read-only, like the live genome.
	 */
	rootDir?: string;
	/** The pinned eval task set both arms run. */
	tasks: EvalTask[];
	/** The hidden canary set (kernel-resident; never surfaced to a model). */
	canaries: Canary[];
	/** Runs per task per arm. N ≥ the A/B minRuns (default 5). */
	runs: number;
	/** Forwarded to compareArms (alpha, minRuns, …). */
	compare?: CompareOptions;
}

interface ArmResources {
	snapshot: GenomeSnapshot;
	workDir: string;
}

async function createArmResources(liveGenomePath: string, label: string): Promise<ArmResources> {
	const snapshot = await createEvalSnapshot(liveGenomePath, label);
	if (snapshot.genomePath === liveGenomePath) {
		await snapshot.cleanup();
		throw new Error("snapshot mutation gate: eval snapshot must not alias the live genome");
	}
	const workDir = await mkdtemp(join(tmpdir(), `sprout-gate-${label}-`));
	return { snapshot, workDir };
}

async function releaseArmResources(arm: ArmResources | undefined): Promise<void> {
	if (!arm) return;
	await arm.snapshot.cleanup();
	await rm(arm.workDir, { recursive: true, force: true });
}

/**
 * Create the production `MutationGate` over the live genome. Each `evaluate()`
 * is fully isolated and self-cleaning; the live genome is never written.
 */
export function createSnapshotMutationGate(opts: SnapshotMutationGateOptions): MutationGate {
	return {
		async evaluate(mutation: LearnMutation): Promise<MutationGateDecision> {
			let baseline: ArmResources | undefined;
			let candidate: ArmResources | undefined;
			try {
				baseline = await createArmResources(opts.liveGenomePath, "baseline");
				candidate = await createArmResources(opts.liveGenomePath, "candidate");

				// Apply the proposed mutation to the CANDIDATE SNAPSHOT ONLY, via the
				// same genome operations the live adoption path uses. The baseline
				// copy and the live genome stay untouched.
				const candidateGenome = new Genome(candidate.snapshot.genomePath, opts.rootDir);
				await candidateGenome.loadFromDisk();
				await applyMutationToGenome(candidateGenome, mutation);

				const candidateExecutor = opts.buildExecutor(
					candidate.snapshot.genomePath,
					candidate.workDir,
				);
				const baselineExecutor = opts.buildExecutor(baseline.snapshot.genomePath, baseline.workDir);

				const result = await evaluateMutationForAdoption({
					candidateArm: {
						tasks: opts.tasks,
						executor: candidateExecutor,
						snapshot: candidate.snapshot,
						workDir: candidate.workDir,
					},
					baselineArm: {
						tasks: opts.tasks,
						executor: baselineExecutor,
						snapshot: baseline.snapshot,
						workDir: baseline.workDir,
					},
					canaries: opts.canaries,
					candidateCanaryHarness: opts.buildCanaryHarness(
						candidateExecutor,
						candidate.snapshot,
						candidate.workDir,
					),
					baselineCanaryHarness: opts.buildCanaryHarness(
						baselineExecutor,
						baseline.snapshot,
						baseline.workDir,
					),
					runs: opts.runs,
					compare: opts.compare,
					intent: mutationIntent(mutation),
				});

				return { adopt: result.adopt, reason: result.reason };
			} finally {
				await releaseArmResources(candidate);
				await releaseArmResources(baseline);
			}
		},
	};
}
