import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Default filename for project-level docs. */
export const DEFAULT_PROJECT_DOC_FILENAME = "AGENTS.md";
/** Local override filename (checked first). */
export const LOCAL_PROJECT_DOC_FILENAME = "AGENTS.override.md";
/** Default max bytes across all AGENTS.md files combined. */
export const PROJECT_DOC_MAX_BYTES = 32 * 1024; // 32 KiB
/** Default markers that identify a project root. */
export const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];
/** Sprout config directory name under home. */
const SPROUT_CONFIG_DIR = ".config/sprout";

export interface ProjectDocOptions {
	cwd: string;
	/** Max total bytes to read across all files. Default: 32 KiB. */
	maxBytes?: number;
	/** Markers that identify the project root. Default: [".git"]. */
	projectRootMarkers?: string[];
	/** Additional fallback filenames to check after AGENTS.md. */
	fallbackFilenames?: string[];
}

/**
 * Load all AGENTS.md content: home-level + project-level (hierarchical).
 * Returns the assembled content or undefined if no files found.
 * This is intended for the top-level agent only.
 */
export async function loadProjectDocs(options: ProjectDocOptions): Promise<string | undefined> {
	const maxBytes = options.maxBytes ?? PROJECT_DOC_MAX_BYTES;
	if (maxBytes === 0) return undefined;

	const homeContent = await loadHomeInstructions();
	const projectPaths = await discoverProjectDocPaths(options);
	const projectContent = await readProjectDocs(projectPaths, maxBytes);

	if (!homeContent && !projectContent) return undefined;

	const parts: string[] = [];
	if (homeContent) parts.push(homeContent);
	if (projectContent) parts.push(projectContent);
	return parts.join("\n\n---\n\n");
}

/**
 * Load AGENTS.md from the user's home config directory (~/.config/sprout/).
 * Checks AGENTS.override.md first, then AGENTS.md.
 */
async function loadHomeInstructions(): Promise<string | undefined> {
	const dir = join(homedir(), SPROUT_CONFIG_DIR);
	for (const filename of [LOCAL_PROJECT_DOC_FILENAME, DEFAULT_PROJECT_DOC_FILENAME]) {
		const content = await readFileIfExists(join(dir, filename));
		if (content) return content;
	}
	return undefined;
}

/**
 * Discover AGENTS.md files from project root to cwd.
 * Returns paths ordered root-first (broadest scope first).
 */
export async function discoverProjectDocPaths(options: ProjectDocOptions): Promise<string[]> {
	const cwd = resolve(options.cwd);
	const markers = options.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS;
	const candidates = candidateFilenames(options.fallbackFilenames);

	// Find project root by walking up from cwd
	let projectRoot: string | undefined;
	let current = cwd;
	while (true) {
		for (const marker of markers) {
			if (await exists(join(current, marker))) {
				projectRoot = current;
				break;
			}
		}
		if (projectRoot) break;
		const parent = resolve(current, "..");
		if (parent === current) break; // reached filesystem root
		current = parent;
	}

	// Build search dirs from project root to cwd (inclusive)
	let searchDirs: string[];
	if (projectRoot) {
		searchDirs = [];
		let cursor = cwd;
		while (true) {
			searchDirs.push(cursor);
			if (cursor === projectRoot) break;
			const parent = resolve(cursor, "..");
			if (parent === cursor) break;
			cursor = parent;
		}
		searchDirs.reverse(); // root first
	} else {
		searchDirs = [cwd];
	}

	// For each directory, find first matching candidate
	const found: string[] = [];
	for (const dir of searchDirs) {
		for (const name of candidates) {
			const candidate = join(dir, name);
			if (await existsAsFile(candidate)) {
				found.push(candidate);
				break; // first match per directory
			}
		}
	}

	return found;
}

/**
 * Read and concatenate project docs up to a byte budget.
 */
async function readProjectDocs(paths: string[], maxBytes: number): Promise<string | undefined> {
	if (paths.length === 0) return undefined;

	let remaining = maxBytes;
	const parts: string[] = [];

	for (const p of paths) {
		if (remaining <= 0) break;
		try {
			const buf = await readFile(p);
			const data = buf.subarray(0, remaining);
			const text = data.toString("utf-8").trim();
			if (text.length > 0) {
				parts.push(text);
				remaining -= data.length;
			}
		} catch {
			// Skip files that can't be read
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Candidate filenames in priority order.
 */
function candidateFilenames(fallbacks?: string[]): string[] {
	const names = [LOCAL_PROJECT_DOC_FILENAME, DEFAULT_PROJECT_DOC_FILENAME];
	if (fallbacks) {
		for (const f of fallbacks) {
			const trimmed = f.trim();
			if (trimmed.length > 0 && !names.includes(trimmed)) {
				names.push(trimmed);
			}
		}
	}
	return names;
}

/** Read a file and return its trimmed content, or undefined if missing/empty. */
async function readFileIfExists(path: string): Promise<string | undefined> {
	try {
		const content = (await readFile(path, "utf-8")).trim();
		return content.length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

/** Check if a path exists (file or directory). */
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Check if a path exists and is a regular file or symlink. */
async function existsAsFile(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile() || s.isSymbolicLink();
	} catch {
		return false;
	}
}
