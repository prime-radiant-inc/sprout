import type { Memory } from "../kernel/types.ts";
import { memoryShortId } from "./memory-schema.ts";

export function renderMemoryBlock(memories: readonly Memory[]): string {
	if (memories.length === 0) return "";
	const rendered = memories.map((memory) => renderMemory(memory)).join("\n");
	return `\n<memory_context>\n${rendered}\n</memory_context>`;
}

export function extractMemoryReferences(text: string): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(/\bmem_[a-zA-Z0-9]{8}\b/g)) {
		seen.add(match[0]!.toLowerCase());
	}
	return [...seen];
}

function renderMemory(memory: Memory): string {
	const id = memory.short_id ?? memoryShortId(memory.id);
	const tags = memory.tags.length > 0 ? ` tags="${escapeXml(memory.tags.join(","))}"` : "";
	const source = memory.source ? ` source="${escapeXml(memory.source)}"` : "";
	const importance = memory.effective_importance ?? memory.importance_score ?? memory.confidence;
	const entities = (memory.entity_links ?? [])
		.map((entity) => `${entity.type}:${entity.name}`)
		.join(", ");
	const entityLine = entities ? `\n<entities>${escapeXml(entities)}</entities>` : "";
	return `<memory id="${id}" importance="${importance.toFixed(3)}"${source}${tags}>
<text>[${id}] ${escapeXml(memory.content)}</text>${entityLine}
</memory>`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
