/**
 * The REAL CanaryHarness adapter (spec Phase 4).
 *
 * The stub `CanaryHarness` (canary-suite.ts) becomes a live adapter here: it
 * runs a canary's task through a `TaskExecutor` against a candidate genome
 * snapshot and returns the real `CanaryRunOutcome` — real provider payloads and
 * the real `didExec` flag — so the keystone (captured content never in a
 * provider payload) and code-mode-cannot-exec canaries evaluate from real bytes.
 *
 * The executor is INJECTED: the live entrypoint supplies a `LiveTaskExecutor`
 * (real model); tests supply a deterministic executor to exercise the adapter's
 * real wiring (input materialization + outcome pass-through) offline.
 *
 * THE HIDING CONTRACT holds: the canary set and its outcomes are never rendered
 * to the model. The adapter only materializes a canary's opaque per-task inputs
 * (e.g. a secret to smuggle-test) as files the goal can reference; the goal text
 * itself carries no canary identity.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanaryHarness, CanaryRunOutcome, CanaryTask } from "./canary-suite.ts";
import type { EvalTask, GenomeSnapshot, TaskExecutor } from "./eval-harness.ts";

export interface LiveCanaryHarnessConfig {
	/** Runs the canary's goal against the candidate (real model in the live path). */
	executor: TaskExecutor;
	/** The candidate genome snapshot the canaries run against (eval mode). */
	snapshot: GenomeSnapshot;
	/**
	 * Directory where per-task inputs (a secret to smuggle-test) are materialized
	 * as source files the goal reads. MUST match the executor's work dir.
	 */
	workDir: string;
}

/**
 * Materialize a canary's opaque inputs into the work dir. A secret is written to
 * the source files the capture/keystone goals read, so the run has a real source
 * to capture and the harness can assert whether its bytes leaked.
 */
async function materializeInputs(workDir: string, task: CanaryTask): Promise<void> {
	const secret = task.inputs?.secret;
	if (typeof secret === "string") {
		const body = `${secret}\nThis is confidential source material captured for splicing.\n`;
		await writeFile(join(workDir, "capture-source.txt"), body);
		await writeFile(join(workDir, "secret-source.txt"), body);
	}
}

/**
 * Build a live `CanaryHarness` over a candidate genome snapshot. Each
 * `harness.run(task)` materializes the task's inputs, executes its goal via the
 * injected executor in eval mode, and returns the observed outcome with real
 * provider payloads and exec flag.
 */
export function createLiveCanaryHarness(config: LiveCanaryHarnessConfig): CanaryHarness {
	return {
		async run(task: CanaryTask): Promise<CanaryRunOutcome> {
			await materializeInputs(config.workDir, task);
			const evalTask: EvalTask = {
				id: "canary-run",
				tier: "sap",
				goal: task.goal,
				verify: () => ({ passed: true, stumbles: 0 }),
			};
			try {
				const outcome = await config.executor.run(evalTask, config.snapshot);
				return {
					output: outcome.output,
					errored: outcome.errored,
					providerPayloads: outcome.providerPayloads,
					didExec: outcome.didExec,
				};
			} catch (error) {
				return {
					output: error instanceof Error ? error.message : String(error),
					errored: true,
					providerPayloads: [],
					didExec: false,
				};
			}
		},
	};
}
