export type MemoryWriteOperation = "annotate" | "archive" | "consolidate" | "link" | "supersede";

export interface MemoryWriteAuthorization {
	additive?: boolean;
	destructive?: boolean;
	allowedMemoryIds?: readonly string[];
	allowedOperations?: readonly MemoryWriteOperation[];
}

const MEMORY_REFERENCE_PATTERN =
	/\b(memory|memories|long[- ]term memory|mem_[a-z0-9]+|archivist)\b/i;
const REQUEST_PREFIX_PATTERN_SOURCE =
	"(?:^|\\b(?:please|can you|could you|would you|ask(?: the)? archivist to|have(?: the)? archivist|tell(?: the)? archivist to)\\b[\\s\\S]{0,40})";
const ANNOTATE_MUTATION_PATTERN = new RegExp(
	`${REQUEST_PREFIX_PATTERN_SOURCE}\\b(?:annotate|add\\s+(?:an?\\s+)?annotation)\\b[\\s\\S]{0,80}\\b(memory|memories|mem_[a-z0-9]+)\\b`,
	"i",
);
const LINK_MUTATION_PATTERN = new RegExp(
	`${REQUEST_PREFIX_PATTERN_SOURCE}\\b(link|relate)\\b[\\s\\S]{0,80}\\b(memory|memories|mem_[a-z0-9]+)\\b`,
	"i",
);
const MARK_RELATIONSHIP_MUTATION_PATTERN = new RegExp(
	`${REQUEST_PREFIX_PATTERN_SOURCE}\\bmark\\b[\\s\\S]{0,80}\\b(memory|memories|mem_[a-z0-9]+)\\b[\\s\\S]{0,80}\\b(conflicting|conflicts|corroborating|corroborates|refining|refines|contextualizing|contextualizes|related)\\b`,
	"i",
);
const DESTRUCTIVE_MUTATION_PATTERN =
	/\b(archive|consolidate|merge|supersede|supersedes|superseded|replace|deprecate|prune)\b/i;
const AFFIRMATIVE_CONFIRMATION_PATTERN =
	/\b(i explicitly confirm|i confirm|i explicitly approve|i approve|you have confirmation)\b/i;
const NEGATED_CONFIRMATION_PREFIX_PATTERN =
	/\b(not|never|no|without|unless|until|if|only if|do not|don't)\b[\s\S]{0,40}$/i;
const CONDITIONAL_CONFIRMATION_SUFFIX_PATTERN = /\b(only if|unless|until|provided that)\b/i;
const NEGATED_MUTATION_PREFIX_PATTERN =
	/\b(not|never|no|without|unless|until|if|only if|do not|don't)\b[\s\S]{0,48}$/i;
const SHORT_MEMORY_ID_PATTERN = /\bmem_[a-z0-9]+\b/gi;
const NAMED_MEMORY_ID_PATTERN = /\bmem(?:ory|ories)\s+([a-z0-9][a-z0-9_-]*[0-9_-][a-z0-9_-]*)\b/gi;

export function deriveTrustedMemoryWriteAuthorization(input: {
	agentName: string;
	userInstruction?: string;
}): MemoryWriteAuthorization | undefined {
	if (input.agentName !== "archivist") return undefined;
	const text = input.userInstruction?.trim();
	if (!text) return undefined;
	if (!MEMORY_REFERENCE_PATTERN.test(text)) return undefined;
	const allowedMemoryIds = extractMemoryIds(text);
	const allowedOperations = extractAllowedOperations(text);
	if (allowedOperations.length === 0 || hasNegatedMutation(text, allowedOperations)) {
		return undefined;
	}
	const destructive = allowedOperations.some((operation) =>
		["archive", "consolidate", "supersede"].includes(operation),
	);

	if (destructive || DESTRUCTIVE_MUTATION_PATTERN.test(text)) {
		if (!hasExplicitConfirmation(text) || allowedMemoryIds.length === 0) return undefined;
		return { destructive: true, allowedMemoryIds, allowedOperations };
	}
	if (allowedMemoryIds.length === 0) return undefined;
	return { additive: true, allowedMemoryIds, allowedOperations };
}

function hasExplicitConfirmation(text: string): boolean {
	const match = AFFIRMATIVE_CONFIRMATION_PATTERN.exec(text);
	if (!match) return false;
	const prefix = text.slice(Math.max(0, match.index - 48), match.index);
	if (NEGATED_CONFIRMATION_PREFIX_PATTERN.test(prefix)) return false;
	const suffix = text.slice(match.index + match[0].length, match.index + match[0].length + 48);
	return !CONDITIONAL_CONFIRMATION_SUFFIX_PATTERN.test(suffix);
}

function hasNegatedMutation(
	text: string,
	allowedOperations: readonly MemoryWriteOperation[],
): boolean {
	return allowedOperations.some((operation) => {
		for (const match of text.matchAll(operationPattern(operation))) {
			const prefix = text.slice(Math.max(0, (match.index ?? 0) - 64), match.index);
			if (NEGATED_MUTATION_PREFIX_PATTERN.test(prefix)) return true;
		}
		return false;
	});
}

function operationPattern(operation: MemoryWriteOperation): RegExp {
	switch (operation) {
		case "annotate":
			return /\b(annotate|add\s+(?:an?\s+)?annotation)\b/gi;
		case "link":
			return /\b(link|relate|mark)\b/gi;
		case "archive":
			return /\b(archive|deprecate|prune)\b/gi;
		case "consolidate":
			return /\b(consolidate|merge)\b/gi;
		case "supersede":
			return /\b(supersede|supersedes|superseded|replace)\b/gi;
	}
}

function extractAllowedOperations(text: string): MemoryWriteOperation[] {
	const operations = new Set<MemoryWriteOperation>();
	if (ANNOTATE_MUTATION_PATTERN.test(text)) operations.add("annotate");
	if (LINK_MUTATION_PATTERN.test(text) || MARK_RELATIONSHIP_MUTATION_PATTERN.test(text)) {
		operations.add("link");
	}
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
