import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject, detectProjectFromCwd } from "../../src/genome/projects.ts";

describe("project detection", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-project-detect-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("explicit project wins over metadata and inference", () => {
		expect(
			detectProject({
				explicitProject: "Customer Portal",
				metadataProject: "Metadata Project",
				packageName: "@prime-radiant/sprout",
			}),
		).toEqual({
			id: "customer-portal",
			name: "Customer Portal",
			confidence: 1,
			source: "explicit",
		});
	});

	test("session metadata wins over package and git inference", () => {
		const project = detectProject({
			metadataProject: "Session Project",
			packageName: "wrong-package",
			gitRoot: "/work/wrong-root",
		});

		expect(project.id).toBe("session-project");
		expect(project.source).toBe("metadata");
		expect(project.confidence).toBe(0.95);
	});

	test("infers from package name and normalized remote", () => {
		expect(detectProject({ packageName: "@prime-radiant/sprout" })).toMatchObject({
			id: "prime-radiant-sprout",
			name: "prime-radiant-sprout",
			source: "package",
		});
		expect(detectProject({ remoteUrl: "git@github.com:PrimeRadiant/sprout.git" })).toMatchObject({
			id: "primeradiant-sprout",
			name: "sprout",
			source: "remote",
			remote: "primeradiant/sprout",
		});
	});

	test("generic wrong-project paths stay unknown", () => {
		expect(detectProject({ cwd: "/tmp/src", gitRoot: "/tmp/src" })).toEqual({
			id: "unknown",
			name: "unknown",
			confidence: 0,
			source: "unknown",
		});
	});

	test("reads package metadata from cwd", async () => {
		await writeFile(join(tempDir, "package.json"), JSON.stringify({ name: "sprout-memory" }));

		const project = await detectProjectFromCwd({ cwd: tempDir });

		expect(project).toMatchObject({
			id: "sprout-memory",
			name: "sprout-memory",
			source: "package",
		});
	});
});
