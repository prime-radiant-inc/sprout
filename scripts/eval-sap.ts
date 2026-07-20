#!/usr/bin/env bun
/**
 * eval-sap.ts — the LIVE N-run pinned-snapshot eval harness entrypoint.
 *
 * Runs the two-tier pinned task set (src/learn/eval-tasks.ts) against a REAL
 * model via the LiveTaskExecutor, in eval mode against an isolated genome
 * snapshot (the live genome/journal is never mutated). Prints the labeled
 * per-tier report and the A/B result, and runs the real canary adapter.
 *
 * This is Phase 5's measurement tool. It hits real provider keys and costs
 * money — it is NOT part of the offline `bun run test` suite.
 *
 * USAGE
 *   bun run scripts/eval-sap.ts [options]
 *
 * OPTIONS
 *   --smoke            One cheap sap task once + the keystone canary. Proves the
 *                      live path (real model, real payload capture) at minimal cost.
 *   --runs N           Runs per task for the full A/B comparison (default 5).
 *   --tier fast|balanced|best   Model tier to force (default fast/haiku-class).
 *   --genome PATH      Live genome path (default: $SPROUT_GENOME_PATH or XDG).
 *   --cwd PATH         Working directory for the run (default: current dir).
 *   -h, --help         Show this help.
 *
 * Keys are read from .env in the working directory (repo root) the same way the
 * CLI loads them. Requires at least one provider configured.
 */

import { config as loadDotenv } from "dotenv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capturedContentNeverInPayloadCanary,
	exampleCanaries,
	runCanarySuite,
} from "../src/learn/canary-suite.ts";
import { createLiveCanaryHarness } from "../src/learn/canary-live-harness.ts";
import { compareGenomes, createEvalSnapshot, type EvalTier, runEvalArm } from "../src/learn/eval-harness.ts";
import { pinnedEvalTasks, sapTasks } from "../src/learn/eval-tasks.ts";

const smokeTasks = sapTasks;
import { LiveTaskExecutor, type LiveTaskExecutorConfig } from "../src/learn/live-task-executor.ts";
import { defaultGenomePathFromEnv } from "../src/host/cli-parse.ts";
import { resolveStartupCwd, startBusInfrastructure } from "../src/host/cli-shared.ts";
import { resolveRuntimeRootDir } from "../src/host/embedded-root.ts";
import { installSproutSelfInvocationEnv } from "../src/util/self-command.ts";
import type { Tier } from "../src/shared/provider-settings.ts";

interface Args {
	smoke: boolean;
	canaryOnly: boolean;
	runs: number;
	tier: Tier;
	genome?: string;
	cwd?: string;
	help: boolean;
	armOnly: boolean;
	/** When true, run the pre-code-mode TRADITIONAL agent (sap data plane OFF). */
	noDataPlane: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		smoke: false,
		canaryOnly: false,
		runs: 5,
		tier: "fast",
		help: false,
		armOnly: false,
		noDataPlane: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--smoke") args.smoke = true;
		else if (a === "--canary-only") args.canaryOnly = true;
		else if (a === "--arm-only") args.armOnly = true;
		else if (a === "--no-data-plane") args.noDataPlane = true;
		else if (a === "--runs") args.runs = Number(argv[++i]);
		else if (a === "--tier") args.tier = argv[++i] as Tier;
		else if (a === "--genome") args.genome = argv[++i];
		else if (a === "--cwd") args.cwd = argv[++i];
		else if (a === "-h" || a === "--help") args.help = true;
	}
	return args;
}

const HELP = `eval-sap.ts — live N-run pinned-snapshot eval harness

  bun run scripts/eval-sap.ts [--smoke] [--runs N] [--tier fast|balanced|best]
                              [--genome PATH] [--cwd PATH]

  --smoke        one cheap sap task + keystone canary (proves the live path)
  --canary-only  BOTH canaries (keystone + code-mode-cannot-exec) live, skipping
                 the A/B eval; code-mode-cannot-exec runs a real cell (exercises
                 the cell engine)
  --no-data-plane  run the pre-code-mode TRADITIONAL agent (no cell/code-mode,
                   no capture/splice) — for A/B against the code-mode/sap version
  --runs N       runs per task for the full A/B (default 5)
  --tier         model tier to force (default fast)

  Related: SPROUT_MUTATION_GATE=1 enables LIVE gating of Learn mutations in
  normal sessions (snapshot + N-run A/B + canaries per proposed mutation;
  SPROUT_MUTATION_GATE_RUNS sets N, default 10). Off by default — it costs
  real model runs.
`;

function log(line = ""): void {
	process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		log(HELP);
		return;
	}

	const envCwd = await resolveStartupCwd(args.cwd);
	loadDotenv({ path: join(envCwd, ".env"), quiet: true });

	// Subprocesses (cell worker, store worker, delegated agent processes) spawn
	// by self-invocation via buildInternalSproutCommand, which needs
	// SPROUT_SELF_EXECUTABLE/ENTRYPOINT. Without this the eval can spawn nothing
	// — the model can't run cells or delegate, so code-mode-cannot-exec passes
	// trivially (cells never ran) and any cell-touching task fails. Point the
	// entrypoint at the real CLI (which routes --internal-* subcommands), not
	// this script.
	installSproutSelfInvocationEnv({
		argv: [process.argv[0] ?? "bun", join(import.meta.dir, "../src/host/cli.ts")],
	});

	const genomePath = args.genome ?? defaultGenomePathFromEnv();
	const rootDir = await resolveRuntimeRootDir({
		sourceRootDir: join(import.meta.dir, "../root"),
	});
	// Eval mode runs in an ISOLATED temp work dir (not the user's repo): tasks and
	// the canary adapter materialize source files there, and the model operates
	// there, so nothing pollutes the caller's working tree.
	const workDir = await mkdtemp(join(tmpdir(), "sprout-eval-work-"));

	log(`Live genome:   ${genomePath}`);
	log(`Model tier:    ${args.tier}`);
	log(`Work dir:      ${workDir} (isolated)`);

	const snapshot = await createEvalSnapshot(genomePath, "candidate");
	log(`Eval snapshot: ${snapshot.genomePath} (live genome is isolated)`);

	const executorConfig: LiveTaskExecutorConfig = {
		rootDir,
		workDir,
		startBusInfrastructure,
		selectionRequest: { kind: "tier", tier: args.tier },
		// --no-data-plane runs the pre-code-mode traditional agent (data plane
		// OFF: no cell/code-mode, no capture/splice) for A/B against code-mode.
		dataPlaneEnabled: args.noDataPlane ? false : undefined,
	};
	if (args.noDataPlane) log("MODE: data plane OFF (traditional, pre-code-mode agent)");

	try {
		if (args.smoke) {
			await runSmoke(executorConfig, snapshot);
			return;
		}
		if (args.canaryOnly) {
			await runCanaryOnly(executorConfig, snapshot);
			return;
		}
		await runFull(executorConfig, snapshot, args.runs, args.armOnly);
	} finally {
		await snapshot.cleanup();
		await rm(workDir, { recursive: true, force: true });
	}
}

async function runSmoke(
	executorConfig: LiveTaskExecutorConfig,
	snapshot: Awaited<ReturnType<typeof createEvalSnapshot>>,
): Promise<void> {
	log("\n=== SMOKE: one cheap sap task, real model ===");
	const executor = new LiveTaskExecutor(executorConfig);
	const task = smokeTasks[0]; // sap-capture-splice: exercises the keystone capture+splice path
	if (!task) throw new Error("no smoke task");
	// The sap capture task's setup hook materializes ./capture-source.txt with a
	// per-run random secret in the work dir (isolated) so the model has a real
	// source to capture and splice, and verify anchors on that exact secret.
	const workDir = executorConfig.workDir ?? process.cwd();
	const context = task.setup ? await task.setup({ workDir }) : undefined;
	const outcome = await executor.run(task, snapshot);
	const verdict = task.verify(outcome, context);
	log(`task:            ${task.id}`);
	log(`model ran:       ${outcome.providerPayloads.length} provider payload(s) captured`);
	log(`output:          ${JSON.stringify(outcome.output.slice(0, 200))}`);
	log(`stumbles:        ${outcome.stumbles}`);
	log(`didExec:         ${outcome.didExec}`);
	log(`verify passed:   ${verdict.passed}${verdict.detail ? ` (${verdict.detail})` : ""}`);

	log("\n=== SMOKE: keystone canary from real payload bytes ===");
	const harness = createLiveCanaryHarness({
		executor,
		snapshot,
		workDir: executorConfig.workDir ?? process.cwd(),
	});
	const results = await runCanarySuite([capturedContentNeverInPayloadCanary], harness);
	for (const r of results) {
		log(`canary ${r.id}: ${r.passed ? "PASS" : "FAIL"}${r.detail ? ` (${r.detail})` : ""}`);
	}
}

/**
 * Both canaries (keystone + code-mode-cannot-exec) live, without the expensive
 * A/B eval. code-mode-cannot-exec runs a real code-mode cell that attempts to
 * exec, so this is the one live path that actually exercises the cell engine —
 * a real didExec:false under the configured SPROUT_CELL_ENGINE.
 */
async function runCanaryOnly(
	executorConfig: LiveTaskExecutorConfig,
	snapshot: Awaited<ReturnType<typeof createEvalSnapshot>>,
): Promise<void> {
	log("\n=== Canary suite only (real payload bytes; no A/B) ===");
	const executor = new LiveTaskExecutor(executorConfig);
	const harness = createLiveCanaryHarness({
		executor,
		snapshot,
		workDir: executorConfig.workDir ?? process.cwd(),
	});
	const canaryResults = await runCanarySuite(exampleCanaries, harness);
	let failed = 0;
	for (const r of canaryResults) {
		if (!r.passed) failed++;
		log(`  ${r.id}: ${r.passed ? "PASS" : "FAIL"}${r.detail ? ` (${r.detail})` : ""}`);
	}
	if (failed > 0) process.exitCode = 1;
}

async function runFull(
	executorConfig: LiveTaskExecutorConfig,
	snapshot: Awaited<ReturnType<typeof createEvalSnapshot>>,
	runs: number,
	armOnly = false,
): Promise<void> {
	log(`\n=== FULL: ${pinnedEvalTasks.length} pinned tasks x ${runs} runs ===`);
	const executor = new LiveTaskExecutor(executorConfig);

	const workDir = executorConfig.workDir ?? process.cwd();
	const report = await runEvalArm(
		{ tasks: pinnedEvalTasks, executor, snapshot, workDir },
		{ runs },
	);
	for (const tier of ["sap", "general"] as EvalTier[]) {
		const label = tier === "sap" ? "sap (A/B GATE)" : "general (HEADLINE)";
		const arm = report.perTier[tier];
		const mean = arm.runs.length ? arm.runs.reduce((a, b) => a + b, 0) / arm.runs.length : 0;
		log(
			`  ${label}: samples=${arm.runs.length} meanStumbles=${mean.toFixed(3)} passRate=${report.passRateByTier[tier].toFixed(3)}`,
		);
	}
	for (const s of report.samples) {
		log(`  sample ${s.tier}/${s.taskId}#${s.run}: passed=${s.passed} stumbles=${s.stumbles}${s.detail ? ` (${s.detail})` : ""}`);
	}

	if (armOnly) {
		log("\n=== arm-only: skipping self-A/B and canary suite (cost reduction) ===");
		return;
	}

	// Identical-arm A/B sanity: same snapshot both arms must NOT be significant.
	log("\n=== A/B (candidate vs itself — must be NOT significant) ===");
	const cmp = await compareGenomes(
		{ tasks: pinnedEvalTasks, executor, snapshot, workDir },
		{ tasks: pinnedEvalTasks, executor, snapshot, workDir },
		{ runs },
	);
	for (const tier of ["sap", "general"] as EvalTier[]) {
		const c = cmp.perTier[tier];
		log(
			`  ${tier}: significant=${c.significant} p=${c.pValue.toFixed(4)} treat=${c.treatmentMean.toFixed(3)} base=${c.baselineMean.toFixed(3)}`,
		);
	}
	log(`  accepted (gate=${cmp.gateTier}): ${cmp.accepted}`);

	log("\n=== Canary suite (real payload bytes) ===");
	const harness = createLiveCanaryHarness({
		executor,
		snapshot,
		workDir: executorConfig.workDir ?? process.cwd(),
	});
	const canaryResults = await runCanarySuite(exampleCanaries, harness);
	for (const r of canaryResults) {
		log(`  ${r.id}: ${r.passed ? "PASS" : "FAIL"}${r.detail ? ` (${r.detail})` : ""}`);
	}
}

main().catch((error) => {
	process.stderr.write(`eval-sap failed: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
