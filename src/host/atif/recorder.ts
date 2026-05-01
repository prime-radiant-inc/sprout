import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionEvent } from "../../kernel/types.ts";
import type { PricingSnapshot } from "../pricing-cache.ts";
import { mapSessionEventToAtifStep } from "./event-mapper.ts";
import type { AtifFinalMetrics, AtifTrajectory } from "./types.ts";

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
		this.updateFinalMetrics(step);
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

	private updateFinalMetrics(step: AtifTrajectory["steps"][number]): void {
		let finalMetrics = this.trajectory.final_metrics;
		if (!finalMetrics) {
			finalMetrics = {};
			this.trajectory.final_metrics = finalMetrics;
		}
		finalMetrics.total_steps = this.trajectory.steps.length;
		updateObservabilityMetrics(finalMetrics, step);
		const stepMetrics = step.metrics;
		if (!stepMetrics) return;
		addMetric(finalMetrics, "total_prompt_tokens", stepMetrics.prompt_tokens);
		addMetric(finalMetrics, "total_completion_tokens", stepMetrics.completion_tokens);
		addMetric(finalMetrics, "total_cached_tokens", stepMetrics.cached_tokens);
		addMetric(finalMetrics, "total_cache_write_tokens", stepMetrics.cache_write_tokens);
		addMetric(finalMetrics, "total_input_tokens", stepMetrics.total_input_tokens);
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
	key:
		| "total_prompt_tokens"
		| "total_completion_tokens"
		| "total_cached_tokens"
		| "total_cache_write_tokens"
		| "total_input_tokens"
		| "total_cost_usd",
	value: number | undefined,
): void {
	if (value === undefined) return;
	finalMetrics[key] = (finalMetrics[key] ?? 0) + value;
}

function updateObservabilityMetrics(
	finalMetrics: AtifFinalMetrics,
	step: AtifTrajectory["steps"][number],
): void {
	const memorySurface = recordExtra(step.extra?.memory_surface);
	if (memorySurface) {
		updateMemorySurfaceMetrics(finalMetrics, memorySurface);
	}

	const observer = recordExtra(step.extra?.observer);
	if (observer) {
		updateObserverActivityMetrics(finalMetrics, observer, step);
	}
}

function updateMemorySurfaceMetrics(
	finalMetrics: AtifFinalMetrics,
	memorySurface: Record<string, unknown>,
): void {
	const summary = ensureNestedRecord(finalMetrics, "memory_surface");
	ensureNumberDefaults(summary, [
		"recall_events",
		"cached_recall_events",
		"recall_events_with_memories",
		"surfaced_memory_count",
	]);
	increment(summary, "recall_events", 1);
	if (memorySurface.cached === true) {
		increment(summary, "cached_recall_events", 1);
	}

	const ids = stringArray(memorySurface.surfaced_memory_ids);
	const memoryCount =
		typeof memorySurface.memory_count === "number" ? memorySurface.memory_count : ids.length;
	if (memoryCount > 0 || ids.length > 0) {
		increment(summary, "recall_events_with_memories", 1);
	}
	increment(summary, "surfaced_memory_count", Math.max(memoryCount, ids.length));

	const uniqueIds = ensureStringList(summary, "unique_surfaced_memory_ids");
	for (const id of ids) {
		if (!uniqueIds.includes(id)) uniqueIds.push(id);
	}
}

function updateObserverActivityMetrics(
	finalMetrics: AtifFinalMetrics,
	observer: Record<string, unknown>,
	step: AtifTrajectory["steps"][number],
): void {
	const summary = ensureNestedRecord(finalMetrics, "observer_activity");
	ensureNumberDefaults(summary, [
		"observer_starts",
		"observer_completions",
		"observer_llm_calls",
		"observer_messages",
	]);
	if (observer.lifecycle === "start") {
		increment(summary, "observer_starts", 1);
	}
	if (observer.lifecycle === "end") {
		increment(summary, "observer_completions", 1);
	}
	if (step.extra?.sprout_event && isLlmEndObserverEvent(step.extra.sprout_event)) {
		increment(summary, "observer_llm_calls", 1);
	}
	if (step.extra?.sprout_event && isObserverAgentMessageEvent(step.extra.sprout_event)) {
		increment(summary, "observer_messages", 1);
	}

	const observers = ensureStringList(summary, "observers");
	addUnique(observers, observer.agent_id);
	addUnique(observers, observer.agent_name);
}

function ensureNestedRecord(
	finalMetrics: AtifFinalMetrics,
	key: "memory_surface" | "observer_activity",
): Record<string, unknown> {
	finalMetrics.extra ??= {};
	const existing = finalMetrics.extra[key];
	const existingRecord = recordExtra(existing);
	if (existingRecord) return existingRecord;
	const created: Record<string, unknown> = {};
	finalMetrics.extra[key] = created;
	return created;
}

function ensureStringList(record: Record<string, unknown>, key: string): string[] {
	const existing = record[key];
	if (Array.isArray(existing)) {
		const list = existing.filter((value): value is string => typeof value === "string");
		record[key] = list;
		return list;
	}
	const created: string[] = [];
	record[key] = created;
	return created;
}

function ensureNumberDefaults(record: Record<string, unknown>, keys: string[]): void {
	for (const key of keys) {
		if (typeof record[key] !== "number") {
			record[key] = 0;
		}
	}
}

function increment(record: Record<string, unknown>, key: string, amount: number): void {
	const current = typeof record[key] === "number" ? record[key] : 0;
	record[key] = current + amount;
}

function addUnique(list: string[], value: unknown): void {
	if (typeof value !== "string" || value.length === 0 || list.includes(value)) return;
	list.push(value);
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function recordExtra(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function isLlmEndObserverEvent(value: unknown): boolean {
	const event = recordExtra(value);
	return event?.kind === "llm_end";
}

function isObserverAgentMessageEvent(value: unknown): boolean {
	const event = recordExtra(value);
	return event?.kind === "agent_message";
}
