import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectProject,
	detectProjectFromCwd,
	ProjectActivityStore,
} from "../../src/genome/projects.ts";

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

	test("project activity counter increments once per local day", async () => {
		const store = new ProjectActivityStore(join(tempDir, "projects.jsonl"));
		await store.load();
		const project = detectProject({ explicitProject: "Sprout" });

		store.recordActiveDay(project, new Date("2026-04-26T10:00:00Z"));
		store.recordActiveDay(project, new Date("2026-04-26T18:00:00Z"));
		store.recordActiveDay(project, new Date("2026-04-27T10:00:00Z"));
		await store.save();

		const reloaded = new ProjectActivityStore(join(tempDir, "projects.jsonl"));
		await reloaded.load();
		expect(reloaded.getById("sprout")).toMatchObject({
			cumulative_active_days: 2,
			last_active_date: "2026-04-27",
		});
	});

	test("unknown project does not advance a project-specific decay clock", async () => {
		const store = new ProjectActivityStore(join(tempDir, "projects.jsonl"));
		await store.load();

		const record = store.recordActiveDay(detectProject({ cwd: "/tmp/src" }), new Date());

		expect(record).toBeUndefined();
		expect(store.all()).toEqual([]);
	});
});
