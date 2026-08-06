import type { MemorySegment } from "../../src/genome/segments.ts";
import type { Genome } from "../../src/genome/genome.ts";
import type { Memory } from "../../src/kernel/types.ts";

/**
 * Seed memories through the PRODUCTION staging lane (stage + one committed
 * save) — the test-only Genome.addMemory/addMemories convenience lanes were
 * deleted (kill-with-judgment sweep). Same protections as the old lanes:
 * duplicate-id and short-id collisions throw from stage(), activity snapshots
 * are stamped, embeddings attach, and the write commits to git.
 */
export async function seedMemories(genome: Genome, ...memories: Memory[]): Promise<void> {
	if (memories.length === 0) return;
	for (const memory of memories) {
		await genome.stageMemoryForMutation(memory);
	}
	await genome.saveMemoryMutation(
		`genome: seed ${memories.length} test memor${memories.length === 1 ? "y" : "ies"}`,
	);
}

/** Seed a segment through the production lane (addSegmentWithMemories with none). */
export async function seedSegment(genome: Genome, segment: MemorySegment): Promise<void> {
	await genome.addSegmentWithMemories(segment, []);
}
