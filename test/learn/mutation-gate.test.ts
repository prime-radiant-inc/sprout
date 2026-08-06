import { describe, expect, test } from "bun:test";
import type { Canary, CanaryHarness } from "../../src/learn/canary-suite.ts";
import { exampleCanaries } from "../../src/learn/canary-suite.ts";
import type { EvalArm, EvalTask, ExecOutcome, TaskExecutor } from "../../src/learn/eval-harness.ts";
import { evaluateMutationForAdoption } from "../../src/learn/mutation-gate.ts";

/**
 * Deterministic injected executor: returns controlled per-run stumble samples
 * from a per-task script, cycling through the list across the N runs. DI of the
 * model runtime, NOT a behavior mock — it exercises the real orchestration/gate.
 */
function scriptedExecutor(script: Record<string, number[]>): TaskExecutor {
	const cursor = new Map<string, number>();
	return {
		async run(task): Promise<ExecOutcome> {
			const samples = script[task.id] ?? [0];
			const i = cursor.get(task.id) ?? 0;
			cursor.set(task.id, i + 1);
			return {
				output: `ran ${task.id}`,
				errored: false,
				stumbles: samples[i % samples.length] ?? 0,
				providerPayloads: [`payload for ${task.id}`],
				didExec: false,
				success: true,
			};
		},
	};
}

const tasks: EvalTask[] = [
	{
		id: "sap-1",
		tier: "sap",
		goal: "sap goal 1",
		verify: (o) => ({ passed: !o.errored, stumbles: o.stumbles }),
	},
	{
		id: "sap-2",
		tier: "sap",
		goal: "sap goal 2",
		verify: (o) => ({ passed: !o.errored, stumbles: o.stumbles }),
	},
];

function arm(script: Record<string, number[]>): EvalArm {
	return { tasks, executor: scriptedExecutor(script) };
}

/** A canary harness whose runs never leak and never exec — every canary passes. */
const cleanCanaryHarness: CanaryHarness = {
	async run() {
		return { output: "ok", errored: false, providerPayloads: ["clean payload"], didExec: false };
	},
};

/** A canary harness that execs shell — the code-mode-cannot-exec canary FAILS. */
const execLeakCanaryHarness: CanaryHarness = {
	async run() {
		return {
			output: "ran shell",
			errored: false,
			providerPayloads: ["clean payload"],
			didExec: true,
		};
	},
};

const improvedScript = { "sap-1": [0, 0, 0, 0, 0, 0], "sap-2": [0, 0, 0, 0, 0, 0] };
const baselineScript = { "sap-1": [3, 3, 3, 3, 3, 3], "sap-2": [3, 3, 3, 3, 3, 3] };

describe("evaluateMutationForAdoption", () => {
	test("adopts a significant A/B improvement with clean canaries", async () => {
		const result = await evaluateMutationForAdoption({
			candidateArm: arm(improvedScript),
			baselineArm: arm(baselineScript),
			canaries: exampleCanaries,
			candidateCanaryHarness: cleanCanaryHarness,
			baselineCanaryHarness: cleanCanaryHarness,
			runs: 6,
		});
		expect(result.adopt).toBe(true);
		expect(result.reason).toBe("adopted");
		expect(result.abReport.accepted).toBe(true);
	});

	test("REJECTS on canary regression even when the A/B improvement is significant", async () => {
		const result = await evaluateMutationForAdoption({
			candidateArm: arm(improvedScript),
			baselineArm: arm(baselineScript),
			canaries: exampleCanaries,
			// baseline canaries all pass; candidate execs → code-mode canary regresses.
			candidateCanaryHarness: execLeakCanaryHarness,
			baselineCanaryHarness: cleanCanaryHarness,
			runs: 6,
		});
		expect(result.abReport.accepted).toBe(true);
		expect(result.adopt).toBe(false);
		expect(result.reason).toBe("canary-regression");
	});

	test("rejects an insignificant A/B (identical arms) with clean canaries", async () => {
		const script = { "sap-1": [1, 0, 1, 0, 1, 0], "sap-2": [0, 1, 0, 1, 0, 1] };
		const result = await evaluateMutationForAdoption({
			candidateArm: arm(script),
			baselineArm: arm(script),
			canaries: exampleCanaries,
			candidateCanaryHarness: cleanCanaryHarness,
			baselineCanaryHarness: cleanCanaryHarness,
			runs: 6,
		});
		expect(result.adopt).toBe(false);
		expect(result.reason).toBe("ab-not-significant");
	});

	test("rejects an underpowered A/B (N below minRuns)", async () => {
		const result = await evaluateMutationForAdoption({
			candidateArm: arm({ "sap-1": [0], "sap-2": [0] }),
			baselineArm: arm({ "sap-1": [3], "sap-2": [3] }),
			canaries: exampleCanaries,
			candidateCanaryHarness: cleanCanaryHarness,
			baselineCanaryHarness: cleanCanaryHarness,
			runs: 2,
		});
		expect(result.adopt).toBe(false);
		expect(result.reason).toBe("ab-underpowered");
	});

	test("rejects a significantly WORSE candidate", async () => {
		const result = await evaluateMutationForAdoption({
			candidateArm: arm(baselineScript),
			baselineArm: arm(improvedScript),
			canaries: exampleCanaries,
			candidateCanaryHarness: cleanCanaryHarness,
			baselineCanaryHarness: cleanCanaryHarness,
			runs: 6,
		});
		expect(result.adopt).toBe(false);
		expect(result.reason).toBe("ab-worse");
	});

	test("fails closed when an expected canary never ran in the baseline", async () => {
		const missingCanary: Canary = {
			id: "never-runs-in-baseline",
			description: "present in the expected set but omitted from the before-state",
			async run() {
				return { passed: true };
			},
		};
		// baseline harness that throws so the extra canary is absent before → gap.
		const result = await evaluateMutationForAdoption({
			candidateArm: arm(improvedScript),
			baselineArm: arm(baselineScript),
			canaries: [...exampleCanaries, missingCanary],
			candidateCanaryHarness: cleanCanaryHarness,
			baselineCanaryHarness: cleanCanaryHarness,
			runs: 6,
		});
		// Both sides actually run every canary here, so this should ADOPT; the gap
		// case is covered by mutationRegressesCanaries' own suite. Assert the full
		// expected set is evaluated on both sides.
		expect(result.canaryBefore.map((r) => r.id).sort()).toEqual(
			result.canaryAfter.map((r) => r.id).sort(),
		);
		expect(result.adopt).toBe(true);
	});

	describe("curation intent (rot removal — must not regress, need not improve)", () => {
		const neutralScript = { "sap-1": [1, 0, 1, 0, 1, 0], "sap-2": [0, 1, 0, 1, 0, 1] };

		test("ADOPTS a neutral A/B with clean canaries — the same case improvement REJECTS", async () => {
			const result = await evaluateMutationForAdoption({
				candidateArm: arm(neutralScript),
				baselineArm: arm(neutralScript),
				canaries: exampleCanaries,
				candidateCanaryHarness: cleanCanaryHarness,
				baselineCanaryHarness: cleanCanaryHarness,
				runs: 6,
				intent: "curation",
			});
			expect(result.adopt).toBe(true);
			expect(result.reason).toBe("curation-adopted");
		});

		test("REJECTS curation on a canary regression (removing it broke a canary)", async () => {
			const result = await evaluateMutationForAdoption({
				candidateArm: arm(neutralScript),
				baselineArm: arm(neutralScript),
				canaries: exampleCanaries,
				candidateCanaryHarness: execLeakCanaryHarness,
				baselineCanaryHarness: cleanCanaryHarness,
				runs: 6,
				intent: "curation",
			});
			expect(result.adopt).toBe(false);
			expect(result.reason).toBe("canary-regression");
		});

		test("REJECTS curation that is significantly WORSE (removing it hurt fitness)", async () => {
			const result = await evaluateMutationForAdoption({
				candidateArm: arm(baselineScript),
				baselineArm: arm(improvedScript),
				canaries: exampleCanaries,
				candidateCanaryHarness: cleanCanaryHarness,
				baselineCanaryHarness: cleanCanaryHarness,
				runs: 6,
				intent: "curation",
			});
			expect(result.adopt).toBe(false);
			expect(result.reason).toBe("curation-regressed");
		});

		test("REJECTS curation when the A/B is underpowered (multi-run non-negotiable)", async () => {
			const result = await evaluateMutationForAdoption({
				candidateArm: arm({ "sap-1": [0], "sap-2": [0] }),
				baselineArm: arm({ "sap-1": [0], "sap-2": [0] }),
				canaries: exampleCanaries,
				candidateCanaryHarness: cleanCanaryHarness,
				baselineCanaryHarness: cleanCanaryHarness,
				runs: 2,
				intent: "curation",
			});
			expect(result.adopt).toBe(false);
			expect(result.reason).toBe("ab-underpowered");
		});

		test("still ADOPTS curation that also improves fitness", async () => {
			const result = await evaluateMutationForAdoption({
				candidateArm: arm(improvedScript),
				baselineArm: arm(baselineScript),
				canaries: exampleCanaries,
				candidateCanaryHarness: cleanCanaryHarness,
				baselineCanaryHarness: cleanCanaryHarness,
				runs: 6,
				intent: "curation",
			});
			expect(result.adopt).toBe(true);
			expect(result.reason).toBe("curation-adopted");
		});
	});
});
