import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BootstrapManifest,
	buildManifestFromSpecs,
	hashFileContent,
	loadManifest,
	saveManifest,
} from "../../src/genome/bootstrap-manifest.ts";

describe("bootstrap-manifest", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-manifest-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	describe("loadManifest / saveManifest", () => {
		test("loadManifest returns empty manifest when file does not exist", async () => {
			const manifest = await loadManifest(join(tempDir, "no-such-file.json"));

			expect(manifest.synced_at).toBe("");
			expect(manifest.agents).toEqual({});
		});

		test("saveManifest + loadManifest round-trips", async () => {
			const path = join(tempDir, "round-trip.json");
			const manifest: BootstrapManifest = {
				synced_at: "2026-02-28T00:00:00Z",
				agents: {
					reader: { hash: "sha256:abc123", version: 2 },
					editor: { hash: "sha256:def456", version: 1 },
				},
			};

			await saveManifest(path, manifest);
			const loaded = await loadManifest(path);

			expect(loaded).toEqual(manifest);
		});

		test("saveManifest creates parent directories when needed", async () => {
			const path = join(tempDir, "nested", "dirs", "manifest.json");
			const manifest: BootstrapManifest = {
				synced_at: "2026-02-28T00:00:00Z",
				agents: {},
			};

			await saveManifest(path, manifest);
			const loaded = await loadManifest(path);

			expect(loaded).toEqual(manifest);
		});
	});

	describe("hashFileContent", () => {
		test("same content produces same hash", () => {
			const content = "name: reader\nversion: 2\n";
			const hash1 = hashFileContent(content);
			const hash2 = hashFileContent(content);

			expect(hash1).toBe(hash2);
		});

		test("different content produces different hashes", () => {
			const hash1 = hashFileContent("name: reader\nversion: 1\n");
			const hash2 = hashFileContent("name: reader\nversion: 2\n");

			expect(hash1).not.toBe(hash2);
		});

		test("hash format is sha256: followed by 64 hex characters", () => {
			const hash = hashFileContent("anything");

			expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		});
	});

	describe("buildManifestFromSpecs", () => {
		let bootstrapDir: string;

		const readerYaml = "name: reader\nversion: 2\ndescription: reads files\n";
		const editorYaml = "name: editor\nversion: 1\ndescription: edits files\n";

		const specs = [
			{ name: "reader", version: 2 },
			{ name: "editor", version: 1 },
		];

		beforeAll(async () => {
			bootstrapDir = await mkdtemp(join(tmpdir(), "sprout-bootstrap-"));
			await writeFile(join(bootstrapDir, "reader.yaml"), readerYaml);
			await writeFile(join(bootstrapDir, "editor.yaml"), editorYaml);
		});

		afterAll(async () => {
			await rm(bootstrapDir, { recursive: true });
		});

		test("creates manifest from specs and bootstrap directory", async () => {
			const manifest = await buildManifestFromSpecs(specs, bootstrapDir);

			expect(Object.keys(manifest.agents)).toHaveLength(2);
			expect(manifest.agents.reader).toBeDefined();
			expect(manifest.agents.editor).toBeDefined();
			expect(manifest.synced_at).not.toBe("");
		});

		test("skips specs whose YAML file is missing", async () => {
			const extendedSpecs = [...specs, { name: "ghost", version: 1 }];
			const manifest = await buildManifestFromSpecs(extendedSpecs, bootstrapDir);

			expect(Object.keys(manifest.agents)).toHaveLength(2);
			expect(manifest.agents.ghost).toBeUndefined();
		});

		test("captures version and hash for each agent", async () => {
			const manifest = await buildManifestFromSpecs(specs, bootstrapDir);

			expect(manifest.agents.reader!.version).toBe(2);
			expect(manifest.agents.reader!.hash).toBe(hashFileContent(readerYaml));

			expect(manifest.agents.editor!.version).toBe(1);
			expect(manifest.agents.editor!.hash).toBe(hashFileContent(editorYaml));
		});
	});
});
