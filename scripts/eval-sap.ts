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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capturedContentNeverInPayloadCanary,
	exampleCanaries,
	runCanarySuite,
} from "../src/learn/canary-suite.ts";
import { createLiveCanaryHarness } from "../src/learn/canary-live-harness.ts";
import { compareGenomes, createEvalSnapshot, type EvalTier, runEvalArm } from "../src/learn/eval-harness.ts";
import { pinnedEvalTasks, SAP_CAPTURE_SENTINEL, sapTasks } from "../src/learn/eval-tasks.ts";

const smokeTasks = sapTasks;
import { LiveTaskExecutor, type LiveTaskExecutorConfig } from "../src/learn/live-task-executor.ts";
import { defaultGenomePathFromEnv } from "../src/host/cli-parse.ts";
import { resolveStartupCwd, startBusInfrastructure } from "../src/host/cli-shared.ts";
import { resolveRuntimeRootDir } from "../src/host/embedded-root.ts";
import type { Tier } from "../src/shared/provider-settings.ts";

interface Args {
	smoke: boolean;
	runs: number;
	tier: Tier;
	genome?: string;
	cwd?: string;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { smoke: false, runs: 5, tier: "fast", help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--smoke") args.smoke = true;
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

  --smoke   one cheap sap task + keystone canary (proves the live path)
  --runs N  runs per task for the full A/B (default 5)
  --tier    model tier to force (default fast)
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
	};

	try {
		if (args.smoke) {
			await runSmoke(executorConfig, snapshot);
			return;
		}
		await runFull(executorConfig, snapshot, args.runs);
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
	// The sap capture task reads ./capture-source.txt; materialize it in the work
	// dir (isolated) so the model has a real source to capture and splice.
	const workDir = executorConfig.workDir ?? process.cwd();
	await writeFile(
		join(workDir, "capture-source.txt"),
		`${SAP_CAPTURE_SENTINEL}\nThis is confidential source material captured for splicing.\n`,
	);
	const outcome = await executor.run(task, snapshot);
	const verdict = task.verify(outcome);
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

async function runFull(
	executorConfig: LiveTaskExecutorConfig,
	snapshot: Awaited<ReturnType<typeof createEvalSnapshot>>,
	runs: number,
): Promise<void> {
	log(`\n=== FULL: ${pinnedEvalTasks.length} pinned tasks x ${runs} runs ===`);
	const executor = new LiveTaskExecutor(executorConfig);

	const report = await runEvalArm({ tasks: pinnedEvalTasks, executor, snapshot }, { runs });
	for (const tier of ["sap", "general"] as EvalTier[]) {
		const label = tier === "sap" ? "sap (A/B GATE)" : "general (HEADLINE)";
		const arm = report.perTier[tier];
		const mean = arm.runs.length ? arm.runs.reduce((a, b) => a + b, 0) / arm.runs.length : 0;
		log(
			`  ${label}: samples=${arm.runs.length} meanStumbles=${mean.toFixed(3)} passRate=${report.passRateByTier[tier].toFixed(3)}`,
		);
	}

	// Identical-arm A/B sanity: same snapshot both arms must NOT be significant.
	log("\n=== A/B (candidate vs itself — must be NOT significant) ===");
	const cmp = await compareGenomes(
		{ tasks: pinnedEvalTasks, executor, snapshot },
		{ tasks: pinnedEvalTasks, executor, snapshot },
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
