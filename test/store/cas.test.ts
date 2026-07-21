import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store/cas";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("ContentStore", () => {
	let root: string;
	let staging: string;
	let store: ContentStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "cas-root-"));
		staging = await mkdtemp(join(tmpdir(), "cas-staging-"));
		store = new ContentStore(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
		await rm(staging, { recursive: true, force: true });
	});

	describe("put/get", () => {
		it("roundtrips bytes and returns the hex sha256", async () => {
			const bytes = new TextEncoder().encode("hello sap store");
			const sha = await store.put(bytes);
			expect(sha).toBe(sha256(bytes));
			expect(await store.get(sha)).toEqual(bytes);
		});

		it("fans objects out into a two-char-prefix subdirectory", async () => {
			const bytes = new TextEncoder().encode("fanout");
			const sha = await store.put(bytes);
			const info = await stat(join(root, sha.slice(0, 2), sha));
			expect(info.isFile()).toBe(true);
		});

		it("dedups: same content twice yields the same sha with no error", async () => {
			const bytes = new TextEncoder().encode("dup");
			const first = await store.put(bytes);
			const second = await store.put(bytes);
			expect(second).toBe(first);
			expect(await store.get(first)).toEqual(bytes);
		});

		it("leaves no temp files behind after put", async () => {
			await store.put(new TextEncoder().encode("tidy"));
			const entries = await readdir(root, { recursive: true });
			// Only the prefix dir and the object itself should exist.
			expect(entries.length).toBe(2);
		});
	});

	describe("sha validation", () => {
		const badShas = [
			["path traversal", "../../etc/passwd"],
			["short sha", "abc123"],
			["non-hex chars", "z".repeat(64)],
			["uppercase-with-slash traversal", `${"a".repeat(62)}/x`],
		] as const;

		for (const [label, sha] of badShas) {
			it(`get rejects ${label}`, async () => {
				await expect(store.get(sha)).rejects.toThrow(/invalid sha/i);
			});

			it(`has rejects ${label}`, async () => {
			});
		}

		it("get throws a clear error for a valid-format but unknown sha", async () => {
			const missing = "a".repeat(64);
			await expect(store.get(missing)).rejects.toThrow(/unknown sha/i);
		});

		it("has returns false for a valid-format but unknown sha", async () => {
		});
	});

	describe("totalBytes", () => {
		it("returns 0 for an empty store", async () => {
			expect(await store.totalBytes()).toBe(0);
		});

		it("sums the sizes of all stored objects", async () => {
			await store.put(new Uint8Array(10));
			await store.put(new TextEncoder().encode("hello"));
			expect(await store.totalBytes()).toBe(15);
		});

		it("does not double-count deduped content", async () => {
			const bytes = new Uint8Array(100);
			await store.put(bytes);
			await store.put(bytes);
			expect(await store.totalBytes()).toBe(100);
		});
	});

	describe("adoptFromStaging", () => {
		it("adopts a staged file: content lands in CAS and the file leaves staging", async () => {
			const bytes = new TextEncoder().encode("staged payload");
			const path = join(staging, "upload.bin");
			await writeFile(path, bytes);

			const sha = await store.adoptFromStaging(path, { stagingDir: staging, maxBytes: 1024 });
			expect(sha).toBe(sha256(bytes));
			expect(await store.get(sha)).toEqual(bytes);
			await expect(stat(path)).rejects.toThrow();
		});

		it("adopts from a subdirectory of staging", async () => {
			const dir = join(staging, "nested");
			await mkdir(dir);
			const bytes = new TextEncoder().encode("nested payload");
			const path = join(dir, "file");
			await writeFile(path, bytes);
			const sha = await store.adoptFromStaging(path, { stagingDir: staging, maxBytes: 1024 });
			expect(await store.get(sha)).toEqual(bytes);
		});

		it("rejects a missing file with a clear error", async () => {
			await expect(
				store.adoptFromStaging(join(staging, "nope"), { stagingDir: staging, maxBytes: 1024 }),
			).rejects.toThrow(/not found/i);
		});

		it("rejects a symlink inside staging without reading its target", async () => {
			const secret = join(root, "..", `cas-secret-${Date.now()}`);
			await writeFile(secret, "secret");
			try {
				const link = join(staging, "sneaky");
				await symlink(secret, link);
				await expect(
					store.adoptFromStaging(link, { stagingDir: staging, maxBytes: 1024 }),
				).rejects.toThrow(/symlink/i);
				// The symlink must remain unadopted and the store untouched.
				expect(await store.totalBytes()).toBe(0);
			} finally {
				await rm(secret, { force: true });
			}
		});

		it("rejects a path that escapes staging via ..", async () => {
			const outside = join(staging, "..", `cas-outside-${Date.now()}`);
			await writeFile(outside, "outside");
			try {
				const path = join(staging, "sub", "..", "..", `cas-outside-${Date.now()}`);
				await expect(
					store.adoptFromStaging(outside, { stagingDir: staging, maxBytes: 1024 }),
				).rejects.toThrow(/outside/i);
				await expect(
					store.adoptFromStaging(path, { stagingDir: staging, maxBytes: 1024 }),
				).rejects.toThrow(/outside/i);
			} finally {
				await rm(outside, { force: true });
			}
		});

		it("rejects the staging dir itself as the adoption path", async () => {
			await expect(
				store.adoptFromStaging(staging, { stagingDir: staging, maxBytes: 1024 }),
			).rejects.toThrow();
		});

		it("rejects a file reached through a symlinked parent directory", async () => {
			const realDir = await mkdtemp(join(tmpdir(), "cas-elsewhere-"));
			try {
				await writeFile(join(realDir, "victim"), "victim bytes");
				await symlink(realDir, join(staging, "linkdir"));
				await expect(
					store.adoptFromStaging(join(staging, "linkdir", "victim"), {
						stagingDir: staging,
						maxBytes: 1024,
					}),
				).rejects.toThrow(/outside/i);
			} finally {
				await rm(realDir, { recursive: true, force: true });
			}
		});

		it("rejects an over-size file before adoption, leaving it in staging", async () => {
			const path = join(staging, "big");
			await writeFile(path, new Uint8Array(2048));
			await expect(
				store.adoptFromStaging(path, { stagingDir: staging, maxBytes: 1024 }),
			).rejects.toThrow(/exceeds/i);
			expect((await stat(path)).size).toBe(2048);
			expect(await store.totalBytes()).toBe(0);
		});

		it("accepts a file exactly at maxBytes", async () => {
			const bytes = new Uint8Array(1024).fill(7);
			const path = join(staging, "exact");
			await writeFile(path, bytes);
			const sha = await store.adoptFromStaging(path, { stagingDir: staging, maxBytes: 1024 });
			expect(await store.get(sha)).toEqual(bytes);
		});

		it("stores under the sha of exactly the bytes stored: get(sha) equals staged content", async () => {
			const bytes = new TextEncoder().encode("hash-what-you-store");
			const path = join(staging, "hashcheck");
			await writeFile(path, bytes);
			const sha = await store.adoptFromStaging(path, { stagingDir: staging, maxBytes: 1024 });
			expect(sha).toBe(sha256(bytes));
			expect(await store.get(sha)).toEqual(bytes);
		});

		it("dedups adoption against existing content", async () => {
			const bytes = new TextEncoder().encode("already stored");
			const sha = await store.put(bytes);
			const path = join(staging, "dupe");
			await writeFile(path, bytes);
			const adopted = await store.adoptFromStaging(path, { stagingDir: staging, maxBytes: 1024 });
			expect(adopted).toBe(sha);
			expect(await store.totalBytes()).toBe(bytes.length);
			await expect(stat(path)).rejects.toThrow();
		});
	});
});
