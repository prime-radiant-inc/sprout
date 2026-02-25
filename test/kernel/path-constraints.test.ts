import { describe, expect, test } from "bun:test";
import { checkPathConstraint } from "../../src/kernel/path-constraints.js";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.js";
import type { AgentConstraints } from "../../src/kernel/types.js";

function constraints(overrides: Partial<AgentConstraints> = {}): AgentConstraints {
	return { ...DEFAULT_CONSTRAINTS, ...overrides };
}

describe("checkPathConstraint", () => {
	describe("when no path constraints are set", () => {
		test("allows all reads", () => {
			const result = checkPathConstraint("read_file", { path: "/etc/passwd" }, constraints());
			expect(result).toBeNull();
		});

		test("allows all writes", () => {
			const result = checkPathConstraint("write_file", { path: "/tmp/anything" }, constraints());
			expect(result).toBeNull();
		});
	});

	describe("allowed_read_paths", () => {
		const c = constraints({
			allowed_read_paths: ["bootstrap/**", "src/**/*.ts"],
		});

		test("allows reads matching a pattern", () => {
			expect(checkPathConstraint("read_file", { path: "bootstrap/root.yaml" }, c)).toBeNull();
			expect(checkPathConstraint("read_file", { path: "src/kernel/types.ts" }, c)).toBeNull();
		});

		test("denies reads not matching any pattern", () => {
			const result = checkPathConstraint("read_file", { path: "/etc/passwd" }, c);
			expect(result).toContain("not in allowed_read_paths");
		});

		test("applies to grep", () => {
			expect(checkPathConstraint("grep", { path: "bootstrap/root.yaml", pattern: "name" }, c)).toBeNull();
			const result = checkPathConstraint("grep", { path: "/etc/shadow", pattern: "root" }, c);
			expect(result).toContain("not in allowed_read_paths");
		});

		test("applies to glob", () => {
			expect(checkPathConstraint("glob", { path: "bootstrap/agents" }, c)).toBeNull();
			const result = checkPathConstraint("glob", { path: "/var/log" }, c);
			expect(result).toContain("not in allowed_read_paths");
		});

		test("does not restrict writes", () => {
			expect(checkPathConstraint("write_file", { path: "/tmp/anywhere" }, c)).toBeNull();
		});
	});

	describe("allowed_write_paths", () => {
		const c = constraints({
			allowed_write_paths: ["~/.local/share/sprout-genome/capability-index.yaml"],
		});

		test("allows writes matching the exact path", () => {
			const result = checkPathConstraint(
				"write_file",
				{ path: "~/.local/share/sprout-genome/capability-index.yaml" },
				c,
			);
			expect(result).toBeNull();
		});

		test("denies writes to other paths", () => {
			const result = checkPathConstraint("write_file", { path: "/tmp/evil.txt" }, c);
			expect(result).toContain("not in allowed_write_paths");
		});

		test("applies to edit_file", () => {
			const result = checkPathConstraint("edit_file", { path: "/tmp/evil.txt" }, c);
			expect(result).toContain("not in allowed_write_paths");
		});

		test("does not restrict reads", () => {
			expect(checkPathConstraint("read_file", { path: "/any/path" }, c)).toBeNull();
		});
	});

	describe("both read and write constraints", () => {
		const c = constraints({
			allowed_read_paths: ["bootstrap/**", "src/**"],
			allowed_write_paths: ["~/.local/share/sprout-genome/capability-index.yaml"],
		});

		test("enforces read constraints on reads", () => {
			expect(checkPathConstraint("read_file", { path: "bootstrap/root.yaml" }, c)).toBeNull();
			expect(checkPathConstraint("read_file", { path: "/etc/passwd" }, c)).not.toBeNull();
		});

		test("enforces write constraints on writes", () => {
			expect(
				checkPathConstraint(
					"write_file",
					{ path: "~/.local/share/sprout-genome/capability-index.yaml" },
					c,
				),
			).toBeNull();
			expect(checkPathConstraint("write_file", { path: "src/kernel/types.ts" }, c)).not.toBeNull();
		});
	});

	describe("primitives without path arguments", () => {
		test("exec is never restricted by path constraints", () => {
			const c = constraints({
				allowed_read_paths: ["nothing/**"],
				allowed_write_paths: ["nothing/**"],
			});
			expect(checkPathConstraint("exec", { command: "rm -rf /" }, c)).toBeNull();
		});

		test("missing path arg is allowed", () => {
			const c = constraints({ allowed_read_paths: ["src/**"] });
			expect(checkPathConstraint("read_file", {}, c)).toBeNull();
		});
	});

	describe("glob pattern matching", () => {
		test("** matches nested paths", () => {
			const c = constraints({ allowed_read_paths: ["src/**"] });
			expect(checkPathConstraint("read_file", { path: "src/kernel/types.ts" }, c)).toBeNull();
			expect(checkPathConstraint("read_file", { path: "src/a/b/c/d.ts" }, c)).toBeNull();
		});

		test("* matches single path segment", () => {
			const c = constraints({ allowed_read_paths: ["bootstrap/*.yaml"] });
			expect(checkPathConstraint("read_file", { path: "bootstrap/root.yaml" }, c)).toBeNull();
			expect(checkPathConstraint("read_file", { path: "bootstrap/sub/root.yaml" }, c)).not.toBeNull();
		});

		test("matches dotfiles", () => {
			const c = constraints({ allowed_write_paths: ["~/.local/**"] });
			expect(
				checkPathConstraint("write_file", { path: "~/.local/share/something" }, c),
			).toBeNull();
		});
	});
});
