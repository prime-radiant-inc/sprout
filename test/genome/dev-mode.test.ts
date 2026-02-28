import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDevMode } from "../../src/genome/dev-mode.ts";

describe("isDevMode", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-devmode-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("returns true when workDir contains bootstrap/ and src/genome/", async () => {
		const workDir = join(tempDir, "sprout-src");
		await mkdir(join(workDir, "bootstrap"), { recursive: true });
		await mkdir(join(workDir, "src/genome"), { recursive: true });
		expect(isDevMode(workDir)).toBe(true);
	});

	test("returns false when workDir is a normal project", async () => {
		const workDir = join(tempDir, "normal-project");
		await mkdir(join(workDir, "src"), { recursive: true });
		expect(isDevMode(workDir)).toBe(false);
	});

	test("returns false when only bootstrap/ exists", async () => {
		const workDir = join(tempDir, "partial");
		await mkdir(join(workDir, "bootstrap"), { recursive: true });
		expect(isDevMode(workDir)).toBe(false);
	});
});
