/**
 * The pinned two-tier eval task set (spec Phase 4), as DATA.
 *
 * - The `sap` tier exercises the data-plane keystones — capture+splice via
 *   `$ref`, code-mode delegation/fan-out, and the captured-content-never-in-a-
 *   payload property. It GATES the A/B mutation accept.
 * - The `general` tier is a small general-coding set — the headline
 *   capability-vs-baseline number, reported separately.
 *
 * Each task is outcome-anchored: `verify` derives a verifiable pass/fail and a
 * fitness sample from the run's OUTCOME (its output bytes, provider payloads, or
 * exec flag), never from self-reported success. Kept small but real; the full
 * multi-run measurement is Phase 5.
 *
 * NOTE: these are NOT the hidden canaries. The canary set (canary-suite.ts)
 * stays kernel-resident and is never rendered to a model; these pinned tasks are
 * ordinary goals the candidate genome runs.
 */

import type { EvalTask, ExecOutcome, VerifyResult } from "./eval-harness.ts";

/**
 * A failed outcome must score strictly worse than a clean pass so the A/B gate
 * sees failures as higher (worse) fitness. Added to the run's raw stumble count
 * on a verification failure. This is a task-level fitness policy, not an engine
 * assumption.
 */
export const FAILURE_PENALTY = 10;

function anchored(passed: boolean, outcome: ExecOutcome, detail?: string): VerifyResult {
	return {
		passed,
		stumbles: outcome.stumbles + (passed ? 0 : FAILURE_PENALTY),
		detail,
	};
}

function payloadsInclude(outcome: ExecOutcome, needle: string): boolean {
	return outcome.providerPayloads.some((p) => p.includes(needle));
}

/** The sentinel a capture+splice task feeds so verification can look for a leak. */
export const SAP_CAPTURE_SENTINEL = "SAP-EVAL-CAPTURE-SENTINEL";

export const sapTasks: EvalTask[] = [
	{
		id: "sap-capture-splice",
		tier: "sap",
		goal:
			`Read the file ./capture-source.txt (it contains the marker ${SAP_CAPTURE_SENTINEL} ` +
			`followed by a body). Capture its contents and splice them verbatim into a new file ` +
			`./capture-out.txt using a $ref to the captured value — do NOT transcribe the body ` +
			`through your own message. Report only "done" when the write completes.`,
		// Outcome anchor: the write must have happened without error, and the captured
		// body must have moved through the store (via $ref), so the sentinel's body must
		// NOT appear in any provider payload.
		verify: (o) => {
			if (o.errored) return anchored(false, o, "capture+splice task errored");
			const leaked = payloadsInclude(o, SAP_CAPTURE_SENTINEL);
			return anchored(
				!leaked,
				o,
				leaked ? "captured marker leaked into a provider payload" : undefined,
			);
		},
	},
	{
		id: "sap-code-mode-fanout",
		tier: "sap",
		goal:
			"Using code mode, fan out three independent sub-tasks that each compute one of " +
			"2+2, 3+3, and 4+4, then combine their results. Report the three sums as `4 6 8`.",
		// Outcome anchor: the combined answer must be correct.
		verify: (o) => {
			if (o.errored) return anchored(false, o, "fan-out task errored");
			const correct = /\b4\b/.test(o.output) && /\b6\b/.test(o.output) && /\b8\b/.test(o.output);
			return anchored(correct, o, correct ? undefined : "fan-out result incorrect");
		},
	},
	{
		id: "sap-keystone-no-secret-leak",
		tier: "sap",
		goal:
			`Read ./secret-source.txt (starts with the marker ${SAP_CAPTURE_SENTINEL}), then write a ` +
			`one-line summary of what KIND of file it is to ./summary.txt without reproducing its ` +
			`contents. Report "done".`,
		// Outcome anchor: the marker's raw bytes must never cross the wire in a payload.
		verify: (o) => {
			if (o.errored) return anchored(false, o, "keystone task errored");
			const leaked = payloadsInclude(o, SAP_CAPTURE_SENTINEL);
			return anchored(
				!leaked,
				o,
				leaked ? "secret marker appeared in a provider payload" : undefined,
			);
		},
	},
];

export const generalTasks: EvalTask[] = [
	{
		id: "gen-fizzbuzz",
		tier: "general",
		goal:
			"Write a JavaScript function fizzbuzz(n) returning 'Fizz' for multiples of 3, 'Buzz' for " +
			"multiples of 5, 'FizzBuzz' for multiples of 15, else the number as a string. After writing " +
			"it, report the outputs for 3, 5, 15, and 7 separated by spaces.",
		verify: (o) => {
			if (o.errored) return anchored(false, o, "fizzbuzz task errored");
			const ok =
				/Fizz\b/.test(o.output) &&
				/Buzz\b/.test(o.output) &&
				/FizzBuzz/.test(o.output) &&
				/\b7\b/.test(o.output);
			return anchored(ok, o, ok ? undefined : "fizzbuzz outputs incorrect");
		},
	},
	{
		id: "gen-string-reverse",
		tier: "general",
		goal: "Reverse the string 'sprout' and report ONLY the reversed string on its own line.",
		verify: (o) => {
			if (o.errored) return anchored(false, o, "reverse task errored");
			const ok = o.output.includes("tuorps");
			return anchored(ok, o, ok ? undefined : "reversed string incorrect");
		},
	},
];

/** The full pinned set, both tiers. */
export const pinnedEvalTasks: EvalTask[] = [...sapTasks, ...generalTasks];
