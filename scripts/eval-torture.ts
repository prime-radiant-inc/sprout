#!/usr/bin/env bun
/**
 * Torture eval: three-arm live comparison on the heavy task set.
 *
 *   A  current build, data plane ON  (code mode / capture-all)
 *   B  current build, data plane OFF (traditional tool-use agent)
 *   C  status quo ante — the pre-RLM baseline build run from a git worktree
 *      (default /home/jesse/sprout-rlm/sprout-baseline at main/8c573eb),
 *      driven through its own headless CLI in full isolation (memory secret
 *      backend, temp genome, temp XDG config)
 *
 * Model parity: all arms pin the same model via SPROUT_DEFAULT_*_MODEL.
 * Grading: outcome-anchored verify on output text; the payload-anchored leak
 * task reports n/a on arm C (no payload capture without instrumenting the
 * old build).
 *
 * Usage:
 *   bun run scripts/eval-torture.ts [--reps N] [--arms ABC] [--task <id>]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { defaultGenomePathFromEnv } from "../src/host/cli-parse.ts";
import { resolveStartupCwd, startBusInfrastructure } from "../src/host/cli-shared.ts";
import { resolveRuntimeRootDir } from "../src/host/embedded-root.ts";
import { createEvalSnapshot, type EvalTask, type ExecOutcome } from "../src/learn/eval-harness.ts";
import { LiveTaskExecutor, type LiveTaskExecutorConfig } from "../src/learn/live-task-executor.ts";
import { PAYLOAD_ANCHORED_TASK_IDS, tortureTasks } from "../src/learn/torture-tasks.ts";
import { installSproutSelfInvocationEnv } from "../src/util/self-command.ts";

const BASELINE_DIR = process.env.SPROUT_BASELINE_DIR ?? "/home/jesse/sprout-rlm/sprout-baseline";
const PIN_MODEL = process.env.SPROUT_TORTURE_MODEL ?? "anthropic:claude-haiku-4-5-20251001";
const ARM_TIMEOUT_MS = 300_000;

interface ArmResult {
	arm: string;
	taskId: string;
	rep: number;
	passed: boolean | "n/a";
	detail?: string;
	turns?: number;
	stumbles?: number;
	payloadBytes?: number;
	wallMs: number;
}

function log(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function parseArgs(argv: string[]) {
	const args = { reps: 1, arms: "ABC", task: undefined as string | undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--reps") args.reps = Number(argv[++i]);
		else if (argv[i] === "--arms") args.arms = String(argv[++i]).toUpperCase();
		else if (argv[i] === "--task") args.task = argv[++i];
	}
	return args;
}

/** Arm C: drive the baseline worktree's own CLI, isolated. */
async function runBaseline(task: EvalTask, workDir: string): Promise<ExecOutcome> {
	const genomeDir = await mkdtemp(join(tmpdir(), "torture-c-genome-"));
	const xdgDir = await mkdtemp(join(tmpdir(), "torture-c-xdg-"));
	const env: Record<string, string> = {
		HOME: process.env.HOME ?? "",
		PATH: process.env.PATH ?? "",
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
		SPROUT_DEFAULT_FAST_MODEL: PIN_MODEL,
		SPROUT_DEFAULT_BALANCED_MODEL: PIN_MODEL,
		SPROUT_DEFAULT_BEST_MODEL: PIN_MODEL,
		SPROUT_GENOME_PATH: genomeDir,
		XDG_CONFIG_HOME: xdgDir,
		SPROUT_SECRET_BACKEND: "memory",
	};
	const output = await new Promise<string>((resolve) => {
		const child = spawn(
			process.execPath,
			[join(BASELINE_DIR, "src/host/cli.ts"), "-p", task.goal, "--eval-mode", "--cwd", workDir],
			{ cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			err += d.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, ARM_TIMEOUT_MS);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out.length > 0 ? out : err);
		});
	});
	await rm(genomeDir, { recursive: true, force: true }).catch(() => {});
	await rm(xdgDir, { recursive: true, force: true }).catch(() => {});
	// The old CLI prints the result output then "Session: <id>".
	const cleaned = output.replace(/^Session: \S+$/m, "").trim();
	return {
		output: cleaned,
		errored: cleaned.length === 0,
		stumbles: 0,
		providerPayloads: [],
		didExec: false,
		success: cleaned.length > 0,
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const envCwd = await resolveStartupCwd(undefined);
	loadDotenv({ path: join(envCwd, ".env"), quiet: true });

	// Pin the same model on the current build's arms, and ISOLATE its settings
	// exactly like arm C's: a temp XDG config (so the user's real settings —
	// which may register different providers — never load; env-import builds an
	// anthropic provider from ANTHROPIC_API_KEY) and the in-memory secret
	// backend. Subprocesses inherit this env via the spawner's live spread.
	const xdgA = await mkdtemp(join(tmpdir(), "torture-ab-xdg-"));
	process.env.XDG_CONFIG_HOME = xdgA;
	process.env.SPROUT_SECRET_BACKEND = "memory";
	process.env.SPROUT_DEFAULT_FAST_MODEL = PIN_MODEL;
	process.env.SPROUT_DEFAULT_BALANCED_MODEL = PIN_MODEL;
	process.env.SPROUT_DEFAULT_BEST_MODEL = PIN_MODEL;

	installSproutSelfInvocationEnv({
		argv: [process.argv[0] ?? "bun", join(import.meta.dir, "../src/host/cli.ts")],
	});

	const genomePath = defaultGenomePathFromEnv();
	const rootDir = await resolveRuntimeRootDir({
		sourceRootDir: join(import.meta.dir, "../root"),
	});
	const snapshot = await createEvalSnapshot(genomePath, "torture");
	const tasks = args.task ? tortureTasks.filter((t) => t.id === args.task) : tortureTasks;
	if (tasks.length === 0) throw new Error(`no such task: ${args.task}`);

	log(`Torture eval: arms=${args.arms} reps=${args.reps} model=${PIN_MODEL}`);
	log(`Baseline:     ${BASELINE_DIR} (status quo ante)`);
	log(`Tasks:        ${tasks.map((t) => t.id).join(", ")}\n`);

	const results: ArmResult[] = [];
	const scratchDirs: string[] = [];
	const workDirFor = async (arm: string) => {
		const d = await mkdtemp(join(tmpdir(), `torture-${arm}-`));
		scratchDirs.push(d);
		return d;
	};

	try {
		for (const task of tasks) {
			for (let rep = 1; rep <= args.reps; rep++) {
				for (const arm of args.arms) {
					// Fresh executors per run: work dirs are per-run, and the executor
					// config binds one.
					const wd = await workDirFor(arm);
					const mkConfig = (dataPlane: boolean | undefined): LiveTaskExecutorConfig => ({
						rootDir,
						workDir: wd,
						startBusInfrastructure,
						selectionRequest: { kind: "tier", tier: "fast" },
						dataPlaneEnabled: dataPlane,
					});
					const executors = {
						A: new LiveTaskExecutor(mkConfig(undefined)),
						B: new LiveTaskExecutor(mkConfig(false)),
					};
					const context = task.setup ? await task.setup({ workDir: wd }) : undefined;
					const started = Date.now();
					let outcome: ExecOutcome;
					if (arm === "C") {
						outcome = await runBaseline(task, wd);
					} else {
						outcome = await executors[arm as "A" | "B"].run(task, snapshot);
					}
					const wallMs = Date.now() - started;
					let entry: ArmResult;
					if (arm === "C" && PAYLOAD_ANCHORED_TASK_IDS.has(task.id)) {
						entry = {
							arm,
							taskId: task.id,
							rep,
							passed: "n/a",
							detail: "payload capture unavailable",
							wallMs,
						};
					} else {
						const verdict = task.verify(outcome, context);
						entry = {
							arm,
							taskId: task.id,
							rep,
							passed: verdict.passed,
							detail: verdict.detail,
							stumbles: outcome.stumbles,
							payloadBytes:
								arm === "C"
									? undefined
									: outcome.providerPayloads.reduce((s, p) => s + p.length, 0),
							wallMs,
						};
					}
					results.push(entry);
					log(
						`${task.id} rep${rep} arm ${arm}: ${entry.passed === "n/a" ? "n/a" : entry.passed ? "PASS" : "FAIL"}` +
							`${entry.detail ? ` (${entry.detail})` : ""}  [${Math.round(wallMs / 1000)}s` +
							`${entry.payloadBytes !== undefined ? `, ${Math.round(entry.payloadBytes / 1024)}KB payload` : ""}]`,
					);
				}
			}
		}
	} finally {
		log("\n=== SUMMARY ===");
		for (const arm of args.arms) {
			const armResults = results.filter((r) => r.arm === arm);
			const gradeable = armResults.filter((r) => r.passed !== "n/a");
			const passed = gradeable.filter((r) => r.passed === true).length;
			const bytes = armResults.reduce((s, r) => s + (r.payloadBytes ?? 0), 0);
			const label = arm === "A" ? "current+data-plane" : arm === "B" ? "current traditional" : "status quo ante";
			log(
				`arm ${arm} (${label}): ${passed}/${gradeable.length} passed` +
					`${bytes > 0 ? `, total payload ${Math.round(bytes / 1024)}KB` : ""}`,
			);
		}
		await snapshot.cleanup();
		for (const d of scratchDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
	}
}

main().then(
	() => {
		// Arm A's in-process runtime leaves live handles (cell/store workers, bus
		// server) that would keep the event loop alive forever — exit hard.
		process.exit(0);
	},
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
