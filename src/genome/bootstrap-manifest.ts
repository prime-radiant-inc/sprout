import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BootstrapManifestEntry {
	hash: string;
	version: number;
}

export interface BootstrapManifest {
	synced_at: string;
	agents: Record<string, BootstrapManifestEntry>;
}

/** Load a bootstrap manifest from disk. Returns an empty manifest if the file doesn't exist. */
export async function loadManifest(path: string): Promise<BootstrapManifest> {
	try {
		const content = await readFile(path, "utf-8");
		return JSON.parse(content) as BootstrapManifest;
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return { synced_at: "", agents: {} };
		}
		throw err;
	}
}

/** Compute a sha256 hash of file content, prefixed with "sha256:". */
export function hashFileContent(content: string): string {
	const hex = createHash("sha256").update(content).digest("hex");
	return `sha256:${hex}`;
}

/** Save a bootstrap manifest to disk, creating parent directories if needed. */
export async function saveManifest(path: string, manifest: BootstrapManifest): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(manifest, null, "\t"), "utf-8");
}
