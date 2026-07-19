import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveCanaryHarness } from "../../src/learn/canary-live-harness.ts";
import {
	capturedContentNeverInPayloadCanary,
	codeModeCannotExecCanary,
	exampleCanaries,
	runCanarySuite,
} from "../../src/learn/canary-suite.ts";
import type {
	EvalTask,
	ExecOutcome,
	GenomeSnapshot,
	TaskExecutor,
} from "../../src/learn/eval-harness.ts";

const snapshot: GenomeSnapshot = {
	genomePath: "/tmp/does-not-matter",
	cleanup: async () => {},
};

/**
 * Deterministic executor standing in for the LiveTaskExecutor: it derives the
 * outcome from the task goal so the adapter's real wiring (input materialization
 * + outcome pass-through) is exercised, and lets us force a leak / an exec to
 * drive the canaries from real returned bytes.
 */
function fakeExecutor(behavior: { leakSecret?: string; didExec?: boolean }): TaskExecutor {
	return {
		async run(_task: EvalTask): Promise<ExecOutcome> {
			const payloads = behavior.leakSecret
				? [`the captured content is: ${behavior.leakSecret}`]
				: ["splice ⟦impl⟧ via $ref — only the marker crossed the wire"];
			return {
				output: "done",
				errored: false,
				stumbles: 0,
				providerPayloads: payloads,
				didExec: behavior.didExec ?? false,
				success: true,
			};
		},
	};
}

describe("createLiveCanaryHarness", () => {
	test("keystone passes when the secret never reaches a payload", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "sprout-canary-live-"));
		try {
			const harness = createLiveCanaryHarness({
				executor: fakeExecutor({}),
				snapshot,
				workDir,
			});
			const r = await capturedContentNeverInPayloadCanary.run(harness);
			expect(r.passed).toBe(true);
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});

	test("keystone fails from real returned bytes when a leaking candidate echoes the source", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "sprout-canary-live-"));
		try {
			// A faithful leaking-candidate simulation: the executor reads the source
			// the adapter materialized and echoes it into a payload — exactly what a
			// candidate that fails to route captured content through the store does.
			// The keystone canary picks its own random secret; the leak must surface
			// from the REAL materialized bytes, not a hard-coded string.
			const leakExecutor: TaskExecutor = {
				async run(): Promise<ExecOutcome> {
					const source = await readFile(join(workDir, "capture-source.txt"), "utf8");
					return {
						output: "done",
						errored: false,
						stumbles: 0,
						providerPayloads: [`here is the captured content: ${source}`],
						didExec: false,
						success: true,
					};
				},
			};
			const harness = createLiveCanaryHarness({ executor: leakExecutor, snapshot, workDir });
			const r = await capturedContentNeverInPayloadCanary.run(harness);
			expect(r.passed).toBe(false);
			expect(r.detail).toContain("provider payload");
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});

	test("code-mode-cannot-exec fails from a real didExec=true outcome", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "sprout-canary-live-"));
		try {
			const passHarness = createLiveCanaryHarness({
				executor: fakeExecutor({ didExec: false }),
				snapshot,
				workDir,
			});
			const failHarness = createLiveCanaryHarness({
				executor: fakeExecutor({ didExec: true }),
				snapshot,
				workDir,
			});
			expect((await codeModeCannotExecCanary.run(passHarness)).passed).toBe(true);
			expect((await codeModeCannotExecCanary.run(failHarness)).passed).toBe(false);
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});

	test("full example suite runs against the live adapter and reports per canary", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "sprout-canary-live-"));
		try {
			const harness = createLiveCanaryHarness({
				executor: fakeExecutor({}),
				snapshot,
				workDir,
			});
			const results = await runCanarySuite(exampleCanaries, harness);
			expect(results.map((r) => r.id)).toEqual([
				"captured-content-never-in-payload",
				"code-mode-cannot-exec",
			]);
			expect(results.every((r) => r.passed)).toBe(true);
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	});
});
