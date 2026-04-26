export type MemoryWriteOperation = "annotate" | "archive" | "consolidate" | "link" | "supersede";

export interface MemoryWriteAuthorization {
	additive?: boolean;
	destructive?: boolean;
	allowedMemoryIds?: readonly string[];
	allowedOperations?: readonly MemoryWriteOperation[];
}

const MEMORY_REFERENCE_PATTERN =
	/\b(memory|memories|long[- ]term memory|mem_[a-z0-9]+|archivist)\b/i;
const ADDITIVE_MUTATION_PATTERN =
	/\b(annotate|annotation|link|relate|corroborate|conflict|contextualize|refine|supersede|supersedes|archive|consolidate|merge)\b/i;
const DESTRUCTIVE_MUTATION_PATTERN =
	/\b(archive|consolidate|merge|supersede|supersedes|superseded|replace|deprecate|prune)\b/i;
const CONFIRMATION_PATTERN =
	/\b(i confirm|confirmed|explicitly confirm|explicit confirmation|i approve|approved|explicitly approve|go ahead|you have confirmation)\b/i;
const SHORT_MEMORY_ID_PATTERN = /\bmem_[a-z0-9]+\b/gi;
const NAMED_MEMORY_ID_PATTERN = /\bmem(?:ory|ories)\s+([a-z0-9][a-z0-9_-]*[0-9_-][a-z0-9_-]*)\b/gi;

export function deriveTrustedMemoryWriteAuthorization(input: {
	agentName: string;
	userInstruction?: string;
}): MemoryWriteAuthorization | undefined {
	if (input.agentName !== "archivist") return undefined;
	const text = input.userInstruction?.trim();
	if (!text) return undefined;
	if (!MEMORY_REFERENCE_PATTERN.test(text) || !ADDITIVE_MUTATION_PATTERN.test(text))
		return undefined;
	const allowedMemoryIds = extractMemoryIds(text);
	const allowedOperations = extractAllowedOperations(text);
	const destructive = allowedOperations.some((operation) =>
		["archive", "consolidate", "supersede"].includes(operation),
	);

	if (destructive || DESTRUCTIVE_MUTATION_PATTERN.test(text)) {
		if (!CONFIRMATION_PATTERN.test(text) || allowedMemoryIds.length === 0) return undefined;
		return { destructive: true, allowedMemoryIds, allowedOperations };
	}
	if (allowedMemoryIds.length === 0) return undefined;
	return { additive: true, allowedMemoryIds, allowedOperations };
}

function extractAllowedOperations(text: string): MemoryWriteOperation[] {
	const operations = new Set<MemoryWriteOperation>();
	if (/\b(annotate|annotation|contextualize|refine)\b/i.test(text)) operations.add("annotate");
	if (/\b(link|relate|corroborate|conflict|contextualize|refine)\b/i.test(text))
		operations.add("link");
	if (/\b(archive|deprecate|prune)\b/i.test(text)) operations.add("archive");
	if (/\b(consolidate|merge)\b/i.test(text)) operations.add("consolidate");
	if (/\b(supersede|supersedes|superseded|replace)\b/i.test(text)) operations.add("supersede");
	return [...operations];
}

function extractMemoryIds(text: string): string[] {
	const ids = new Set<string>();
	for (const match of text.matchAll(SHORT_MEMORY_ID_PATTERN)) {
		ids.add(match[0].toLowerCase());
	}
	for (const match of text.matchAll(NAMED_MEMORY_ID_PATTERN)) {
		const id = match[1];
		if (id) ids.add(id.toLowerCase());
	}
	return [...ids];
}
