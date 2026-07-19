import { describe, expect, test } from "bun:test";
import { type ArmResult, compareArms, shouldAcceptMutation } from "../../src/learn/multi-run-ab.ts";

const arm = (runs: number[]): ArmResult => ({ runs });

describe("compareArms permutation test", () => {
	test("identical noisy arms are NOT significant (no false accept)", () => {
		const a = arm([0, 6, 1, 5, 3, 2]);
		const b = arm([2, 3, 5, 1, 6, 0]);
		const r = compareArms(a, b);
		expect(r.significant).toBe(false);
		expect(r.direction).toBe("inconclusive");
		expect(r.pValue).toBeGreaterThan(0.05);
	});

	test("a clearly-better treatment (all lower) is significant + better", () => {
		const treatment = arm([0, 0, 1, 0, 1]);
		const baseline = arm([5, 6, 5, 6, 5]);
		const r = compareArms(treatment, baseline);
		expect(r.significant).toBe(true);
		expect(r.direction).toBe("better");
		expect(r.pValue).toBeLessThan(0.05);
		expect(shouldAcceptMutation(treatment, baseline)).toBe(true);
	});

	test("a clearly-worse treatment is significant + worse, and rejected", () => {
		const treatment = arm([5, 6, 5, 6, 5]);
		const baseline = arm([0, 0, 1, 0, 1]);
		const r = compareArms(treatment, baseline);
		expect(r.significant).toBe(true);
		expect(r.direction).toBe("worse");
		expect(shouldAcceptMutation(treatment, baseline)).toBe(false);
	});

	test("below min-runs is inconclusive and never accepts", () => {
		const treatment = arm([0, 0, 0]);
		const baseline = arm([5, 5, 5]);
		const r = compareArms(treatment, baseline);
		expect(r.underpowered).toBe(true);
		expect(r.significant).toBe(false);
		expect(r.direction).toBe("inconclusive");
		expect(shouldAcceptMutation(treatment, baseline)).toBe(false);
	});

	test("permutation p-value matches a hand-computed small case", () => {
		// treatment {0,0}, baseline {3,3}. Pooled {0,0,3,3}, choose 2 of 4 = 6
		// splits. Group sums: {0,0}=0, {0,3}=3 (x4), {3,3}=6.
		// diff-of-means = |sum/2 - (6-sum)/2|: sum0->3, sum3->0, sum6->3.
		// observed = |0 - 3| = 3. Splits with |diff| >= 3: {0,0} and {3,3} = 2.
		// p = 2/6 = 0.3333...
		const r = compareArms(arm([0, 0]), arm([3, 3]), { minRuns: 2 });
		expect(r.pValue).toBeCloseTo(2 / 6, 10);
		expect(r.treatmentMean).toBe(0);
		expect(r.baselineMean).toBe(3);
	});

	test("respects a custom alpha", () => {
		const treatment = arm([0, 0, 1, 0, 1]);
		const baseline = arm([5, 6, 5, 6, 5]);
		// At a stricter alpha the same clear separation stays significant.
		expect(compareArms(treatment, baseline, { alpha: 0.01 }).significant).toBe(true);
		// At an impossibly strict alpha it cannot clear the bar.
		expect(compareArms(treatment, baseline, { alpha: 0.0001 }).significant).toBe(false);
	});

	test("equal means never register as significant", () => {
		const r = compareArms(arm([2, 2, 2, 2, 2]), arm([2, 2, 2, 2, 2]));
		expect(r.significant).toBe(false);
		expect(r.direction).toBe("inconclusive");
	});

	test("Monte-Carlo fallback stays deterministic for large arms", () => {
		const treatment = arm(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0 : 1)));
		const baseline = arm(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 5 : 6)));
		const r1 = compareArms(treatment, baseline, { maxExactPermutations: 100 });
		const r2 = compareArms(treatment, baseline, { maxExactPermutations: 100 });
		expect(r1.pValue).toBe(r2.pValue);
		expect(r1.significant).toBe(true);
		expect(r1.direction).toBe("better");
	});
});
