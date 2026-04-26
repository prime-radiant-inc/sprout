import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { acquireDirectoryLock } from "./file-lock.ts";
import { MemoryIndex, type MemoryIndexStats } from "./memory-index.ts";
import { MemoryStore } from "./memory-store.ts";
import { SegmentStore } from "./segments.ts";

export interface MemoryIndexBuildResult {
	indexPath: string;
	stats: MemoryIndexStats;
}

export interface MemoryIndexBuildOptions {
	assumeMemoryWriteLock?: boolean;
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
	const sourcePaths = memoryIndexSourcePaths(genomeRoot);
	const sourceMtimes = await Promise.all(sourcePaths.map((path) => fileMtimeMs(path)));
	if (sourceMtimes.some((mtime) => mtime !== undefined && mtime > indexMtime)) {
		return "stale";
	}
	return undefined;
}

export async function rebuildMemoryIndexFromJsonl(
	genomeRoot: string,
	options: MemoryIndexBuildOptions = {},
): Promise<MemoryIndexBuildResult> {
	if (options.assumeMemoryWriteLock) {
		return rebuildMemoryIndexFromJsonlLocked(genomeRoot);
	}
	await mkdir(join(genomeRoot, ".cache"), { recursive: true });
	const release = await acquireDirectoryLock(memoryWriteLockPath(genomeRoot));
	try {
		return await rebuildMemoryIndexFromJsonlLocked(genomeRoot);
	} finally {
		await release();
	}
}

async function rebuildMemoryIndexFromJsonlLocked(
	genomeRoot: string,
): Promise<MemoryIndexBuildResult> {
	const sourcePaths = memoryIndexSourcePaths(genomeRoot);
	const store = new MemoryStore(join(genomeRoot, "memories", "memories.jsonl"));
	const segments = new SegmentStore(join(genomeRoot, "memories", "segments.jsonl"));
	const indexPath = memoryIndexPath(genomeRoot);

	while (true) {
		const before = await sourceFingerprints(sourcePaths);
		await Promise.all([store.load(), segments.load()]);

		const tempIndexPath = temporaryMemoryIndexPath(indexPath);
		let stats: MemoryIndexStats;
		const index = MemoryIndex.open(tempIndexPath);
		try {
			index.rebuild(store.all(), segments.all());
			stats = index.stats();
		} catch (err) {
			await removeSqliteFiles(tempIndexPath);
			throw err;
		} finally {
			index.close();
		}

		const after = await sourceFingerprints(sourcePaths);
		if (!sameSourceFingerprints(before, after)) {
			await removeSqliteFiles(tempIndexPath);
			continue;
		}

		try {
			await replaceMemoryIndex(indexPath, tempIndexPath);
			return {
				indexPath,
				stats,
			};
		} catch (err) {
			await removeSqliteFiles(tempIndexPath);
			throw err;
		}
	}
}

function memoryIndexSourcePaths(genomeRoot: string): string[] {
	return [
		join(genomeRoot, "memories", "memories.jsonl"),
		join(genomeRoot, "memories", "segments.jsonl"),
	];
}

function memoryWriteLockPath(genomeRoot: string): string {
	return join(genomeRoot, ".cache", "memory-write.lock");
}

function temporaryMemoryIndexPath(indexPath: string): string {
	return `${indexPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

async function replaceMemoryIndex(indexPath: string, tempIndexPath: string): Promise<void> {
	await Promise.all([
		rm(`${indexPath}-shm`, { force: true }),
		rm(`${indexPath}-wal`, { force: true }),
	]);
	await rename(tempIndexPath, indexPath);
	await removeSqliteFiles(tempIndexPath);
}

async function removeSqliteFiles(path: string): Promise<void> {
	await Promise.all([
		rm(path, { force: true }),
		rm(`${path}-shm`, { force: true }),
		rm(`${path}-wal`, { force: true }),
	]);
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

interface SourceFingerprint {
	exists: boolean;
	size?: bigint;
	mtimeNs?: bigint;
}

async function sourceFingerprints(paths: readonly string[]): Promise<SourceFingerprint[]> {
	return Promise.all(paths.map((path) => sourceFingerprint(path)));
}

async function sourceFingerprint(path: string): Promise<SourceFingerprint> {
	try {
		const info = await stat(path, { bigint: true });
		return {
			exists: true,
			size: info.size,
			mtimeNs: info.mtimeNs,
		};
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			return { exists: false };
		}
		throw err;
	}
}

function sameSourceFingerprints(
	left: readonly SourceFingerprint[],
	right: readonly SourceFingerprint[],
): boolean {
	return (
		left.length === right.length &&
		left.every((fingerprint, index) => {
			const other = right[index];
			return (
				other !== undefined &&
				fingerprint.exists === other.exists &&
				fingerprint.size === other.size &&
				fingerprint.mtimeNs === other.mtimeNs
			);
		})
	);
}
