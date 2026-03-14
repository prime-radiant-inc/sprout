import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionEvent } from "../../kernel/types.ts";
import type { PricingSnapshot } from "../pricing-cache.ts";
import { mapSessionEventToAtifStep } from "./event-mapper.ts";
import type { AtifFinalMetrics, AtifMetrics, AtifTrajectory } from "./types.ts";

export interface CreateAtifRecorderOptions {
	outputPath: string;
	sessionId: string;
	agentName: string;
	agentVersion: string;
	modelName?: string;
	pricingSnapshot?: PricingSnapshot | null;
}

export class AtifRecorder {
	private readonly outputPath: string;
	private readonly pricingSnapshot: PricingSnapshot | null;
	private readonly trajectory: AtifTrajectory;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(options: CreateAtifRecorderOptions) {
		this.outputPath = options.outputPath;
		this.pricingSnapshot = options.pricingSnapshot ?? null;
		this.trajectory = {
			schema_version: "ATIF-v1.6",
			session_id: options.sessionId,
			agent: {
				name: options.agentName,
				version: options.agentVersion,
				...(options.modelName ? { model_name: options.modelName } : {}),
			},
			steps: [],
			final_metrics: {
				total_steps: 0,
			},
			extra: this.pricingSnapshot
				? {
						pricing_snapshot: {
							source: this.pricingSnapshot.source,
							fetched_at: this.pricingSnapshot.fetchedAt,
							upstreams: [...this.pricingSnapshot.upstreams],
						},
					}
				: undefined,
		};
	}

	recordEvent(event: SessionEvent): void {
		const step = mapSessionEventToAtifStep({
			stepId: this.trajectory.steps.length + 1,
			event,
			pricingSnapshot: this.pricingSnapshot,
		});
		if (!step) return;
		this.trajectory.steps.push(step);
		this.updateFinalMetrics(step.metrics);
		this.enqueueWrite();
	}

	async flush(): Promise<void> {
		await this.writeChain;
	}

	async close(): Promise<void> {
		this.enqueueWrite();
		await this.flush();
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.outputPath), { recursive: true });
		this.enqueueWrite();
		await this.flush();
	}

	private updateFinalMetrics(stepMetrics: AtifMetrics | undefined): void {
		let finalMetrics = this.trajectory.final_metrics;
		if (!finalMetrics) {
			finalMetrics = {};
			this.trajectory.final_metrics = finalMetrics;
		}
		finalMetrics.total_steps = this.trajectory.steps.length;
		if (!stepMetrics) return;
		addMetric(finalMetrics, "total_prompt_tokens", stepMetrics.prompt_tokens);
		addMetric(finalMetrics, "total_completion_tokens", stepMetrics.completion_tokens);
		addMetric(finalMetrics, "total_cached_tokens", stepMetrics.cached_tokens);
		addMetric(finalMetrics, "total_cost_usd", stepMetrics.cost_usd);
	}

	private enqueueWrite(): void {
		this.writeChain = this.writeChain.then(async () => {
			await writeFile(this.outputPath, JSON.stringify(this.trajectory, null, 2));
		});
	}
}

export async function createAtifRecorder(
	options: CreateAtifRecorderOptions,
): Promise<AtifRecorder> {
	const recorder = new AtifRecorder(options);
	await recorder.initialize();
	return recorder;
}

function addMetric(
	finalMetrics: AtifFinalMetrics,
	key: "total_prompt_tokens" | "total_completion_tokens" | "total_cached_tokens" | "total_cost_usd",
	value: number | undefined,
): void {
	if (value === undefined) return;
	finalMetrics[key] = (finalMetrics[key] ?? 0) + value;
}
