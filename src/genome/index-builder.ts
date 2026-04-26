import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIndex, type MemoryIndexStats } from "./memory-index.ts";
import { MemoryStore } from "./memory-store.ts";
import { SegmentStore } from "./segments.ts";

export interface MemoryIndexBuildResult {
	indexPath: string;
	stats: MemoryIndexStats;
}

export function memoryIndexPath(genomeRoot: string): string {
	return join(genomeRoot, ".cache", "index.db");
}

export async function ensureMemoryIndexFresh(genomeRoot: string): Promise<void> {
	const staleReason = await memoryIndexStaleReason(genomeRoot);
	if (staleReason) {
		await rebuildMemoryIndexFromJsonl(genomeRoot);
	}
}

export async function requireMemoryIndexFresh(genomeRoot: string): Promise<void> {
	const staleReason = await memoryIndexStaleReason(genomeRoot);
	if (staleReason) {
		throw new Error(`Memory index is not fresh (${staleReason}); rebuild required`);
	}
}

async function memoryIndexStaleReason(genomeRoot: string): Promise<string | undefined> {
	const indexPath = memoryIndexPath(genomeRoot);
	const indexMtime = await fileMtimeMs(indexPath);
	if (indexMtime === undefined) return "missing";
	if (MemoryIndex.readSchemaVersion(indexPath) !== MemoryIndex.currentSchemaVersion()) {
		return "schema";
	}
	const sourcePaths = [
		join(genomeRoot, "memories", "memories.jsonl"),
		join(genomeRoot, "memories", "segments.jsonl"),
	];
	const sourceMtimes = await Promise.all(sourcePaths.map((path) => fileMtimeMs(path)));
	if (sourceMtimes.some((mtime) => mtime !== undefined && mtime > indexMtime)) {
		return "stale";
	}
	return undefined;
}

export async function rebuildMemoryIndexFromJsonl(
	genomeRoot: string,
): Promise<MemoryIndexBuildResult> {
	const store = new MemoryStore(join(genomeRoot, "memories", "memories.jsonl"));
	const segments = new SegmentStore(join(genomeRoot, "memories", "segments.jsonl"));
	await Promise.all([store.load(), segments.load()]);

	const indexPath = memoryIndexPath(genomeRoot);
	await Promise.all([
		rm(indexPath, { force: true }),
		rm(`${indexPath}-shm`, { force: true }),
		rm(`${indexPath}-wal`, { force: true }),
	]);
	const index = MemoryIndex.open(indexPath);
	try {
		index.rebuild(store.all(), segments.all());
		return {
			indexPath,
			stats: index.stats(),
		};
	} finally {
		index.close();
	}
}

async function fileMtimeMs(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			return undefined;
		}
		throw err;
	}
}
