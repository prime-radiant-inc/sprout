import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BootstrapManifest,
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
});
