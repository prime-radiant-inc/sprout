/**
 * Per-session sub-call/token budget (Phase 7 security hardening): a hard
 * variance cap on runaway delegation loops, enforced host-side at the handle
 * registration boundary — every subprocess spawn must register its handle with
 * the host BEFORE launch (handle-registrar.ts), so a rejected admission stops
 * the spawn before any process exists. The counters live in the host process,
 * out of reach of model-authored code and genome mutations.
 *
 * The ceilings are variance caps, not quotas: real sessions run ~15-30
 * sub-calls; a runaway loop runs hundreds. Defaults are set an order of
 * magnitude above normal so no healthy session ever trips them.
 *
 * Coverage notes (honest limits):
 * - Featherweight spawns (in-process single-turn leaves) skip handle
 *   registration and are not counted as sub-calls; they cannot recurse and
 *   their token usage still counts via the session token feed.
 * - The token feed counts subprocess agents' llm_end usage (the session-wide
 *   events topic). The root agent's own turns are bounded by its max_turns.
 * - Like the handle registry, the budget spans the host process's lifetime;
 *   `/clear` does not reset it.
 */

/** Default sub-call ceiling per session (variance cap, not a quota). */
export const DEFAULT_SESSION_MAX_SUB_CALLS = 1000;

/** Default token ceiling per session (input + output across the session tree). */
export const DEFAULT_SESSION_MAX_TOKENS = 50_000_000;

export type BudgetAdmission = { ok: true } | { ok: false; reason: string };

export interface SessionBudgetLimits {
	maxSubCalls: number;
	maxTokens: number;
}

export class SessionBudget {
	readonly maxSubCalls: number;
	readonly maxTokens: number;
	private subCallCount = 0;
	private tokenCount = 0;

	constructor(limits: SessionBudgetLimits) {
		this.maxSubCalls = limits.maxSubCalls;
		this.maxTokens = limits.maxTokens;
	}

	/** Total sub-calls admitted so far. */
	get subCalls(): number {
		return this.subCallCount;
	}

	/** Total tokens recorded so far. */
	get tokens(): number {
		return this.tokenCount;
	}

	/**
	 * Admit one sub-call against both ceilings. On admission the sub-call
	 * counter increments; a rejection leaves the counters untouched and names
	 * the exceeded ceiling so the caller can surface a typed error.
	 */
	admitSubCall(): BudgetAdmission {
		if (this.subCallCount + 1 > this.maxSubCalls) {
			return {
				ok: false,
				reason:
					`session sub-call budget exceeded: ${this.subCallCount} sub-calls used, ` +
					`ceiling is ${this.maxSubCalls} (override with SPROUT_SESSION_MAX_SUB_CALLS)`,
			};
		}
		if (this.tokenCount > this.maxTokens) {
			return {
				ok: false,
				reason:
					`session token budget exceeded: ${this.tokenCount} tokens used, ` +
					`ceiling is ${this.maxTokens} (override with SPROUT_SESSION_MAX_TOKENS)`,
			};
		}
		this.subCallCount++;
		return { ok: true };
	}

	/** Add observed token usage (input + output). Non-finite/negative values are ignored. */
	recordTokens(count: number): void {
		if (!Number.isFinite(count) || count <= 0) return;
		this.tokenCount += count;
	}
}

function ceilingFromEnv(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	// 0 is a valid ceiling ("no sub-calls at all"); negatives and non-ints are not.
	if (!Number.isInteger(parsed) || parsed < 0) return fallback;
	return parsed;
}

/**
 * Build the session budget from the environment, following the house env-knob
 * pattern (cf. SPROUT_MUTATION_GATE): SPROUT_SESSION_MAX_SUB_CALLS and
 * SPROUT_SESSION_MAX_TOKENS override the defaults; invalid values fall back.
 */
export function sessionBudgetFromEnv(
	env: Record<string, string | undefined> = process.env,
): SessionBudget {
	return new SessionBudget({
		maxSubCalls: ceilingFromEnv(env.SPROUT_SESSION_MAX_SUB_CALLS, DEFAULT_SESSION_MAX_SUB_CALLS),
		maxTokens: ceilingFromEnv(env.SPROUT_SESSION_MAX_TOKENS, DEFAULT_SESSION_MAX_TOKENS),
	});
}
