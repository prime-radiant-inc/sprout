import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SESSION_MAX_SUB_CALLS,
	DEFAULT_SESSION_MAX_TOKENS,
	SessionBudget,
	sessionBudgetFromEnv,
} from "../../src/host/session-budget.ts";

describe("SessionBudget", () => {
	test("admits sub-calls under both ceilings", () => {
		const budget = new SessionBudget({ maxSubCalls: 3, maxTokens: 1000 });
		expect(budget.admitSubCall()).toEqual({ ok: true });
		expect(budget.admitSubCall()).toEqual({ ok: true });
		expect(budget.admitSubCall()).toEqual({ ok: true });
		expect(budget.subCalls).toBe(3);
	});

	test("rejects the sub-call that would exceed the sub-call ceiling", () => {
		const budget = new SessionBudget({ maxSubCalls: 2, maxTokens: 1000 });
		expect(budget.admitSubCall().ok).toBe(true);
		expect(budget.admitSubCall().ok).toBe(true);
		const third = budget.admitSubCall();
		expect(third.ok).toBe(false);
		if (!third.ok) {
			expect(third.reason).toContain("sub-call");
			expect(third.reason).toContain("2");
		}
		// A rejected admission does not increment the counter.
		expect(budget.subCalls).toBe(2);
	});

	test("rejects new sub-calls once the token ceiling is exceeded", () => {
		const budget = new SessionBudget({ maxSubCalls: 100, maxTokens: 500 });
		budget.recordTokens(499);
		expect(budget.admitSubCall().ok).toBe(true);
		budget.recordTokens(2);
		const rejected = budget.admitSubCall();
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) {
			expect(rejected.reason).toContain("token");
			expect(rejected.reason).toContain("500");
		}
		expect(budget.tokens).toBe(501);
	});

	test("ignores non-finite and negative token records", () => {
		const budget = new SessionBudget({ maxSubCalls: 10, maxTokens: 100 });
		budget.recordTokens(Number.NaN);
		budget.recordTokens(-50);
		expect(budget.tokens).toBe(0);
		expect(budget.admitSubCall().ok).toBe(true);
	});

	describe("sessionBudgetFromEnv", () => {
		test("uses generous defaults when env is empty", () => {
			const budget = sessionBudgetFromEnv({});
			expect(budget.maxSubCalls).toBe(DEFAULT_SESSION_MAX_SUB_CALLS);
			expect(budget.maxTokens).toBe(DEFAULT_SESSION_MAX_TOKENS);
		});

		test("honors SPROUT_SESSION_MAX_SUB_CALLS and SPROUT_SESSION_MAX_TOKENS", () => {
			const budget = sessionBudgetFromEnv({
				SPROUT_SESSION_MAX_SUB_CALLS: "7",
				SPROUT_SESSION_MAX_TOKENS: "1234",
			});
			expect(budget.maxSubCalls).toBe(7);
			expect(budget.maxTokens).toBe(1234);
		});

		test("falls back to defaults on invalid env values", () => {
			const budget = sessionBudgetFromEnv({
				SPROUT_SESSION_MAX_SUB_CALLS: "zero",
				SPROUT_SESSION_MAX_TOKENS: "-5",
			});
			expect(budget.maxSubCalls).toBe(DEFAULT_SESSION_MAX_SUB_CALLS);
			expect(budget.maxTokens).toBe(DEFAULT_SESSION_MAX_TOKENS);
		});
	});
});
