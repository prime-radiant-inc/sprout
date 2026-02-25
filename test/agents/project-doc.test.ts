import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjectDocPaths, loadProjectDocs } from "../../src/agents/project-doc.ts";

describe("project-doc", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "project-doc-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function mkdir(...segments: string[]): string {
		const dir = join(tempDir, ...segments);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function writeFile(path: string, content: string): void {
		writeFileSync(path, content, "utf-8");
	}

	describe("discoverProjectDocPaths", () => {
		test("finds AGENTS.md at project root", async () => {
			const root = mkdir("project");
			mkdirSync(join(root, ".git"));
			writeFile(join(root, "AGENTS.md"), "root instructions");

			const paths = await discoverProjectDocPaths({ cwd: root });
			expect(paths).toHaveLength(1);
			expect(paths[0]).toBe(join(root, "AGENTS.md"));
		});

		test("finds AGENTS.md in nested directories from root to cwd", async () => {
			const root = mkdir("project");
			mkdirSync(join(root, ".git"));
			const sub = mkdir("project", "src", "lib");

			writeFile(join(root, "AGENTS.md"), "root");
			writeFile(join(root, "src", "AGENTS.md"), "src");
			// No AGENTS.md in src/lib

			const paths = await discoverProjectDocPaths({ cwd: sub });
			expect(paths).toHaveLength(2);
			expect(paths[0]).toBe(join(root, "AGENTS.md"));
			expect(paths[1]).toBe(join(root, "src", "AGENTS.md"));
		});

		test("prefers AGENTS.override.md over AGENTS.md in same directory", async () => {
			const root = mkdir("project");
			mkdirSync(join(root, ".git"));
			writeFile(join(root, "AGENTS.md"), "standard");
			writeFile(join(root, "AGENTS.override.md"), "override");

			const paths = await discoverProjectDocPaths({ cwd: root });
			expect(paths).toHaveLength(1);
			expect(paths[0]).toBe(join(root, "AGENTS.override.md"));
		});

		test("returns only cwd when no project root marker found", async () => {
			const dir = mkdir("no-git");
			writeFile(join(dir, "AGENTS.md"), "hello");

			const paths = await discoverProjectDocPaths({ cwd: dir });
			expect(paths).toHaveLength(1);
			expect(paths[0]).toBe(join(dir, "AGENTS.md"));
		});

		test("returns empty when no AGENTS.md files exist", async () => {
			const root = mkdir("empty");
			mkdirSync(join(root, ".git"));

			const paths = await discoverProjectDocPaths({ cwd: root });
			expect(paths).toHaveLength(0);
		});

		test("supports custom project root markers", async () => {
			const root = mkdir("custom-marker");
			mkdirSync(join(root, ".hg")); // mercurial
			writeFile(join(root, "AGENTS.md"), "hg project");

			const paths = await discoverProjectDocPaths({
				cwd: root,
				projectRootMarkers: [".hg"],
			});
			expect(paths).toHaveLength(1);
		});

		test("supports fallback filenames", async () => {
			const root = mkdir("fallback");
			mkdirSync(join(root, ".git"));
			writeFile(join(root, "INSTRUCTIONS.md"), "fallback content");

			// No AGENTS.md or AGENTS.override.md — should find fallback
			const paths = await discoverProjectDocPaths({
				cwd: root,
				fallbackFilenames: ["INSTRUCTIONS.md"],
			});
			expect(paths).toHaveLength(1);
			expect(paths[0]).toBe(join(root, "INSTRUCTIONS.md"));
		});

		test("AGENTS.md takes priority over fallback filenames", async () => {
			const root = mkdir("priority");
			mkdirSync(join(root, ".git"));
			writeFile(join(root, "AGENTS.md"), "standard");
			writeFile(join(root, "INSTRUCTIONS.md"), "fallback");

			const paths = await discoverProjectDocPaths({
				cwd: root,
				fallbackFilenames: ["INSTRUCTIONS.md"],
			});
			expect(paths).toHaveLength(1);
			expect(paths[0]).toBe(join(root, "AGENTS.md"));
		});
	});

	describe("loadProjectDocs", () => {
		test("returns undefined when no files exist", async () => {
			const dir = mkdir("empty-load");
			const result = await loadProjectDocs({ cwd: dir });
			expect(result).toBeUndefined();
		});

		test("loads single AGENTS.md", async () => {
			const root = mkdir("single");
			mkdirSync(join(root, ".git"));
			writeFile(join(root, "AGENTS.md"), "project instructions");

			const result = await loadProjectDocs({ cwd: root });
			expect(result).toContain("project instructions");
		});

		test("concatenates hierarchical AGENTS.md files", async () => {
			const root = mkdir("hierarchical");
			mkdirSync(join(root, ".git"));
			const sub = mkdir("hierarchical", "subdir");

			writeFile(join(root, "AGENTS.md"), "root level");
			writeFile(join(sub, "AGENTS.md"), "subdir level");

			const result = await loadProjectDocs({ cwd: sub });
			expect(result).toBeDefined();
			// Root comes before subdir
			const rootIdx = result!.indexOf("root level");
			const subIdx = result!.indexOf("subdir level");
			expect(rootIdx).toBeLessThan(subIdx);
		});

		test("respects maxBytes budget", async () => {
			const root = mkdir("budget");
			mkdirSync(join(root, ".git"));
			writeFile(join(root, "AGENTS.md"), "x".repeat(1000));

			const result = await loadProjectDocs({ cwd: root, maxBytes: 100 });
			expect(result).toBeDefined();
			expect(result!.length).toBeLessThanOrEqual(100);
		});

		test("returns undefined when maxBytes is 0", async () => {
			const root = mkdir("zero-budget");
			mkdirSync(join(root, ".git"));
			writeFile(join(root, "AGENTS.md"), "content");

			const result = await loadProjectDocs({ cwd: root, maxBytes: 0 });
			expect(result).toBeUndefined();
		});
	});
});
