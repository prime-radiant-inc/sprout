import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface BootstrapManifestEntry {
	hash: string;
	version: number;
}

export interface BootstrapManifest {
	synced_at: string;
	agents: Record<string, BootstrapManifestEntry>;
	/** Capabilities from the bootstrap root at last sync — used to detect removals. */
	rootCapabilities?: string[];
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

/**
 * Build a manifest from pre-loaded agent specs and the bootstrap directory.
 * Uses specs for name/version (single source of truth with loadBootstrapAgents),
 * reads raw files only for content hashing.
 */
export async function buildManifestFromSpecs(
	specs: ReadonlyArray<{ name: string; version: number; capabilities?: string[] }>,
	bootstrapDir: string,
): Promise<BootstrapManifest> {
	const agents: Record<string, BootstrapManifestEntry> = {};
	let rootCapabilities: string[] | undefined;
	for (const spec of specs) {
		// Read raw file for content hashing (detects formatting/whitespace changes too)
		const filePath = join(bootstrapDir, `${spec.name}.yaml`);
		try {
			const content = await readFile(filePath, "utf-8");
			agents[spec.name] = {
				hash: hashFileContent(content),
				version: spec.version,
			};
			if (spec.name === "root" && spec.capabilities) {
				rootCapabilities = [...spec.capabilities];
			}
		} catch {
			// File might use .yml extension or be named differently — skip
		}
	}

	return {
		synced_at: new Date().toISOString(),
		agents,
		rootCapabilities,
	};
}
