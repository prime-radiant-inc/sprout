import type { SessionEvent } from "../kernel/types.ts";

/**
 * sap data-plane metrics (spec §10). A pure derivation from the session event
 * stream — no runtime coupling and no runtime consumer yet: computed after
 * the fact from recorded events, so the same function can score a live
 * session, a replay, or a pinned eval snapshot.
 *
 * Where the raw signal lives in the stream:
 * - usage tokens: `plan_end.usage` (input/output/cache), per LLM turn.
 * - value bytes crossing the store: `primitive_end.bound_values[].size`
 *   (capture writes — the bytes a delegated call moved through the store
 *   instead of the transcript).
 * - act-mode stumbles: `primitive_end` with `name === "cell"` is code mode;
 *   every other `primitive_end` plus delegation `act_end` is tool mode.
 * - fan-out timing: matched `act_start`/`act_end` pairs (by `child_id`).
 */

/** Stumble accounting for one act mode. */
export interface ModeStumbleStats {
	/** Actions attributed to this mode (cell calls, or tool calls + delegations). */
	actions: number;
	/** Actions that stumbled. */
	stumbles: number;
	/** stumbles / actions, or 0 when no actions. */
	rate: number;
}

/** Fan-out wall-clock: the whole fan-out versus its slowest single child. */
export interface FanOutStats {
	/** Number of matched child delegations. */
	childCount: number;
	/** Wall-clock span from the first act_start to the last act_end (ms). */
	totalWallClockMs: number;
	/** Duration of the slowest single child (ms). */
	slowestChildMs: number;
	/** Sum of every child's duration (ms) — the serial cost fan-out avoids. */
	sumChildMs: number;
}

/** Prompt-cache hit rate. Provider-dependent: cache_read_tokens is populated
 * only when the provider reports it; when absent these stay 0 and available
 * is false. */
export interface CacheStats {
	/** Whether any usage record carried cache detail. */
	available: boolean;
	cacheReadTokens: number;
	/** input_tokens + cache_read_tokens — the tokens a cache could have served. */
	cacheableInputTokens: number;
	/** cacheReadTokens / cacheableInputTokens, or 0 when none. */
	hitRate: number;
}

export interface SapMetrics {
	totalInputTokens: number;
	totalOutputTokens: number;
	/** Total bytes that crossed via the store (capture writes). */
	delegatedBytesMoved: number;
	/**
	 * (input + output tokens) / delegatedBytesMoved. The core §10 efficiency
	 * number: how many model tokens each moved byte cost. 0 when no bytes moved.
	 */
	tokensPerDelegatedByte: number;
	stumbleByMode: {
		code: ModeStumbleStats;
		tools: ModeStumbleStats;
	};
	fanOut: FanOutStats;
	/** Sizes (bytes) of every value served via the store, ascending. */
	storeHitSizes: number[];
	promptCache: CacheStats;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function rate(stumbles: number, actions: number): number {
	return actions === 0 ? 0 : stumbles / actions;
}

interface BoundValue {
	size?: number;
}

function boundValues(event: SessionEvent): BoundValue[] {
	const raw = event.data.bound_values;
	return Array.isArray(raw) ? (raw as BoundValue[]) : [];
}

/** Derive the full §10 metric record from a recorded session event stream. */
export function aggregateSapMetrics(events: SessionEvent[]): SapMetrics {
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let delegatedBytesMoved = 0;
	const storeHitSizes: number[] = [];

	let cacheAvailable = false;
	let cacheReadTokens = 0;

	const code: ModeStumbleStats = { actions: 0, stumbles: 0, rate: 0 };
	const tools: ModeStumbleStats = { actions: 0, stumbles: 0, rate: 0 };

	// child_id -> act_start timestamp, for pairing fan-out durations.
	const openChildren = new Map<string, number>();
	const childDurations: number[] = [];
	let firstActStart = Number.POSITIVE_INFINITY;
	let lastActEnd = Number.NEGATIVE_INFINITY;

	for (const event of events) {
		switch (event.kind) {
			case "plan_end": {
				const usage = event.data.usage as Record<string, unknown> | undefined;
				if (usage) {
					totalInputTokens += num(usage.input_tokens);
					totalOutputTokens += num(usage.output_tokens);
					if ("cache_read_tokens" in usage) {
						cacheAvailable = true;
						cacheReadTokens += num(usage.cache_read_tokens);
					}
				}
				break;
			}
			case "primitive_end": {
				for (const bv of boundValues(event)) {
					const size = num(bv.size);
					delegatedBytesMoved += size;
					storeHitSizes.push(size);
				}
				const isCode = event.data.name === "cell";
				const stats = isCode ? code : tools;
				stats.actions += 1;
				if (event.data.stumbled === true) stats.stumbles += 1;
				break;
			}
			case "act_end": {
				// Delegation completion — a tool-mode action.
				tools.actions += 1;
				if (event.data.success === false) tools.stumbles += 1;
				const childId = event.data.child_id;
				if (typeof childId === "string") {
					const started = openChildren.get(childId);
					if (started !== undefined) {
						childDurations.push(event.timestamp - started);
						openChildren.delete(childId);
					}
					lastActEnd = Math.max(lastActEnd, event.timestamp);
				}
				break;
			}
			case "act_start": {
				const childId = event.data.child_id;
				if (typeof childId === "string") {
					openChildren.set(childId, event.timestamp);
					firstActStart = Math.min(firstActStart, event.timestamp);
				}
				break;
			}
		}
	}

	code.rate = rate(code.stumbles, code.actions);
	tools.rate = rate(tools.stumbles, tools.actions);
	storeHitSizes.sort((a, b) => a - b);

	const slowestChildMs = childDurations.length > 0 ? Math.max(...childDurations) : 0;
	const sumChildMs = childDurations.reduce((a, b) => a + b, 0);
	const totalWallClockMs =
		childDurations.length > 0 && lastActEnd >= firstActStart ? lastActEnd - firstActStart : 0;

	const totalTokens = totalInputTokens + totalOutputTokens;
	const cacheableInputTokens = totalInputTokens + cacheReadTokens;

	return {
		totalInputTokens,
		totalOutputTokens,
		delegatedBytesMoved,
		tokensPerDelegatedByte: delegatedBytesMoved === 0 ? 0 : totalTokens / delegatedBytesMoved,
		stumbleByMode: { code, tools },
		fanOut: {
			childCount: childDurations.length,
			totalWallClockMs,
			slowestChildMs,
			sumChildMs,
		},
		storeHitSizes,
		promptCache: {
			available: cacheAvailable,
			cacheReadTokens,
			cacheableInputTokens,
			hitRate: cacheableInputTokens === 0 ? 0 : cacheReadTokens / cacheableInputTokens,
		},
	};
}
