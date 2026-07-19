import { describe, expect, test } from "bun:test";
import {
	type Canary,
	type CanaryHarness,
	type CanaryResult,
	type CanaryRunOutcome,
	type CanaryTask,
	canariesPassed,
	capturedContentNeverInPayloadCanary,
	codeModeCannotExecCanary,
	exampleCanaries,
	mutationRegressesCanaries,
	runCanarySuite,
} from "../../src/learn/canary-suite.ts";

/** Stub harness whose behavior is driven by a per-task responder. */
function stubHarness(responder: (task: CanaryTask) => CanaryRunOutcome): CanaryHarness {
	return {
		async run(task) {
			return responder(task);
		},
	};
}

const okOutcome: CanaryRunOutcome = { output: "done", errored: false, providerPayloads: [] };

describe("runCanarySuite", () => {
	test("runs each canary and collects results in order", async () => {
		const canaries: Canary[] = [
			{
				id: "a",
				description: "",
				async run() {
					return { passed: true };
				},
			},
			{
				id: "b",
				description: "",
				async run() {
					return { passed: false, detail: "nope" };
				},
			},
		];
		const results = await runCanarySuite(
			canaries,
			stubHarness(() => okOutcome),
		);
		expect(results).toEqual([
			{ id: "a", passed: true, detail: undefined },
			{ id: "b", passed: false, detail: "nope" },
		]);
	});
});

describe("canariesPassed", () => {
	test("true only when all pass", () => {
		expect(canariesPassed([{ id: "a", passed: true }])).toBe(true);
		expect(
			canariesPassed([
				{ id: "a", passed: true },
				{ id: "b", passed: false },
			]),
		).toBe(false);
		expect(canariesPassed([])).toBe(true);
	});
});

describe("mutationRegressesCanaries", () => {
	const before: CanaryResult[] = [
		{ id: "pass-then-fail", passed: true },
		{ id: "already-failing", passed: false },
		{ id: "stays-passing", passed: true },
	];

	test("detects a pass -> fail regression", () => {
		const after: CanaryResult[] = [
			{ id: "pass-then-fail", passed: false },
			{ id: "already-failing", passed: false },
			{ id: "stays-passing", passed: true },
		];
		expect(mutationRegressesCanaries(before, after)).toBe(true);
	});

	test("ignores fail -> fail and improvements", () => {
		const after: CanaryResult[] = [
			{ id: "pass-then-fail", passed: true },
			{ id: "already-failing", passed: true },
			{ id: "stays-passing", passed: true },
		];
		expect(mutationRegressesCanaries(before, after)).toBe(false);
	});
});

describe("example canaries", () => {
	test("captured-content canary passes when the secret never hits a payload", async () => {
		const harness = stubHarness((task) => {
			const secret = String(task.inputs?.secret ?? "");
			// A well-behaved candidate references the value only via $ref — the
			// bytes go through the store, so payloads carry the marker, not the secret.
			return {
				output: "wrote file",
				errored: false,
				providerPayloads: [`splice ⟦impl⟧ for ${secret.slice(0, 0)}`],
			};
		});
		const r = await capturedContentNeverInPayloadCanary.run(harness);
		expect(r.passed).toBe(true);
	});

	test("captured-content canary fails when the secret leaks into a payload", async () => {
		const harness = stubHarness((task) => {
			const secret = String(task.inputs?.secret ?? "");
			return {
				output: "wrote file",
				errored: false,
				providerPayloads: [`here is the content: ${secret}`],
			};
		});
		const r = await capturedContentNeverInPayloadCanary.run(harness);
		expect(r.passed).toBe(false);
		expect(r.detail).toContain("provider payload");
	});

	test("code-mode-cannot-exec canary fails when the run executed shell", async () => {
		const passHarness = stubHarness(() => ({ ...okOutcome, didExec: false }));
		const failHarness = stubHarness(() => ({ ...okOutcome, didExec: true }));
		expect((await codeModeCannotExecCanary.run(passHarness)).passed).toBe(true);
		expect((await codeModeCannotExecCanary.run(failHarness)).passed).toBe(false);
	});

	test("example canaries run against a stub harness", async () => {
		const harness = stubHarness(() => okOutcome);
		const results = await runCanarySuite(exampleCanaries, harness);
		expect(results.map((r) => r.id)).toEqual([
			"captured-content-never-in-payload",
			"code-mode-cannot-exec",
		]);
	});
});
