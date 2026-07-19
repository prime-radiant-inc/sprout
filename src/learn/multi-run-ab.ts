/**
 * Multi-run A/B with significance (sap spec §10, non-negotiable).
 *
 * Single-run stumble rate is noise: an RLM-class agent scores identical inputs
 * anywhere from 0/6 to 6/6, so one before/after delta cannot tell a real genome
 * improvement from variance. A fitness comparison therefore runs each arm N
 * times and gates acceptance on a SIGNIFICANT difference, never a single delta.
 *
 * Convention: samples are stumble rates (or stumble counts) — LOWER IS BETTER.
 * "better" means the treatment's mean is significantly below the baseline's.
 *
 * The significance test is a two-sample permutation (randomization) test on the
 * difference of means. It was chosen over a t-test because stumble counts are
 * small-N, discrete, and non-normal — the permutation test makes no normality
 * assumption, is exact when the arms are small (all label reassignments are
 * enumerated), and is honest for the tiny samples this gate sees. For larger
 * arms it falls back to a fixed-seed Monte-Carlo approximation so results stay
 * deterministic and reproducible.
 */

export interface ArmResult {
	/** Per-run fitness samples for the arm (stumble rate/count — lower better). */
	runs: number[];
}

export interface CompareOptions {
	/** Significance threshold. Default 0.05. */
	alpha?: number;
	/** Minimum runs required in EACH arm before a decision is allowed. Default 5. */
	minRuns?: number;
	/** Cap on exact enumeration; above it, Monte-Carlo sampling is used. */
	maxExactPermutations?: number;
	/** Monte-Carlo sample count when enumeration is skipped. */
	monteCarloSamples?: number;
}

export type ArmDirection = "better" | "worse" | "inconclusive";

export interface CompareResult {
	significant: boolean;
	pValue: number;
	treatmentMean: number;
	baselineMean: number;
	direction: ArmDirection;
	/** True when either arm had fewer than minRuns samples. */
	underpowered: boolean;
}

const DEFAULT_ALPHA = 0.05;
const DEFAULT_MIN_RUNS = 5;
const DEFAULT_MAX_EXACT = 200_000;
const DEFAULT_MONTE_CARLO = 20_000;

function mean(xs: number[]): number {
	if (xs.length === 0) return 0;
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Deterministic PRNG (mulberry32) so Monte-Carlo p-values are reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Number of ways to choose k from n. */
function choose(n: number, k: number): number {
	if (k < 0 || k > n) return 0;
	let result = 1;
	const kk = Math.min(k, n - k);
	for (let i = 0; i < kk; i++) {
		result = (result * (n - i)) / (i + 1);
	}
	return Math.round(result);
}

/**
 * Two-sided permutation p-value for the difference in means between two arms.
 * Enumerates every label assignment exactly when the count is small; otherwise
 * draws fixed-seed random assignments.
 */
function permutationPValue(
	treatment: number[],
	baseline: number[],
	maxExact: number,
	monteCarloSamples: number,
): number {
	const pooled = [...treatment, ...baseline];
	const n = pooled.length;
	const k = treatment.length;
	const observed = Math.abs(mean(treatment) - mean(baseline));
	const total = pooled.reduce((a, b) => a + b, 0);

	// diff-of-means for a treatment group summing to `groupSum`:
	// groupSum/k - (total - groupSum)/(n - k)
	const diffFromGroupSum = (groupSum: number): number =>
		Math.abs(groupSum / k - (total - groupSum) / (n - k));

	const combos = choose(n, k);
	// Epsilon guards floating-point equality (the observed split must count).
	const eps = 1e-9;

	if (combos <= maxExact) {
		let atLeast = 0;
		const indices = Array.from({ length: k }, (_, i) => i);
		let count = 0;
		// Enumerate all k-subsets of pooled indices.
		while (true) {
			let groupSum = 0;
			for (const idx of indices) groupSum += pooled[idx] ?? 0;
			if (diffFromGroupSum(groupSum) >= observed - eps) atLeast++;
			count++;
			// advance the combination
			let i = k - 1;
			while (i >= 0 && indices[i] === n - k + i) i--;
			if (i < 0) break;
			indices[i] = (indices[i] ?? 0) + 1;
			for (let j = i + 1; j < k; j++) indices[j] = (indices[j - 1] ?? 0) + 1;
		}
		return atLeast / count;
	}

	// Monte-Carlo: random k-subsets via partial Fisher-Yates on an index array.
	const rand = mulberry32(0x5a17c0de);
	const idx = Array.from({ length: n }, (_, i) => i);
	let atLeast = 0;
	for (let s = 0; s < monteCarloSamples; s++) {
		for (let i = 0; i < k; i++) {
			const j = i + Math.floor(rand() * (n - i));
			const tmp = idx[i] ?? 0;
			idx[i] = idx[j] ?? 0;
			idx[j] = tmp;
		}
		let groupSum = 0;
		for (let i = 0; i < k; i++) groupSum += pooled[idx[i] ?? 0] ?? 0;
		if (diffFromGroupSum(groupSum) >= observed - eps) atLeast++;
	}
	// +1 smoothing avoids a p-value of exactly 0 from finite sampling.
	return (atLeast + 1) / (monteCarloSamples + 1);
}

/**
 * Compare a treatment arm against a baseline. LOWER samples are better.
 * Returns significance, the permutation p-value, both means, and a direction.
 * Refuses to decide (underpowered, inconclusive, not significant) when either
 * arm has fewer than minRuns samples.
 */
export function compareArms(
	treatment: ArmResult,
	baseline: ArmResult,
	opts: CompareOptions = {},
): CompareResult {
	const alpha = opts.alpha ?? DEFAULT_ALPHA;
	const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
	const maxExact = opts.maxExactPermutations ?? DEFAULT_MAX_EXACT;
	const monteCarloSamples = opts.monteCarloSamples ?? DEFAULT_MONTE_CARLO;

	const treatmentMean = mean(treatment.runs);
	const baselineMean = mean(baseline.runs);
	const underpowered = treatment.runs.length < minRuns || baseline.runs.length < minRuns;

	if (underpowered) {
		return {
			significant: false,
			pValue: 1,
			treatmentMean,
			baselineMean,
			direction: "inconclusive",
			underpowered: true,
		};
	}

	const pValue = permutationPValue(treatment.runs, baseline.runs, maxExact, monteCarloSamples);
	const significant = pValue < alpha && treatmentMean !== baselineMean;

	let direction: ArmDirection = "inconclusive";
	if (significant) {
		direction = treatmentMean < baselineMean ? "better" : "worse";
	}

	return {
		significant,
		pValue,
		treatmentMean,
		baselineMean,
		direction,
		underpowered: false,
	};
}

/**
 * The quartermaster's accept/reject gate: accept a mutation ONLY on a
 * significant improvement (lower stumble rate). Underpowered, inconclusive, or
 * significantly-worse comparisons all reject.
 */
export function shouldAcceptMutation(
	treatment: ArmResult,
	baseline: ArmResult,
	opts: CompareOptions = {},
): boolean {
	const result = compareArms(treatment, baseline, opts);
	return result.significant && result.direction === "better";
}
