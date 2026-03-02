import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectDirs, projectDataDir, slugifyPath } from "../../src/util/project-id.ts";

describe("slugifyPath", () => {
	test("converts slashes to hyphens", () => {
		expect(slugifyPath("/Users/jesse/prime-radiant/sprout")).toBe(
			"-Users-jesse-prime-radiant-sprout",
		);
	});

	test("converts spaces to hyphens", () => {
		expect(slugifyPath("/Users/jesse/my project")).toBe("-Users-jesse-my-project");
	});

	test("handles mixed slashes and spaces", () => {
		expect(slugifyPath("/home/user/my project/sub dir")).toBe("-home-user-my-project-sub-dir");
	});

	test("handles simple relative path", () => {
		expect(slugifyPath("myproject")).toBe("myproject");
	});
});

describe("projectDataDir", () => {
	test("builds path under genome/projects/", () => {
		const result = projectDataDir("/home/genome", "/Users/jesse/sprout");
		expect(result).toBe(join("/home/genome", "projects", "-Users-jesse-sprout"));
	});
});

describe("ensureProjectDirs", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-epd-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates sessions, logs, and memory subdirectories", async () => {
		const dataDir = join(tempDir, "project-data");
		await ensureProjectDirs(dataDir);

		expect(existsSync(join(dataDir, "sessions"))).toBe(true);
		expect(existsSync(join(dataDir, "logs"))).toBe(true);
		expect(existsSync(join(dataDir, "memory"))).toBe(true);
	});

	test("is idempotent (succeeds if dirs already exist)", async () => {
		const dataDir = join(tempDir, "project-data");
		await ensureProjectDirs(dataDir);
		await ensureProjectDirs(dataDir); // should not throw
		expect(existsSync(join(dataDir, "sessions"))).toBe(true);
	});
});
