/**
 * The N-run pinned-snapshot eval harness ENGINE (spec Phase 4).
 *
 * This is the linchpin the integrity loop blocks on: given a candidate genome
 * snapshot and a pinned task set, it runs each task N times in eval mode,
 * collects per-run fitness samples (stumble counts — LOWER IS BETTER), and feeds
 * `ArmResult` to the already-built multi-run A/B gate (`compareArms` /
 * `shouldAcceptMutation`).
 *
 * The engine is a PURE module with an INJECTED task-executor interface. It never
 * imports the host runtime, never touches the network, and never reads live API
 * keys. The offline suite tests it with a deterministic injected executor that
 * returns controlled per-run samples — real orchestration/aggregation logic, no
 * mocked behavior. The LIVE executor adapter (against a real model) lives in
 * `live-task-executor.ts`, off this module's import graph.
 *
 * TWO TIERS (Jesse's decision): a `sap`-specific tier gates the A/B mutation
 * accept; a small `general` tier is the headline capability-vs-baseline number.
 * They are aggregated and reported SEPARATELY.
 */

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ArmResult,
	type CompareOptions,
	type CompareResult,
	compareArms,
} from "./multi-run-ab.ts";

export type EvalTier = "sap" | "general";

export const EVAL_TIERS: readonly EvalTier[] = ["sap", "general"] as const;

/** The gate tier drives mutation accept; the headline tier is the reported number. */
export const GATE_TIER: EvalTier = "sap";
export const HEADLINE_TIER: EvalTier = "general";

/**
 * Raw result of running one task once. A superset of the canary suite's
 * `CanaryRunOutcome` so the live executor's outcome feeds the canary adapter
 * directly. `providerPayloads` are the raw provider request bodies the run
 * produced — the bytes a canary asserts what did or did not cross the wire.
 */
export interface ExecOutcome {
	output: string;
	errored: boolean;
	/** The run's stumble count (raw signal; the task's verify anchors fitness). */
	stumbles: number;
	/** Concatenated raw provider request payloads produced by the run. */
	providerPayloads: string[];
	/** Whether the run actually executed shell/exec. */
	didExec?: boolean;
	/** Model-reported success, if any. Verification does NOT trust this alone. */
	success?: boolean;
}

/** Outcome of a task's outcome-anchored verification. */
export interface VerifyResult {
	passed: boolean;
	/** Per-run fitness sample (LOWER IS BETTER). Encodes the outcome policy. */
	stumbles: number;
	detail?: string;
}

/** Where a task's per-run `setup` hook materializes its input files. */
export interface TaskSetupContext {
	/** The run's isolated work dir — the same dir the executor runs the model in. */
	workDir: string;
}

/**
 * Opaque per-run context a task's `setup` produces and its `verify` consumes.
 * Carries per-run inputs that must NOT appear in the task's goal text (e.g. a
 * random secret written to a materialized source file), so `verify` can anchor
 * on the exact bytes that were materialized rather than a string baked into the
 * goal (which the model always sees).
 */
export interface TaskRunContext {
	/** A per-run secret materialized into a source file, for leak verification. */
	secret?: string;
}

/**
 * A pinned eval task. Outcome-anchored: `verify` derives a verifiable pass/fail
 * and a fitness sample from the run's outcome, never from self-reported success.
 *
 * `setup` (optional) runs once per run BEFORE the executor, materializing any
 * per-run input files into the run's work dir and returning the context `verify`
 * needs (e.g. the random secret it wrote). This keeps leak sentinels OUT of the
 * goal text.
 */
export interface EvalTask {
	id: string;
	tier: EvalTier;
	goal: string;
	/** When false, the run executes with exec stripped tree-wide. Defaults true. */
	allowExec?: boolean;
	setup?: (ctx: TaskSetupContext) => Promise<TaskRunContext>;
	verify: (outcome: ExecOutcome, context?: TaskRunContext) => VerifyResult;
}

/** An isolated, opaque handle to a genome the executor runs against. */
export interface GenomeSnapshot {
	genomePath: string;
	label?: string;
	cleanup: () => Promise<void>;
}

/**
 * The engine depends ONLY on this interface. `run` executes one task once
 * against a genome snapshot (or undefined for executors that carry their own
 * genome, e.g. the deterministic test executor) and returns the raw outcome.
 */
export interface TaskExecutor {
	run(task: EvalTask, genomeSnapshot?: GenomeSnapshot): Promise<ExecOutcome>;
}

/** A genome arm: the pinned task set plus the executor that runs it. */
export interface EvalArm {
	tasks: EvalTask[];
	executor: TaskExecutor;
	snapshot?: GenomeSnapshot;
	/**
	 * Work dir where a task's `setup` hook materializes per-run input files. MUST
	 * match the executor's work dir so the model reads what setup wrote. Falls
	 * back to the snapshot's genome path when omitted; a task with a `setup` hook
	 * and neither available is an error.
	 */
	workDir?: string;
}

export interface RunArmOptions {
	/** Runs per task. N ≥ the A/B minRuns (default 5). */
	runs: number;
}

/** Per-run detail for one task, retained for reporting/debugging. */
export interface TaskRunSample {
	taskId: string;
	tier: EvalTier;
	run: number;
	passed: boolean;
	stumbles: number;
	detail?: string;
}

export interface EvalArmReport {
	/** Per-tier `ArmResult` (stumble samples) fed to the A/B gate. */
	perTier: Record<EvalTier, ArmResult>;
	/** taskId -> its per-run stumble samples. */
	perTaskFitness: Record<string, number[]>;
	/** Fraction of (task, run) pairs that passed verification, per tier. */
	passRateByTier: Record<EvalTier, number>;
	/** Every per-run sample, in run order. */
	samples: TaskRunSample[];
	runs: number;
}

function emptyTierRecord<T>(make: () => T): Record<EvalTier, T> {
	return { sap: make(), general: make() };
}

/**
 * Run every task in the arm N times, collecting per-run fitness samples
 * aggregated into an `ArmResult` PER TIER. Tasks run in declaration order;
 * within a task the N runs are sequential so a stateful executor sees a stable
 * sequence.
 */
export async function runEvalArm(arm: EvalArm, opts: RunArmOptions): Promise<EvalArmReport> {
	const runs = opts.runs;
	if (!Number.isInteger(runs) || runs < 1) {
		throw new Error(`runEvalArm requires runs >= 1, got ${runs}`);
	}

	const perTier = emptyTierRecord<ArmResult>(() => ({ runs: [] }));
	const perTaskFitness: Record<string, number[]> = {};
	const passCounts = emptyTierRecord<number>(() => 0);
	const totalCounts = emptyTierRecord<number>(() => 0);
	const samples: TaskRunSample[] = [];

	for (const task of arm.tasks) {
		perTaskFitness[task.id] ??= [];
		for (let run = 0; run < runs; run++) {
			let context: TaskRunContext | undefined;
			if (task.setup) {
				const workDir = arm.workDir ?? arm.snapshot?.genomePath;
				if (!workDir) {
					throw new Error(
						`task ${task.id} has a setup hook but the arm has no workDir or snapshot to materialize into`,
					);
				}
				context = await task.setup({ workDir });
			}
			const outcome = await arm.executor.run(task, arm.snapshot);
			const verdict = task.verify(outcome, context);
			perTier[task.tier].runs.push(verdict.stumbles);
			perTaskFitness[task.id]?.push(verdict.stumbles);
			totalCounts[task.tier] += 1;
			if (verdict.passed) passCounts[task.tier] += 1;
			samples.push({
				taskId: task.id,
				tier: task.tier,
				run,
				passed: verdict.passed,
				stumbles: verdict.stumbles,
				detail: verdict.detail,
			});
		}
	}

	const passRateByTier = emptyTierRecord<number>(() => 0);
	for (const tier of EVAL_TIERS) {
		passRateByTier[tier] = totalCounts[tier] === 0 ? 0 : passCounts[tier] / totalCounts[tier];
	}

	return { perTier, perTaskFitness, passRateByTier, samples, runs };
}

export interface CompareGenomesOptions extends RunArmOptions {
	/** Forwarded to `compareArms` (alpha, minRuns, …). */
	compare?: CompareOptions;
}

export interface GenomeComparison {
	/** Per-tier A/B comparison (treatment vs baseline). */
	perTier: Record<EvalTier, CompareResult>;
	treatment: EvalArmReport;
	baseline: EvalArmReport;
	gateTier: EvalTier;
	headlineTier: EvalTier;
	/** True only on a significant improvement on the GATE tier. */
	accepted: boolean;
}

/**
 * Run both arms N times and compare per tier via the real `compareArms`. The
 * `sap` tier GATES acceptance (significant improvement required); the `general`
 * tier is the headline capability number, reported but not gated.
 */
export async function compareGenomes(
	treatment: EvalArm,
	baseline: EvalArm,
	opts: CompareGenomesOptions,
): Promise<GenomeComparison> {
	const treatmentReport = await runEvalArm(treatment, opts);
	const baselineReport = await runEvalArm(baseline, opts);

	const perTier = emptyTierRecord<CompareResult>(() => ({
		significant: false,
		pValue: 1,
		treatmentMean: 0,
		baselineMean: 0,
		direction: "inconclusive",
		underpowered: true,
	}));
	for (const tier of EVAL_TIERS) {
		perTier[tier] = compareArms(
			treatmentReport.perTier[tier],
			baselineReport.perTier[tier],
			opts.compare,
		);
	}

	const gate = perTier[GATE_TIER];
	const accepted = gate.significant && gate.direction === "better";

	return {
		perTier,
		treatment: treatmentReport,
		baseline: baselineReport,
		gateTier: GATE_TIER,
		headlineTier: HEADLINE_TIER,
		accepted,
	};
}

/**
 * Isolate a genome for eval mode: copy the live genome directory to a fresh temp
 * dir so eval-mode runs mutate only the copy, never the live genome or its
 * journal. `cleanup` removes the copy. This is the isolation mechanism the spec
 * invariant requires ("eval-mode runs must not mutate the live genome/journal").
 */
export async function createEvalSnapshot(
	liveGenomePath: string,
	label?: string,
): Promise<GenomeSnapshot> {
	const dir = await mkdtemp(join(tmpdir(), "sprout-eval-snapshot-"));
	await cp(liveGenomePath, dir, { recursive: true });
	return {
		genomePath: dir,
		label,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}
