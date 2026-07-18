import { describe, expect, test } from "bun:test";
import {
	classifyRefArg,
	REF_SPLICE_ALLOWLIST,
	refAllowedFor,
	spliceRefArgs,
} from "../../src/kernel/ref-splice";

const SCOPE = new Set(["impl", "test_log", "notes"]);

/** Resolver over a fixed table; unknown names resolve to null. */
function makeResolver(table: Record<string, string>) {
	return async (name: string): Promise<string | null> => table[name] ?? null;
}

describe("REF_SPLICE_ALLOWLIST", () => {
	test("contains exactly write_file.content and edit_file.old/new", () => {
		expect([...REF_SPLICE_ALLOWLIST.keys()].sort()).toEqual(["edit_file", "write_file"]);
		expect([...(REF_SPLICE_ALLOWLIST.get("write_file") ?? [])]).toEqual(["content"]);
		expect([...(REF_SPLICE_ALLOWLIST.get("edit_file") ?? [])].sort()).toEqual([
			"new_string",
			"old_string",
		]);
	});

	test("refAllowedFor matches the allowlist", () => {
		expect(refAllowedFor("write_file", "content")).toBe(true);
		expect(refAllowedFor("write_file", "path")).toBe(false);
		expect(refAllowedFor("edit_file", "old_string")).toBe(true);
		expect(refAllowedFor("edit_file", "new_string")).toBe(true);
		expect(refAllowedFor("edit_file", "path")).toBe(false);
		expect(refAllowedFor("exec", "command")).toBe(false);
		expect(refAllowedFor("apply_patch", "patch")).toBe(false);
		expect(refAllowedFor("fetch", "url")).toBe(false);
	});
});

describe("classifyRefArg", () => {
	test("whole-arg ⟦name⟧ is a ref", () => {
		expect(classifyRefArg("⟦impl⟧", SCOPE)).toEqual({
			kind: "ref",
			name: "impl",
		});
	});

	test("surrounding whitespace trims before matching", () => {
		expect(classifyRefArg("⟦impl⟧\n", SCOPE)).toEqual({
			kind: "ref",
			name: "impl",
		});
		expect(classifyRefArg("  ⟦impl⟧  ", SCOPE)).toEqual({
			kind: "ref",
			name: "impl",
		});
	});

	test("unknown name is still a ref (resolution decides existence)", () => {
		expect(classifyRefArg("⟦nope⟧", SCOPE)).toEqual({
			kind: "ref",
			name: "nope",
		});
	});

	test("embedded ref is plain passthrough", () => {
		expect(classifyRefArg("prefix ⟦impl⟧", SCOPE)).toEqual({ kind: "plain" });
		expect(classifyRefArg("⟦impl⟧ suffix", SCOPE)).toEqual({ kind: "plain" });
	});

	test("ordinary content is plain", () => {
		expect(classifyRefArg("hello world", SCOPE)).toEqual({ kind: "plain" });
		expect(classifyRefArg("", SCOPE)).toEqual({ kind: "plain" });
	});

	test.each([
		["[[impl]]"],
		["〚impl〛"],
		["⟬impl⟭"],
		["«impl»"],
		["⦃impl⦄"],
		["⟨⟨impl⟩⟩"],
		["⟦impl"],
		["impl⟧"],
		["⟦⟦impl⟧⟧"],
	])("lookalike %s of an in-scope name is a near_miss", (form) => {
		const result = classifyRefArg(form, SCOPE);
		expect(result.kind).toBe("near_miss");
		if (result.kind === "near_miss") {
			expect(result.name).toBe("impl");
			expect(result.form).toBe(form.trim());
		}
	});

	test("lookalike of an out-of-scope name is plain (markdown links etc.)", () => {
		expect(classifyRefArg("[[link]]", SCOPE)).toEqual({ kind: "plain" });
		expect(classifyRefArg("«quoted»", SCOPE)).toEqual({ kind: "plain" });
		expect(classifyRefArg("⟦⟦link⟧⟧", SCOPE)).toEqual({ kind: "plain" });
	});

	test("bare in-scope name without brackets is plain", () => {
		expect(classifyRefArg("impl", SCOPE)).toEqual({ kind: "plain" });
	});

	test("real brackets with invalid name shape is a near_miss (attempted ref)", () => {
		expect(classifyRefArg("⟦1bad⟧", SCOPE).kind).toBe("near_miss");
		expect(classifyRefArg("⟦ impl ⟧", SCOPE).kind).toBe("near_miss");
		expect(classifyRefArg("⟦Impl⟧", SCOPE).kind).toBe("near_miss");
		expect(classifyRefArg("⟦two words⟧", SCOPE).kind).toBe("near_miss");
	});

	test("name at max length (64) is a ref; over-length is a near_miss", () => {
		const max = "a".repeat(64);
		expect(classifyRefArg(`⟦${max}⟧`, SCOPE)).toEqual({
			kind: "ref",
			name: max,
		});
		expect(classifyRefArg(`⟦${max}a⟧`, SCOPE).kind).toBe("near_miss");
	});

	test("empty brackets ⟦⟧ is a near_miss (attempted ref, invalid name)", () => {
		expect(classifyRefArg("⟦⟧", SCOPE).kind).toBe("near_miss");
	});

	test("empty scope set: lookalikes pass through, refs still classify", () => {
		const empty = new Set<string>();
		expect(classifyRefArg("[[impl]]", empty)).toEqual({ kind: "plain" });
		expect(classifyRefArg("⟦impl⟧", empty)).toEqual({
			kind: "ref",
			name: "impl",
		});
	});
});

describe("spliceRefArgs", () => {
	const resolve = makeResolver({
		impl: "export const x = 1;\n",
		test_log: "all tests passed",
		notes: "some notes",
	});

	test("splices a whole-arg ref in write_file.content", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "src/api.ts", content: "⟦impl⟧\n" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result).toEqual({
			ok: true,
			args: { path: "src/api.ts", content: "export const x = 1;\n" },
			splicedNames: ["impl"],
		});
	});

	test("returns a new args object and leaves the input untouched", async () => {
		const args = { path: "a.ts", content: "⟦impl⟧" };
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args,
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result.ok).toBe(true);
		expect(args.content).toBe("⟦impl⟧");
		if (result.ok) {
			expect(result.args).not.toBe(args);
		}
	});

	test("splices multiple args in one edit_file call", async () => {
		const result = await spliceRefArgs({
			primitiveName: "edit_file",
			args: { path: "a.ts", old_string: "⟦impl⟧", new_string: "⟦notes⟧" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result).toEqual({
			ok: true,
			args: {
				path: "a.ts",
				old_string: "export const x = 1;\n",
				new_string: "some notes",
			},
			splicedNames: ["impl", "notes"],
		});
	});

	test("embedded ref in an allowlisted arg passes through unchanged", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "a.ts", content: "see ⟦impl⟧ above" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result).toEqual({
			ok: true,
			args: { path: "a.ts", content: "see ⟦impl⟧ above" },
			splicedNames: [],
		});
	});

	test("plain content in allowlisted args passes through with no splices", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "a.ts", content: "plain content" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result).toEqual({
			ok: true,
			args: { path: "a.ts", content: "plain content" },
			splicedNames: [],
		});
	});

	test("unknown name errors loudly, listing in-scope names sorted", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "a.ts", content: "⟦missing⟧" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("missing");
			expect(result.error).toContain("impl, notes, test_log");
		}
	});

	test("unknown name with empty scope says so", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "a.ts", content: "⟦missing⟧" },
			inScopeNames: new Set(),
			resolve: makeResolver({}),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("missing");
		}
	});

	test("near-miss in an allowlisted arg errors, naming form and correct syntax", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "a.ts", content: "[[impl]]" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("[[impl]]");
			expect(result.error).toContain("⟦impl⟧");
			expect(result.error).toContain("impl, notes, test_log");
		}
	});

	test("invalid name shape in real brackets errors in allowlisted arg", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "a.ts", content: "⟦ impl ⟧" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("⟦impl⟧");
		}
	});

	test("whole-arg ref in a non-allowlisted arg errors loudly", async () => {
		for (const [primitiveName, args] of [
			["exec", { command: "⟦impl⟧" }],
			["write_file", { path: "⟦impl⟧", content: "x" }],
			["apply_patch", { patch: "⟦impl⟧" }],
			["fetch", { url: "⟦impl⟧" }],
		] as const) {
			const result = await spliceRefArgs({
				primitiveName,
				args,
				inScopeNames: SCOPE,
				resolve,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain(primitiveName);
				expect(result.error).toContain("write_file.content");
			}
		}
	});

	test("near-miss in a non-allowlisted arg passes through", async () => {
		const result = await spliceRefArgs({
			primitiveName: "exec",
			args: { command: "echo [[impl]]", cwd: "[[impl]]" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result).toEqual({
			ok: true,
			args: { command: "echo [[impl]]", cwd: "[[impl]]" },
			splicedNames: [],
		});
	});

	test("non-string args are copied untouched", async () => {
		const result = await spliceRefArgs({
			primitiveName: "write_file",
			args: { path: "a.ts", content: "⟦impl⟧", append: true, mode: 0o644 },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result).toEqual({
			ok: true,
			args: {
				path: "a.ts",
				content: "export const x = 1;\n",
				append: true,
				mode: 0o644,
			},
			splicedNames: ["impl"],
		});
	});

	test("primitive with no allowlist entry and plain args passes through", async () => {
		const result = await spliceRefArgs({
			primitiveName: "grep",
			args: { pattern: "foo", path: "src" },
			inScopeNames: SCOPE,
			resolve,
		});
		expect(result).toEqual({
			ok: true,
			args: { pattern: "foo", path: "src" },
			splicedNames: [],
		});
	});
});
