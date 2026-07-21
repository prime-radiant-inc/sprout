import { describe, expect, test } from "bun:test";
import { prepareResultOutput } from "../../src/bus/result-gate.ts";
import type { StoreAccess } from "../../src/store/store-access.ts";

/** Bind+publish is all-or-nothing: a marker must never name a value the
 * reader cannot see (unpublished child-scope values are invisible). */
describe("prepareResultOutput", () => {
	function store(overrides: { bindError?: string; publishError?: string } = {}) {
		return {
			async bind(args: { name: string; content: string }) {
				if (overrides.bindError) throw new Error(overrides.bindError);
				return { ulid: "u1", name: args.name, size: args.content.length };
			},
			async publish() {
				if (overrides.publishError) throw new Error(overrides.publishError);
			},
		} as unknown as StoreAccess;
	}

	const long = `judgment\n${"x".repeat(10_000)}`;

	test("publish failure produces the fallback, never a marker", async () => {
		const out = await prepareResultOutput(store({ publishError: "grant refused" }), "h1", "do the thing", long, {
			publish: true,
		});
		expect(out).toBe(long);
		expect(out).not.toContain("⟦");
	});

	test("publish:false skips publish entirely (featherweight flavor)", async () => {
		const out = await prepareResultOutput(store({ publishError: "would throw" }), "h1", "do the thing", long, {
			publish: false,
		});
		expect(out).toMatch(/full content: ⟦do_the_thing_result⟧/);
	});

	test("no store → redacted passthrough", async () => {
		const out = await prepareResultOutput(undefined, "h1", "goal", "token: hunter2secretvalue result", {
			publish: true,
		});
		expect(out).toContain("[REDACTED_SECRET]");
		expect(out).not.toContain("hunter2secretvalue");
	});
});
