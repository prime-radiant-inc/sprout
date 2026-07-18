import { createHash, randomBytes } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Content-addressed store for the sap data plane (spec §1 Durability,
 * Transport). Objects live under their hex sha256, fanned out into a
 * two-char-prefix subdirectory. Writes are atomic (temp file + rename) so a
 * crash never leaves a partial object under its final name, and identical
 * content dedups for free.
 */

const SHA_HEX = /^[0-9a-f]{64}$/;

/**
 * Reject anything that is not exactly 64 lowercase hex chars before it can
 * touch the filesystem — a crafted sha must never become path traversal.
 */
function assertValidSha(sha: string): void {
	if (!SHA_HEX.test(sha)) {
		throw new Error(`invalid sha: expected 64 lowercase hex chars, got ${JSON.stringify(sha)}`);
	}
}

export interface AdoptOptions {
	/** Host-created per-session staging directory the file must live inside. */
	stagingDir: string;
	/** Maximum adoptable file size in bytes, checked before adoption. */
	maxBytes: number;
}

export class ContentStore {
	constructor(private readonly root: string) {}

	private objectPath(sha: string): string {
		return join(this.root, sha.slice(0, 2), sha);
	}

	/** Store bytes under their sha256 and return the sha. */
	async put(bytes: Uint8Array): Promise<string> {
		const sha = createHash("sha256").update(bytes).digest("hex");
		const dest = this.objectPath(sha);
		if (await pathExists(dest)) return sha;
		await mkdir(dirname(dest), { recursive: true });
		// Atomic publish: write to a temp name in the same directory, then
		// rename — readers never observe a partial object under its final name.
		const tmp = join(dirname(dest), `.tmp-${randomBytes(8).toString("hex")}`);
		try {
			await writeFile(tmp, bytes);
			await rename(tmp, dest);
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
		return sha;
	}

	/** Read the bytes stored under sha; throws for invalid or unknown shas. */
	async get(sha: string): Promise<Uint8Array> {
		assertValidSha(sha);
		const file = Bun.file(this.objectPath(sha));
		if (!(await file.exists())) {
			throw new Error(`unknown sha: ${sha}`);
		}
		return new Uint8Array(await file.arrayBuffer());
	}

	async has(sha: string): Promise<boolean> {
		assertValidSha(sha);
		return pathExists(this.objectPath(sha));
	}

	/** Total bytes stored — the CAS side of the session disk quota. */
	async totalBytes(): Promise<number> {
		let total = 0;
		let entries: string[];
		try {
			entries = await readdir(this.root, { recursive: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw err;
		}
		for (const entry of entries) {
			const info = await stat(join(this.root, entry));
			if (info.isFile()) total += info.size;
		}
		return total;
	}

	/**
	 * Confined CAS handoff (spec §1 Transport): adopt a file a producer wrote
	 * into the host-created staging directory, and only from there. The path
	 * is canonicalized, symlinks are rejected before any read, and size is
	 * checked against maxBytes before adoption. Arbitrary path adoption would
	 * let a confused producer make the store ingest any readable file on disk.
	 */
	async adoptFromStaging(path: string, options: AdoptOptions): Promise<string> {
		const canonicalStaging = await realpath(options.stagingDir);
		// lstat the file itself first: a symlink inside staging pointing
		// anywhere must be rejected before its target is ever touched.
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(`staged file not found: ${path}`);
			}
			throw err;
		}
		if (info.isSymbolicLink()) {
			throw new Error(`refusing to adopt symlink: ${path}`);
		}
		if (!info.isFile()) {
			throw new Error(`not a regular file: ${path}`);
		}
		// Canonicalize the parent (the file itself is a verified non-symlink)
		// so a symlinked ancestor cannot smuggle in a path outside staging.
		const canonical = join(await realpath(dirname(path)), resolve(path).split(sep).at(-1) ?? "");
		if (!canonical.startsWith(canonicalStaging + sep)) {
			throw new Error(`path is outside the staging directory: ${path}`);
		}
		if (info.size > options.maxBytes) {
			throw new Error(`staged file exceeds max size: ${info.size} > ${options.maxBytes} bytes`);
		}

		const sha = createHash("sha256")
			.update(new Uint8Array(await Bun.file(canonical).arrayBuffer()))
			.digest("hex");
		const dest = this.objectPath(sha);
		if (await pathExists(dest)) {
			// Already stored — dedup; just clear the staged copy.
			await unlink(canonical);
			return sha;
		}
		await mkdir(dirname(dest), { recursive: true });
		try {
			await rename(canonical, dest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
			// Staging and CAS on different devices: copy atomically, then unlink.
			const tmp = join(dirname(dest), `.tmp-${randomBytes(8).toString("hex")}`);
			try {
				await copyFile(canonical, tmp);
				await rename(tmp, dest);
			} catch (copyErr) {
				await rm(tmp, { force: true });
				throw copyErr;
			}
			await unlink(canonical);
		}
		return sha;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}
