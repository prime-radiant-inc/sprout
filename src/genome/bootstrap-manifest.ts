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

/** Scan a bootstrap directory for YAML agent specs and build a manifest from them. */
export async function buildManifestFromBootstrap(bootstrapDir: string): Promise<BootstrapManifest> {
	const entries = await readdir(bootstrapDir);
	const yamlFiles = entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

	const agents: Record<string, BootstrapManifestEntry> = {};
	for (const file of yamlFiles) {
		const content = await readFile(join(bootstrapDir, file), "utf-8");
		const parsed = parse(content);
		const name = parsed?.name;
		if (typeof name !== "string" || !name) continue;
		const version = (parsed?.version as number) ?? 1;
		agents[name] = {
			hash: hashFileContent(content),
			version,
		};
	}

	return {
		synced_at: new Date().toISOString(),
		agents,
	};
}
