import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { embeddedRootBundle as generatedEmbeddedRootBundle } from "../generated/embedded-root.ts";

export interface EmbeddedRootFile {
	path: string;
	content: string;
}

export interface EmbeddedRootBundle {
	version: string;
	hash: string;
	files: EmbeddedRootFile[];
}

const BUNDLE_MARKER = ".embedded-root.json";

export async function extractEmbeddedRoot(options: {
	cacheDir?: string;
	bundle?: EmbeddedRootBundle;
} = {}): Promise<string> {
	const bundle = options.bundle ?? normalizeGeneratedBundle(generatedEmbeddedRootBundle);
	const cacheDir = options.cacheDir ?? resolveEmbeddedRootCacheDir();
	const outputDir = join(cacheDir, `${bundle.version}-${bundle.hash}`);
	const markerPath = join(outputDir, BUNDLE_MARKER);

	if (await markerMatches(markerPath, bundle)) {
		return outputDir;
	}

	await rm(outputDir, { recursive: true, force: true });
	await mkdir(outputDir, { recursive: true });

	for (const file of bundle.files) {
		const fullPath = join(outputDir, file.path);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, file.content, "utf-8");
	}

	await writeFile(
		markerPath,
		JSON.stringify(
			{
				version: bundle.version,
				hash: bundle.hash,
			},
			null,
			2,
		),
		"utf-8",
	);

	return outputDir;
}

export async function resolveRuntimeRootDir(options: {
	sourceRootDir?: string;
	cacheDir?: string;
	bundle?: EmbeddedRootBundle;
} = {}): Promise<string> {
	const sourceRootDir = options.sourceRootDir ?? join(import.meta.dir, "../../root");
	if (await pathExists(join(sourceRootDir, "root.md"))) {
		return sourceRootDir;
	}
	return extractEmbeddedRoot({
		cacheDir: options.cacheDir,
		bundle: options.bundle,
	});
}

export function resolveEmbeddedRootCacheDir(): string {
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	return join(xdgCacheHome ?? join(homedir(), ".cache"), "sprout", "embedded-root");
}

function normalizeGeneratedBundle(bundle: {
	version: string;
	hash: string;
	files: readonly { path: string; content: string }[];
}): EmbeddedRootBundle {
	return {
		version: bundle.version,
		hash: bundle.hash,
		files: bundle.files.map((file) => ({
			path: file.path,
			content: file.content,
		})),
	};
}

async function markerMatches(markerPath: string, bundle: EmbeddedRootBundle): Promise<boolean> {
	try {
		const marker = JSON.parse(await readFile(markerPath, "utf-8")) as {
			version?: string;
			hash?: string;
		};
		return marker.version === bundle.version && marker.hash === bundle.hash;
	} catch {
		return false;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
