import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";

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
 *
 * Scans all YAML files in bootstrapDir and matches by parsed `name` field,
 * so filenames don't need to match spec names.
 */
export async function buildManifestFromSpecs(
	specs: ReadonlyArray<{ name: string; version: number; capabilities?: string[] }>,
	bootstrapDir: string,
): Promise<BootstrapManifest> {
	// Build a map of agent name → raw file content by scanning all YAML files
	const fileContentByName = new Map<string, string>();
	try {
		const files = await readdir(bootstrapDir);
		for (const file of files) {
			if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
			try {
				const content = await readFile(join(bootstrapDir, file), "utf-8");
				const parsed = parse(content);
				if (typeof parsed?.name === "string") {
					fileContentByName.set(parsed.name, content);
				}
			} catch {
				// Skip unparseable files
			}
		}
	} catch {
		// Directory might not exist
	}

	const agents: Record<string, BootstrapManifestEntry> = {};
	let rootCapabilities: string[] | undefined;
	for (const spec of specs) {
		const content = fileContentByName.get(spec.name);
		if (!content) continue;
		agents[spec.name] = {
			hash: hashFileContent(content),
			version: spec.version,
		};
		if (spec.name === "root" && spec.capabilities) {
			rootCapabilities = [...spec.capabilities];
		}
	}

	return {
		// Timestamp records when this manifest was built, not when it was saved.
		// syncBootstrap only persists the manifest when actual changes occur,
		// so this doesn't cause needless git commits on no-op syncs.
		synced_at: new Date().toISOString(),
		agents,
		rootCapabilities,
	};
}
