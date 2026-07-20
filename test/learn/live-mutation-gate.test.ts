import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome, git } from "../../src/genome/genome.ts";
import type { Program } from "../../src/genome/program.ts";
import type { CanaryHarness } from "../../src/learn/canary-suite.ts";
import { exampleCanaries } from "../../src/learn/canary-suite.ts";
import type {
	EvalTask,
	ExecOutcome,
	GenomeSnapshot,
	TaskExecutor,
} from "../../src/learn/eval-harness.ts";
import type { LearnMutation } from "../../src/learn/learn-process.ts";
import { createSnapshotMutationGate } from "../../src/learn/live-mutation-gate.ts";

const ROOT_DIR = join(import.meta.dir, "../../root");

const PROGRAM_NAME = "gate_test_prog";
const program: Program = {
	name: PROGRAM_NAME,
	description: "test program for gate snapshot application",
	params: [],
	spawns: [],
	version: 1,
	body: 'return bind("out", "hi");',
};
const createProgramMutation: LearnMutation = { type: "create_program", program };

const gateTasks: EvalTask[] = [
	{
		id: "sap-1",
		tier: "sap",
		goal: "g1",
		verify: (o) => ({ passed: !o.errored, stumbles: o.stumbles }),
	},
	{
		id: "sap-2",
		tier: "sap",
		goal: "g2",
		verify: (o) => ({ passed: !o.errored, stumbles: o.stumbles }),
	},
];

function programFileIn(genomePath: string): string {
	return join(genomePath, "programs", `${PROGRAM_NAME}.md`);
}

/** Records every arm the gate builds, so tests can assert on snapshot contents. */
interface BuiltArm {
	snapshotPath: string;
	workDir: string;
	/** Whether the mutated program file existed in the snapshot when built. */
	hasProgram: boolean;
}

interface HarnessBehavior {
	/** When true, the harness for a mutated (candidate) snapshot leaks the canary secret. */
	candidateLeaks: boolean;
}

function makeBuilders(opts: { candidateStumbles: number; harness: HarnessBehavior }) {
	const built: BuiltArm[] = [];
	const buildExecutor = (snapshotPath: string, workDir: string): TaskExecutor => {
		const hasProgram = existsSync(programFileIn(snapshotPath));
		built.push({ snapshotPath, workDir, hasProgram });
		const stumbles = hasProgram ? opts.candidateStumbles : 3;
		return {
			async run(): Promise<ExecOutcome> {
				return {
					output: "",
					errored: false,
					stumbles,
					providerPayloads: ["clean"],
					didExec: false,
					success: true,
				};
			},
		};
	};
	const buildCanaryHarness = (
		_executor: TaskExecutor,
		snapshot: GenomeSnapshot,
		_workDir: string,
	): CanaryHarness => {
		const isCandidate = existsSync(programFileIn(snapshot.genomePath));
		return {
			async run(task) {
				const secret = typeof task.inputs?.secret === "string" ? task.inputs.secret : "";
				const leaks = isCandidate && opts.harness.candidateLeaks;
				return {
					output: "ok",
					errored: false,
					providerPayloads: leaks ? [`payload with ${secret}`] : ["clean"],
					didExec: false,
				};
			},
		};
	};
	return { built, buildExecutor, buildCanaryHarness };
}

describe("createSnapshotMutationGate", () => {
	let tempDir: string;
	let templateDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-live-gate-"));
		templateDir = join(tempDir, "__template");
		const template = new Genome(templateDir, ROOT_DIR);
		await template.init();
		await template.initFromRoot();
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function freshLiveGenome(name: string): Promise<string> {
		const dir = join(tempDir, name);
		await cp(templateDir, dir, { recursive: true });
		return dir;
	}

	test("applies the mutation to the candidate snapshot only, never the live genome", async () => {
		const liveGenomePath = await freshLiveGenome("live-apply");
		const headBefore = await git(liveGenomePath, "rev-parse", "HEAD");
		const { built, buildExecutor, buildCanaryHarness } = makeBuilders({
			candidateStumbles: 0,
			harness: { candidateLeaks: false },
		});
		const gate = createSnapshotMutationGate({
			liveGenomePath,
			buildExecutor,
			buildCanaryHarness,
			tasks: gateTasks,
			canaries: exampleCanaries,
			runs: 6,
		});

		const decision = await gate.evaluate(createProgramMutation);

		expect(decision.adopt).toBe(true);
		// Two arms were built: exactly one (the candidate) carries the program.
		expect(built.length).toBe(2);
		expect(built.filter((a) => a.hasProgram).length).toBe(1);
		expect(built.filter((a) => !a.hasProgram).length).toBe(1);
		// The live genome is untouched: no program file, no new commit.
		expect(existsSync(programFileIn(liveGenomePath))).toBe(false);
		expect(await git(liveGenomePath, "rev-parse", "HEAD")).toBe(headBefore);
	});

	test("adopts when the candidate arm significantly improves and canaries stay clean", async () => {
		const liveGenomePath = await freshLiveGenome("live-adopt");
		const { buildExecutor, buildCanaryHarness } = makeBuilders({
			candidateStumbles: 0,
			harness: { candidateLeaks: false },
		});
		const gate = createSnapshotMutationGate({
			liveGenomePath,
			buildExecutor,
			buildCanaryHarness,
			tasks: gateTasks,
			canaries: exampleCanaries,
			runs: 6,
		});

		const decision = await gate.evaluate(createProgramMutation);
		expect(decision).toEqual({ adopt: true, reason: "adopted" });
		expect(existsSync(programFileIn(liveGenomePath))).toBe(false);
	});

	test("rejects when the candidate regresses a canary, live genome untouched", async () => {
		const liveGenomePath = await freshLiveGenome("live-reject");
		const headBefore = await git(liveGenomePath, "rev-parse", "HEAD");
		const { buildExecutor, buildCanaryHarness } = makeBuilders({
			candidateStumbles: 0,
			harness: { candidateLeaks: true },
		});
		const gate = createSnapshotMutationGate({
			liveGenomePath,
			buildExecutor,
			buildCanaryHarness,
			tasks: gateTasks,
			canaries: exampleCanaries,
			runs: 6,
		});

		const decision = await gate.evaluate(createProgramMutation);
		expect(decision).toEqual({ adopt: false, reason: "canary-regression" });
		expect(existsSync(programFileIn(liveGenomePath))).toBe(false);
		expect(await git(liveGenomePath, "rev-parse", "HEAD")).toBe(headBefore);
	});

	test("cleans up both snapshots and work dirs even when the mutation is rejected", async () => {
		const liveGenomePath = await freshLiveGenome("live-cleanup");
		const { built, buildExecutor, buildCanaryHarness } = makeBuilders({
			candidateStumbles: 0,
			harness: { candidateLeaks: true },
		});
		const gate = createSnapshotMutationGate({
			liveGenomePath,
			buildExecutor,
			buildCanaryHarness,
			tasks: gateTasks,
			canaries: exampleCanaries,
			runs: 6,
		});

		const decision = await gate.evaluate(createProgramMutation);
		expect(decision.adopt).toBe(false);
		expect(built.length).toBe(2);
		for (const armBuilt of built) {
			expect(existsSync(armBuilt.snapshotPath)).toBe(false);
			expect(existsSync(armBuilt.workDir)).toBe(false);
		}
	});

	test("cleans up snapshots and work dirs when evaluation throws", async () => {
		const liveGenomePath = await freshLiveGenome("live-throw");
		const built: BuiltArm[] = [];
		const gate = createSnapshotMutationGate({
			liveGenomePath,
			buildExecutor: (snapshotPath, workDir) => {
				built.push({
					snapshotPath,
					workDir,
					hasProgram: existsSync(programFileIn(snapshotPath)),
				});
				return {
					async run(): Promise<ExecOutcome> {
						throw new Error("executor exploded");
					},
				};
			},
			buildCanaryHarness: () => ({
				async run() {
					return { output: "ok", errored: false, providerPayloads: ["clean"], didExec: false };
				},
			}),
			tasks: gateTasks,
			canaries: exampleCanaries,
			runs: 6,
		});

		await expect(gate.evaluate(createProgramMutation)).rejects.toThrow("executor exploded");
		for (const armBuilt of built) {
			expect(existsSync(armBuilt.snapshotPath)).toBe(false);
			expect(existsSync(armBuilt.workDir)).toBe(false);
		}
	});

	test("applies a retire_program mutation to the candidate snapshot", async () => {
		const liveGenomePath = await freshLiveGenome("live-retire");
		const liveGenome = new Genome(liveGenomePath);
		await liveGenome.loadFromDisk();
		await liveGenome.addProgram(program);
		expect(existsSync(programFileIn(liveGenomePath))).toBe(true);
		const headBefore = await git(liveGenomePath, "rev-parse", "HEAD");

		const built: BuiltArm[] = [];
		const gate = createSnapshotMutationGate({
			liveGenomePath,
			buildExecutor: (snapshotPath, workDir) => {
				const hasProgram = existsSync(programFileIn(snapshotPath));
				built.push({ snapshotPath, workDir, hasProgram });
				// Candidate (program retired) improves over baseline.
				const stumbles = hasProgram ? 3 : 0;
				return {
					async run(): Promise<ExecOutcome> {
						return {
							output: "",
							errored: false,
							stumbles,
							providerPayloads: ["clean"],
							didExec: false,
							success: true,
						};
					},
				};
			},
			buildCanaryHarness: () => ({
				async run() {
					return { output: "ok", errored: false, providerPayloads: ["clean"], didExec: false };
				},
			}),
			tasks: gateTasks,
			canaries: exampleCanaries,
			runs: 6,
		});

		const decision = await gate.evaluate({
			type: "retire_program",
			program_name: PROGRAM_NAME,
		});
		expect(decision.adopt).toBe(true);
		// Exactly one arm (the candidate) had the program removed.
		expect(built.filter((a) => !a.hasProgram).length).toBe(1);
		expect(built.filter((a) => a.hasProgram).length).toBe(1);
		// The live genome still has the program and no new commit.
		expect(existsSync(programFileIn(liveGenomePath))).toBe(true);
		expect(await git(liveGenomePath, "rev-parse", "HEAD")).toBe(headBefore);
	});
});
