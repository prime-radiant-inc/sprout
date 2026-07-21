import { describe, expect, test } from "bun:test";
import { Agent } from "../../src/agents/agent.ts";

/**
 * The delegation-render helper (capture-all spec v10): ONE parent-side seam
 * that redacts every child-result render and implements the recovery clamp —
 * clamp iff recovered AND the manifest delta delivered the result value
 * (content-identity match on size) AND over the delegate budget. Live results
 * can never reach the clamp (the recovered flag is structural).
 */

const emptyManifest = { lines: "", rewrites: new Map<string, string>(), values: [] };

function manifestWith(output: string, name = "crunch_result") {
	return {
		lines: `\npublished: ⟦${name}⟧ (text · ${Buffer.byteLength(output, "utf8")} bytes)`,
		rewrites: new Map<string, string>(),
		values: [
			{ name, ulid: "u1", size: Buffer.byteLength(output, "utf8"), preview: "text · preview" },
		],
	};
}

describe("Agent.renderDelegationResult", () => {
	test("live results are redacted and truncated at today's limits — never clamped", () => {
		const output = `token: hunter2secretvalue\n${"x".repeat(10_000)}`;
		const rendered = Agent.renderDelegationResult(output, "wait_agent", emptyManifest, false);
		expect(rendered).toContain("[REDACTED_SECRET]");
		expect(rendered).not.toContain("hunter2secretvalue");
		// Under the generic 30K fallback this renders whole — no clamp, no marker.
		expect(rendered).toContain("x".repeat(100));
		expect(rendered).not.toContain("⟦");
	});

	test("a recovered over-budget result whose delta delivered the result value clamps to the delegate budget with a form-1 marker", () => {
		const output = `judgment first\n${"y".repeat(20_000)}`;
		const manifest = manifestWith(output);
		const rendered = Agent.renderDelegationResult(output, "wait_agent", manifest, true);
		const body = rendered.slice(0, rendered.indexOf("\npublished:"));
		expect(body.length).toBeLessThanOrEqual(4_000);
		expect(rendered.startsWith("judgment first")).toBe(true);
		expect(rendered).toMatch(/\[\.\.\. \d+ chars truncated — full content: ⟦crunch_result⟧\]/);
		expect(rendered).toContain("published: ⟦crunch_result⟧");
	});

	test("a recovered result with NO matching delivered value takes the 30K backstop — fail closed", () => {
		const output = `judgment first\n${"z".repeat(20_000)}`;
		// Delta delivered a DIFFERENT value (stale prior-goal result: wrong size).
		const manifest = manifestWith("some other content entirely");
		const rendered = Agent.renderDelegationResult(output, "wait_agent", manifest, true);
		expect(rendered).toContain("z".repeat(100));
		expect(rendered).not.toContain("chars truncated — full content");
	});

	test("a recovered result under the budget renders inline", () => {
		const output = "short recovered answer";
		const rendered = Agent.renderDelegationResult(output, "wait_agent", manifestWith(output), true);
		expect(rendered.startsWith("short recovered answer")).toBe(true);
		expect(rendered).not.toContain("chars truncated");
	});

	test("manifest name rewrites apply in both branches", () => {
		const rewrites = new Map([["old_name", "new_name"]]);
		const live = Agent.renderDelegationResult(
			"see ⟦old_name⟧ for details",
			"wait_agent",
			{ ...emptyManifest, rewrites },
			false,
		);
		expect(live).toContain("⟦new_name⟧");
		const output = `see ⟦old_name⟧\n${"w".repeat(20_000)}`;
		const manifest = { ...manifestWith(output), rewrites };
		const clamped = Agent.renderDelegationResult(output, "wait_agent", manifest, true);
		expect(clamped).toContain("⟦new_name⟧");
	});
});
