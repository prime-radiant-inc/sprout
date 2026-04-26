import type { Memory } from "../kernel/types.ts";

export function isActiveMemoryForRecall(
	memory: Pick<Memory, "archived_at" | "superseded_by" | "inbound_links">,
): boolean {
	if (memory.archived_at || memory.superseded_by) return false;
	return !(memory.inbound_links ?? []).some((link) => link.type === "supersedes");
}
