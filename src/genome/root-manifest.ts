import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RootManifestEntry {
	hash: string;
	version: number;
}

export interface RootManifest {
	synced_at: string;
	agents: Record<string, RootManifestEntry>;
	/** Tools from the root agent at last sync. */
	rootTools?: string[];
	/** Agents (delegation refs) from the root agent at last sync. */
	rootAgents?: string[];
}

/** Load a root manifest from disk. Returns an empty manifest if the file doesn't exist. */
export async function loadManifest(path: string): Promise<RootManifest> {
	try {
		const content = await readFile(path, "utf-8");
		const raw = JSON.parse(content) as RootManifest & { rootCapabilities?: string[] };
		// Migrate old manifests that used combined rootCapabilities
		if (raw.rootTools === undefined && raw.rootCapabilities) {
			raw.rootTools = raw.rootCapabilities.filter((c) => !c.includes("/"));
			raw.rootAgents = raw.rootCapabilities.filter((c) => c.includes("/"));
			delete raw.rootCapabilities;
		}
		return raw;
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

/** Save a root manifest to disk, creating parent directories if needed. */
export async function saveManifest(path: string, manifest: RootManifest): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(manifest, null, "\t"), "utf-8");
}

/**
 * Build a manifest from pre-loaded agent specs and their raw file content.
 * The rawContentByName map (agent name → raw file content) is used for content hashing;
 * specs provide name/version as the single source of truth.
 */
export function buildManifestFromSpecs(
	specs: ReadonlyArray<{ name: string; version: number; tools?: string[]; agents?: string[] }>,
	rawContentByName: ReadonlyMap<string, string>,
): RootManifest {
	const agents: Record<string, RootManifestEntry> = {};
	let rootTools: string[] | undefined;
	let rootAgents: string[] | undefined;
	for (const spec of specs) {
		const content = rawContentByName.get(spec.name);
		if (!content) continue;
		agents[spec.name] = {
			hash: hashFileContent(content),
			version: spec.version,
		};
		if (spec.name === "root") {
			rootTools = [...(spec.tools ?? [])];
			rootAgents = [...(spec.agents ?? [])];
		}
	}

	return {
		// Timestamp records when this manifest was built, not when it was saved.
		// syncRoot only persists the manifest when actual changes occur,
		// so this doesn't cause needless git commits on no-op syncs.
		synced_at: new Date().toISOString(),
		agents,
		rootTools,
		rootAgents,
	};
}
