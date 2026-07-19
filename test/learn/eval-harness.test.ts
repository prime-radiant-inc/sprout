import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareGenomes,
	createEvalSnapshot,
	type EvalTask,
	type ExecOutcome,
	runEvalArm,
	type TaskExecutor,
} from "../../src/learn/eval-harness.ts";
import { sapTasks } from "../../src/learn/eval-tasks.ts";

function sapTask(id: string): EvalTask {
	const task = sapTasks.find((t) => t.id === id);
	if (!task) throw new Error(`no sap task ${id}`);
	return task;
}

/**
 * Deterministic injected executor: returns controlled per-run stumble samples
 * from a per-task script, cycling through the list across the N runs. This is
 * dependency injection of the model runtime, NOT a behavior mock — it exercises
 * the real orchestration/aggregation/gate-feeding logic.
 */
function scriptedExecutor(script: Record<string, number[]>): TaskExecutor {
	const cursor = new Map<string, number>();
	return {
		async run(task): Promise<ExecOutcome> {
			const samples = script[task.id] ?? [0];
			const i = cursor.get(task.id) ?? 0;
			cursor.set(task.id, i + 1);
			const stumbles = samples[i % samples.length] ?? 0;
			return {
				output: `ran ${task.id}`,
				errored: false,
				stumbles,
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
	{
		id: "gen-1",
		tier: "general",
		goal: "general goal 1",
		verify: (o) => ({ passed: !o.errored, stumbles: o.stumbles }),
	},
];

describe("runEvalArm", () => {
	test("runs each task N times and aggregates per-run stumble samples per tier", async () => {
		const exec = scriptedExecutor({
			"sap-1": [1, 1, 1, 1, 1],
			"sap-2": [0, 0, 0, 0, 0],
			"gen-1": [2, 2, 2, 2, 2],
		});
		const report = await runEvalArm({ tasks, executor: exec }, { runs: 5 });

		// sap tier: 2 tasks x 5 runs = 10 samples.
		expect(report.perTier.sap.runs.length).toBe(10);
		expect(report.perTier.general.runs.length).toBe(5);
		// sap-1 contributed five 1s and sap-2 five 0s.
		expect(report.perTier.sap.runs.filter((s) => s === 1).length).toBe(5);
		expect(report.perTier.sap.runs.filter((s) => s === 0).length).toBe(5);
		expect(report.perTier.general.runs.every((s) => s === 2)).toBe(true);
		expect(report.passRateByTier.sap).toBe(1);
		expect(report.runs).toBe(5);
	});
});

describe("compareGenomes", () => {
	test("identical arms are NOT significant (no false accept) per real compareArms", async () => {
		const script = {
			"sap-1": [1, 0, 1, 0, 1, 0],
			"sap-2": [0, 1, 0, 1, 0, 1],
			"gen-1": [1, 1, 0, 0, 1, 1],
		};
		const treatment = { tasks, executor: scriptedExecutor(script) };
		const baseline = { tasks, executor: scriptedExecutor(script) };

		const cmp = await compareGenomes(treatment, baseline, { runs: 6 });

		expect(cmp.perTier.sap.significant).toBe(false);
		expect(cmp.perTier.sap.underpowered).toBe(false);
		expect(cmp.accepted).toBe(false);
		// gate tier is sap, headline is general.
		expect(cmp.gateTier).toBe("sap");
		expect(cmp.headlineTier).toBe("general");
	});

	test("a genuine sap-tier improvement is accepted via shouldAcceptMutation", async () => {
		const baselineScript = {
			"sap-1": [3, 3, 3, 3, 3, 3],
			"sap-2": [3, 3, 3, 3, 3, 3],
			"gen-1": [1, 1, 1, 1, 1, 1],
		};
		const treatmentScript = {
			"sap-1": [0, 0, 0, 0, 0, 0],
			"sap-2": [0, 0, 0, 0, 0, 0],
			"gen-1": [1, 1, 1, 1, 1, 1],
		};
		const cmp = await compareGenomes(
			{ tasks, executor: scriptedExecutor(treatmentScript) },
			{ tasks, executor: scriptedExecutor(baselineScript) },
			{ runs: 6 },
		);
		expect(cmp.perTier.sap.significant).toBe(true);
		expect(cmp.perTier.sap.direction).toBe("better");
		expect(cmp.accepted).toBe(true);
	});

	test("N below the A/B minRuns leaves the gate underpowered (no accept)", async () => {
		const cmp = await compareGenomes(
			{ tasks, executor: scriptedExecutor({ "sap-1": [0], "sap-2": [0], "gen-1": [0] }) },
			{ tasks, executor: scriptedExecutor({ "sap-1": [3], "sap-2": [3], "gen-1": [3] }) },
			{ runs: 2 },
		);
		// 2 tasks x 2 runs = 4 samples per sap arm, below the default minRuns of 5.
		expect(cmp.perTier.sap.underpowered).toBe(true);
		expect(cmp.accepted).toBe(false);
	});
});

describe("sap leak task (materialized secret, never in the goal)", () => {
	/**
	 * Executor that reads the materialized source file and echoes its body into a
	 * provider payload — a candidate that transcribes the captured secret instead
	 * of routing it through the store via $ref. The leak is anchored on the REAL
	 * materialized secret, not a hard-coded string.
	 */
	function transcribingExecutor(workDir: string): TaskExecutor {
		return {
			async run(task, snapshot): Promise<ExecOutcome> {
				void snapshot;
				const source = await readFile(join(workDir, "capture-source.txt"), "utf8");
				return {
					output: "done",
					errored: false,
					stumbles: 0,
					providerPayloads: [`goal: ${task.goal}\ncaptured body: ${source}`],
					didExec: false,
					success: true,
				};
			},
		};
	}

	/** Executor that routes the source through the store — its body never enters a payload. */
	function storeRoutingExecutor(): TaskExecutor {
		return {
			async run(task): Promise<ExecOutcome> {
				return {
					output: "done",
					errored: false,
					stumbles: 0,
					providerPayloads: [`goal: ${task.goal}\ncaptured body: $ref:cap-1`],
					didExec: false,
					success: true,
				};
			},
		};
	}

	test("passes when content is routed through the store (secret absent from payloads)", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "sprout-eval-leak-pass-"));
		try {
			const report = await runEvalArm(
				{ tasks: [sapTask("sap-capture-splice")], executor: storeRoutingExecutor(), workDir },
				{ runs: 1 },
			);
			expect(report.passRateByTier.sap).toBe(1);
			expect(report.samples.every((s) => s.passed)).toBe(true);
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});

	test("fails when the executor echoes the materialized source into a payload", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "sprout-eval-leak-fail-"));
		try {
			const report = await runEvalArm(
				{
					tasks: [sapTask("sap-capture-splice")],
					executor: transcribingExecutor(workDir),
					workDir,
				},
				{ runs: 1 },
			);
			expect(report.passRateByTier.sap).toBe(0);
			expect(report.samples[0]?.detail).toBe("captured secret leaked into a provider payload");
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});

	test("the leak secret is never present in the goal text", () => {
		// The goal must not carry the sentinel: it is sent to the model, so anything
		// baked into it would always appear in a payload and the leak check could
		// never pass.
		expect(sapTask("sap-capture-splice").goal).not.toMatch(/SAP-EVAL-SECRET-/);
	});

	test("runEvalArm materializes the capture source file before the executor runs", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "sprout-eval-materialize-"));
		try {
			let existedDuringRun = false;
			const probe: TaskExecutor = {
				async run(task): Promise<ExecOutcome> {
					existedDuringRun = existsSync(join(workDir, "capture-source.txt"));
					return {
						output: "done",
						errored: false,
						stumbles: 0,
						providerPayloads: [`goal: ${task.goal}`],
						didExec: false,
						success: true,
					};
				},
			};
			await runEvalArm(
				{ tasks: [sapTask("sap-capture-splice")], executor: probe, workDir },
				{ runs: 1 },
			);
			expect(existedDuringRun).toBe(true);
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});
});

describe("createEvalSnapshot (isolation)", () => {
	test("copies the genome so eval-mode writes never touch the live genome", async () => {
		const live = await mkdtemp(join(tmpdir(), "sprout-eval-live-"));
		try {
			await writeFile(join(live, "genome.json"), JSON.stringify({ marker: "original" }));
			const snapshot = await createEvalSnapshot(live);
			try {
				expect(snapshot.genomePath).not.toBe(live);
				// A mutation inside the snapshot must not reach the live genome.
				await writeFile(
					join(snapshot.genomePath, "genome.json"),
					JSON.stringify({ marker: "mutated" }),
				);
				const liveContent = JSON.parse(await readFile(join(live, "genome.json"), "utf8"));
				expect(liveContent.marker).toBe("original");
			} finally {
				await snapshot.cleanup();
			}
		} finally {
			await rm(live, { recursive: true, force: true });
		}
	});
});
