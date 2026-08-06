/**
 * The LIVE executor adapter (spec Phase 4) — the real-data path.
 *
 * Runs an `EvalTask` against a REAL model via `runHeadlessMode` /
 * `controller.runGoal`, capturing:
 *   - the run's stumble count + success (from the SessionRunResult), and
 *   - the RAW provider request payloads (the serialized bytes each LLM call
 *     would send), via a request observer on the runtime client that fires on
 *     BOTH the complete() and stream() dispatch paths, and
 *   - whether the run executed shell (`didExec`), from the event stream.
 *
 * The captured payloads and exec flag are exactly what the hidden canary suite
 * asserts on, so the same executor backs both the eval engine and the live
 * `CanaryHarness` adapter (canary-live-harness.ts).
 *
 * This module IS on the host import graph (it drives the real runtime). It is
 * NOT imported by the pure engine (`eval-harness.ts`) and never runs in the
 * offline suite — the live entrypoint (scripts/eval-sap.ts) drives it.
 */

import { bootstrapSessionRuntime } from "../host/cli-bootstrap.ts";
import { type HeadlessInfrastructure, runHeadlessMode } from "../host/cli-headless.ts";
import type { SessionLogger } from "../host/logger.ts";
import type { SessionEvent } from "../kernel/types.ts";
import { Client } from "../llm/client.ts";
import { loggingMiddleware } from "../llm/logging-middleware.ts";
import type { Request } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import type { EvalTask, ExecOutcome, GenomeSnapshot, TaskExecutor } from "./eval-harness.ts";

/** Serialize the bytes a request would send to a provider. */
function serializeRequestPayload(request: Request): string {
	return JSON.stringify({
		model: request.model,
		provider: request.provider,
		messages: request.messages,
		tools: request.tools,
	});
}

/**
 * Where an eval-mode run writes its session logs/tasks.json. NEVER the live
 * project data dir: the isolated work dir (falling back to the snapshot dir,
 * itself a throwaway copy of the genome) keeps every write off the caller's real
 * project data dir.
 */
export function resolveEvalDataDir(
	workDir: string | undefined,
	snapshotGenomePath: string,
): string {
	return workDir ?? snapshotGenomePath;
}

/** True when an event indicates a shell/exec primitive ran. */
function eventIsExec(event: SessionEvent): boolean {
	return (
		(event.kind === "primitive_start" || event.kind === "primitive_end") &&
		event.data.name === "exec"
	);
}

export interface LiveTaskExecutorConfig {
	rootDir: string;
	workDir?: string;
	startBusInfrastructure: (options: {
		genomePath: string;
		sessionId: string;
		rootDir?: string;
	}) => Promise<HeadlessInfrastructure>;
	/** Model tier/selection to force (e.g. the cheap `fast` tier for smoke runs). */
	selectionRequest?: SessionSelectionRequest;
	/** When false, run the pre-code-mode traditional agent (data plane OFF) — for
	 * A/B comparison of code-mode vs traditional tool-use. Defaults true. */
	dataPlaneEnabled?: boolean;
}

/**
 * Runs eval tasks against a real model. Each run executes in eval mode against
 * the provided genome snapshot so the live genome/journal is never mutated.
 */
export class LiveTaskExecutor implements TaskExecutor {
	constructor(private readonly config: LiveTaskExecutorConfig) {}

	async run(task: EvalTask, genomeSnapshot?: GenomeSnapshot): Promise<ExecOutcome> {
		if (!genomeSnapshot) {
			throw new Error("LiveTaskExecutor requires an isolated genome snapshot to run in eval mode");
		}
		const genomePath = genomeSnapshot.genomePath;

		const providerPayloads: string[] = [];
		let didExec = false;

		const result = await runHeadlessMode(
			{
				goal: task.goal,
				genomePath,
				// Eval mode must not write session logs/tasks.json into the LIVE
				// project data dir. Route them to the isolated work dir (falling back
				// to the snapshot dir, itself a throwaway copy) so nothing lands in the
				// caller's real project data dir.
				projectDataDir: resolveEvalDataDir(this.config.workDir, genomePath),
				rootDir: this.config.rootDir,
				workDir: this.config.workDir,
				evalMode: true,
				allowExec: task.allowExec,
				dataPlaneEnabled: this.config.dataPlaneEnabled,
				initialSelectionRequest: this.config.selectionRequest,
				startBusInfrastructure: this.config.startBusInfrastructure,
			},
			{
				bootstrapRuntime: async (options) => {
					const runtime = await bootstrapSessionRuntime(options, {
						createClient: async ({ logger, providers }) => {
							const client = Client.fromProviders(providers, {
								middleware: [loggingMiddleware(logger as SessionLogger)],
							});
							// Observe the request on EVERY dispatch — complete() AND stream().
							// The main agent loop streams, so capturing only complete() would
							// miss the turns where a spliced secret would ride.
							client.onRequest((request) => {
								providerPayloads.push(serializeRequestPayload(request));
							});
							return client;
						},
					});
					const bus = runtime.bus as {
						onEvent(listener: (event: SessionEvent) => void): () => void;
					};
					bus.onEvent((event) => {
						if (eventIsExec(event)) didExec = true;
					});
					return {
						bus: runtime.bus as { onEvent(listener: (event: SessionEvent) => void): () => void },
						controller: runtime.controller as {
							runGoal(goal: string): Promise<{
								sessionId: string;
								output: string;
								success: boolean;
								stumbles: number;
								turns: number;
								timedOut: boolean;
							}>;
						},
					};
				},
			},
		);

		return {
			output: result.output,
			errored: !result.success,
			stumbles: result.stumbles,
			providerPayloads,
			didExec,
			success: result.success,
		};
	}
}
