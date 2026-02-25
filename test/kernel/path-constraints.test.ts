import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	checkPathConstraint,
	resolvePath,
	validateConstraints,
} from "../../src/kernel/path-constraints.js";
import type { AgentConstraints } from "../../src/kernel/types.js";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.js";

function constraints(overrides: Partial<AgentConstraints> = {}): AgentConstraints {
	return { ...DEFAULT_CONSTRAINTS, ...overrides };
}

const workDir = "/Users/test/project";

describe("resolvePath", () => {
	test("returns absolute paths as-is", () => {
		expect(resolvePath("/etc/passwd", workDir)).toBe("/etc/passwd");
	});

	test("expands ~ to homedir", () => {
		expect(resolvePath("~/foo/bar", workDir)).toBe(join(homedir(), "foo/bar"));
	});

	test("expands bare ~ to homedir", () => {
		expect(resolvePath("~", workDir)).toBe(homedir());
	});

	test("resolves relative paths against workDir", () => {
		expect(resolvePath("src/foo.ts", workDir)).toBe(resolve(workDir, "src/foo.ts"));
	});
});

describe("checkPathConstraint", () => {
	describe("when no write constraints are set", () => {
		test("allows all writes", () => {
			const result = checkPathConstraint(
				"write_file",
				{ path: "/any/path" },
				constraints(),
				workDir,
			);
			expect(result).toBeNull();
		});
	});

	describe("with allowed_write_paths", () => {
		const c = constraints({
			allowed_write_paths: ["~/.local/share/sprout-genome/capability-index.yaml"],
		});

		test("allows writes to the exact allowed path using tilde", () => {
			const result = checkPathConstraint(
				"write_file",
				{ path: "~/.local/share/sprout-genome/capability-index.yaml" },
				c,
				workDir,
			);
			expect(result).toBeNull();
		});

		test("allows writes using the expanded absolute path", () => {
			const expandedPath = join(homedir(), ".local/share/sprout-genome/capability-index.yaml");
			const result = checkPathConstraint("write_file", { path: expandedPath }, c, workDir);
			expect(result).toBeNull();
		});

		test("denies writes to other paths", () => {
			const result = checkPathConstraint("write_file", { path: "/tmp/evil.txt" }, c, workDir);
			expect(result).toContain("Write access denied");
		});

		test("applies to edit_file", () => {
			const result = checkPathConstraint("edit_file", { path: "/tmp/evil.txt" }, c, workDir);
			expect(result).toContain("Write access denied");
		});

		test("does not restrict reads", () => {
			const result = checkPathConstraint("read_file", { path: "/any/path" }, c, workDir);
			expect(result).toBeNull();
		});

		test("does not restrict exec", () => {
			const result = checkPathConstraint("exec", { command: "rm -rf /" }, c, workDir);
			expect(result).toBeNull();
		});

		test("does not restrict grep", () => {
			const result = checkPathConstraint("grep", { path: "/any/path", pattern: "foo" }, c, workDir);
			expect(result).toBeNull();
		});
	});

	describe("with glob patterns in allowed_write_paths", () => {
		const c = constraints({
			allowed_write_paths: ["~/.local/share/sprout-genome/**"],
		});

		test("allows writes matching the glob", () => {
			const result = checkPathConstraint(
				"write_file",
				{ path: "~/.local/share/sprout-genome/capability-index.yaml" },
				c,
				workDir,
			);
			expect(result).toBeNull();
		});

		test("denies writes outside the glob", () => {
			const result = checkPathConstraint("write_file", { path: "~/.config/something" }, c, workDir);
			expect(result).toContain("Write access denied");
		});
	});

	describe("missing path argument", () => {
		test("allows calls without a path arg", () => {
			const c = constraints({ allowed_write_paths: ["nothing/**"] });
			const result = checkPathConstraint("write_file", {}, c, workDir);
			expect(result).toBeNull();
		});
	});
});

describe("validateConstraints", () => {
	test("throws if allowed_write_paths is set with exec capability", () => {
		expect(() =>
			validateConstraints(
				"test-agent",
				["exec", "write_file"],
				constraints({ allowed_write_paths: ["~/foo"] }),
			),
		).toThrow(/exec can bypass/);
	});

	test("does not throw if allowed_write_paths is set without exec", () => {
		expect(() =>
			validateConstraints(
				"test-agent",
				["read_file", "write_file"],
				constraints({ allowed_write_paths: ["~/foo"] }),
			),
		).not.toThrow();
	});

	test("does not throw if exec is present but no write path constraints", () => {
		expect(() =>
			validateConstraints("test-agent", ["exec", "read_file"], constraints()),
		).not.toThrow();
	});
});
