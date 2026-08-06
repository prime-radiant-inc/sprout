#!/usr/bin/env bun
/**
 * eval-curation.ts — LIVE end-to-end proof that the curator adopts rot removal.
 *
 * Builds the PRODUCTION mutation gate wiring (the same LiveTaskExecutor + live
 * canary harness the learn loop uses under SPROUT_MUTATION_GATE=1), plants an
 * UNUSED "rot" program into an isolated copy of the live genome, and runs the
 * full N-run A/B + canary suite over a `retire_program` mutation with
 * intent=curation. Prints the verdict and the full report.
 *
 * The point: before the Phase-6 fix the gate only accepted a SIGNIFICANT
 * improvement, so retiring unused rot could never adopt (curation was inert).
 * With the non-regression curation verdict, an unused-program retirement that
 * does not regress fitness or canaries should ADOPT. This costs real model
 * runs (2 arms × sap tasks × N).
 *
 *   bun run scripts/eval-curation.ts [--tier fast|balanced|best] [--runs N]
 */

import { config as loadDotenv } from "dotenv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGenomePathFromEnv } from "../src/host/cli-parse.ts";
import { resolveStartupCwd, startBusInfrastructure } from "../src/host/cli-shared.ts";
import { resolveRuntimeRootDir } from "../src/host/embedded-root.ts";
import { Genome } from "../src/genome/genome.ts";
import { exampleCanaries } from "../src/learn/canary-suite.ts";
import { createLiveCanaryHarness } from "../src/learn/canary-live-harness.ts";
import { createEvalSnapshot } from "../src/learn/eval-harness.ts";
import { sapTasks } from "../src/learn/eval-tasks.ts";
import { applyMutationToGenome } from "../src/learn/learn-process.ts";
import { LiveTaskExecutor } from "../src/learn/live-task-executor.ts";
import { evaluateMutationForAdoption } from "../src/learn/mutation-gate.ts";
import type { Tier } from "../src/shared/provider-settings.ts";
import { installSproutSelfInvocationEnv } from "../src/util/self-command.ts";

function log(line = ""): void {
	process.stdout.write(`${line}\n`);
}

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}
const tier = flag("--tier", "balanced") as Tier;
const runs = Number(flag("--runs", "5"));
const ROT_NAME = "rot_unused_probe";

async function main(): Promise<void> {
	const envCwd = await resolveStartupCwd(process.cwd());
	loadDotenv({ path: join(envCwd, ".env"), quiet: true });
	installSproutSelfInvocationEnv({
		argv: [process.argv[0] ?? "bun", join(import.meta.dir, "../src/host/cli.ts")],
	});

	const genomePath = defaultGenomePathFromEnv();
	const rootDir = await resolveRuntimeRootDir({ sourceRootDir: join(import.meta.dir, "../root") });

	log(`Live genome:   ${genomePath}`);
	log(`Model tier:    ${tier}`);
	log(`Runs per arm:  ${runs}`);
	log(`Rot program:   ${ROT_NAME} (planted, never invoked)`);

	// A throwaway "live" genome = an isolated copy of the real genome + a planted
	// unused program. Retiring it is the rot-removal the curator should adopt.
	const base = await createEvalSnapshot(genomePath, "curation-base");
	const baseGenome = new Genome(base.genomePath, rootDir);
	await baseGenome.loadFromDisk();
	await baseGenome.addProgram({
		name: ROT_NAME,
		description: "Planted unused probe program — never invoked by any task.",
		params: [],
		spawns: [],
		version: 1,
		body: "return 42;",
	});
	log(`Planted genome: ${base.genomePath}`);

	// Two arms snapshot the rot genome. Candidate retires the rot; baseline keeps
	// it — exactly what the production snapshot gate does per proposal.
	const baselineSnap = await createEvalSnapshot(base.genomePath, "curation-baseline");
	const candidateSnap = await createEvalSnapshot(base.genomePath, "curation-candidate");
	const baselineWork = await mkdtemp(join(tmpdir(), "sprout-curation-baseline-"));
	const candidateWork = await mkdtemp(join(tmpdir(), "sprout-curation-candidate-"));

	const candidateGenome = new Genome(candidateSnap.genomePath, rootDir);
	await candidateGenome.loadFromDisk();
	await applyMutationToGenome(candidateGenome, { type: "retire_program", program_name: ROT_NAME });
	log(`Candidate:      retired ${ROT_NAME} (baseline keeps it)\n`);

	const buildExecutor = (workDir: string) =>
		new LiveTaskExecutor({
			rootDir,
			workDir,
			startBusInfrastructure,
			selectionRequest: { kind: "tier", tier },
		});
	const candidateExecutor = buildExecutor(candidateWork);
	const baselineExecutor = buildExecutor(baselineWork);

	log("=== Running the live N-run A/B + canary suite (curation intent) ===");
	const result = await evaluateMutationForAdoption({
		candidateArm: {
			tasks: sapTasks,
			executor: candidateExecutor,
			snapshot: candidateSnap,
			workDir: candidateWork,
		},
		baselineArm: {
			tasks: sapTasks,
			executor: baselineExecutor,
			snapshot: baselineSnap,
			workDir: baselineWork,
		},
		canaries: exampleCanaries,
		candidateCanaryHarness: createLiveCanaryHarness({
			executor: candidateExecutor,
			snapshot: candidateSnap,
			workDir: candidateWork,
		}),
		baselineCanaryHarness: createLiveCanaryHarness({
			executor: baselineExecutor,
			snapshot: baselineSnap,
			workDir: baselineWork,
		}),
		runs,
		intent: "curation",
	});

	const gate = result.abReport.perTier[result.abReport.gateTier];
	log("\n===== VERDICT =====");
	log(`adopt:            ${result.adopt}`);
	log(`reason:           ${result.reason}`);
	log(`A/B gate tier:    ${result.abReport.gateTier}`);
	log(
		`A/B gate:         significant=${gate.significant} direction=${gate.direction} ` +
			`underpowered=${gate.underpowered} p=${gate.pValue?.toFixed(4) ?? "n/a"} ` +
			`treat=${gate.treatmentMean?.toFixed(3) ?? "n/a"} base=${gate.baselineMean?.toFixed(3) ?? "n/a"}`,
	);
	log(
		`canaries before:  ${result.canaryBefore.map((c) => `${c.id}=${c.passed ? "PASS" : "FAIL"}`).join(", ")}`,
	);
	log(
		`canaries after:   ${result.canaryAfter.map((c) => `${c.id}=${c.passed ? "PASS" : "FAIL"}`).join(", ")}`,
	);
	log(
		`\n${result.adopt ? "✅ CURATION ADOPTED" : "❌ CURATION REJECTED"} — the curator ${result.adopt ? "removed unused rot on non-regression" : "declined"} (reason: ${result.reason}).`,
	);

	await Promise.all([
		base.cleanup(),
		baselineSnap.cleanup(),
		candidateSnap.cleanup(),
		rm(baselineWork, { recursive: true, force: true }),
		rm(candidateWork, { recursive: true, force: true }),
	]);
}

// Live sessions can leak event-loop handles (dozens of real runs); exit
// explicitly once the verdict is printed and the temp dirs are removed.
main().then(
	() => process.exit(0),
	(err) => {
		log(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
		process.exit(1);
	},
);
