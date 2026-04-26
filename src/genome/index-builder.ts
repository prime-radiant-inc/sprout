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

export async function rebuildMemoryIndexFromJsonl(
	genomeRoot: string,
): Promise<MemoryIndexBuildResult> {
	const store = new MemoryStore(join(genomeRoot, "memories", "memories.jsonl"));
	const segments = new SegmentStore(join(genomeRoot, "memories", "segments.jsonl"));
	await Promise.all([store.load(), segments.load()]);

	const indexPath = memoryIndexPath(genomeRoot);
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
