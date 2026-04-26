export type MemoryWriteOperation = "annotate" | "archive" | "consolidate" | "link" | "supersede";
export type MemoryWriteOperationIds = Partial<Record<MemoryWriteOperation, readonly string[]>>;

export interface MemorySupersedeDirection {
	fromId: string;
	toId: string;
}

export interface MemoryWriteAuthorization {
	additive?: boolean;
	destructive?: boolean;
	allowedMemoryIds?: readonly string[];
	allowedMemoryIdsByOperation?: MemoryWriteOperationIds;
	allowedOperations?: readonly MemoryWriteOperation[];
	supersedeDirections?: readonly MemorySupersedeDirection[];
}

const MEMORY_REFERENCE_PATTERN =
	/\b(memory|memories|long[- ]term memory|mem_[a-z0-9]+|archivist)\b/i;
const MEMORY_WRITE_VERB_PATTERN =
	/\b(annotate|annotation|link|relate|mark|archive|consolidate|merge|supersede|supersedes|superseded|replace|deprecate|prune)\b/i;
const META_QUESTION_PATTERN =
	/^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:explain|show me|tell me|what|why|whether|how(?:\s+(?:to|do|does|would|can))?)\b/i;
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
const LINK_MEMORY_ID_CLAUSE_PATTERN =
	/\b(link|relate)\b[\s\S]{0,80}\b(memory|memories|mem_[a-z0-9]+)\b/i;
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
const CONDITIONAL_CONFIRMATION_SUFFIX_PATTERN = /\b(only if|if|unless|until|provided that)\b/i;
const NEGATED_MUTATION_PREFIX_PATTERN =
	/\b(not|never|no|without|unless|until|if|only if|do not|don't)\b[\s\S]{0,48}$/i;
const SHORT_MEMORY_ID_PATTERN = /\bmem_[a-z0-9]+\b/gi;
const NAMED_MEMORY_ID_PATTERN = /\bmem(?:ory|ories)\s+([a-z0-9][a-z0-9_-]*[0-9_-][a-z0-9_-]*)\b/gi;
const MEMORY_ID_SOURCE =
	"(?:mem_[a-z0-9]+|mem(?:ory|ories)\\s+[a-z0-9][a-z0-9_-]*[0-9_-][a-z0-9_-]*)";
const SUPERSEDE_WITH_PATTERN = new RegExp(
	`\\b(?:supersede|replace|deprecate)\\s+(${MEMORY_ID_SOURCE})\\s+with\\s+(${MEMORY_ID_SOURCE})`,
	"gi",
);
const SUPERSEDES_PATTERN = new RegExp(
	`(${MEMORY_ID_SOURCE})\\s+\\b(?:supersedes|replaces)\\b\\s+(${MEMORY_ID_SOURCE})`,
	"gi",
);
const SUPERSEDED_BY_PATTERN = new RegExp(
	`(${MEMORY_ID_SOURCE})\\s+\\b(?:is\\s+)?superseded\\s+by\\b\\s+(${MEMORY_ID_SOURCE})`,
	"gi",
);

export function deriveTrustedMemoryWriteAuthorization(input: {
	agentName: string;
	userInstruction?: string;
}): MemoryWriteAuthorization | undefined {
	if (input.agentName !== "archivist") return undefined;
	const text = input.userInstruction?.trim();
	if (!text) return undefined;
	if (!MEMORY_REFERENCE_PATTERN.test(text)) return undefined;
	if (META_QUESTION_PATTERN.test(text) && MEMORY_WRITE_VERB_PATTERN.test(text)) {
		return undefined;
	}
	const allowedOperations = extractAllowedOperations(text);
	if (allowedOperations.length === 0 || hasNegatedMutation(text, allowedOperations)) {
		return undefined;
	}
	const allowedMemoryIdsByOperation = extractMemoryIdsByOperation(text, allowedOperations);
	const scopedAllowedOperations = allowedOperations.filter(
		(operation) => (allowedMemoryIdsByOperation[operation]?.length ?? 0) > 0,
	);
	if (scopedAllowedOperations.length === 0) return undefined;
	const scopedMemoryIdSet = new Set(
		scopedAllowedOperations.flatMap((operation) => [
			...(allowedMemoryIdsByOperation[operation] ?? []),
		]),
	);
	const allowedMemoryIds = extractMemoryIds(text).filter((id) => scopedMemoryIdSet.has(id));
	const destructive = scopedAllowedOperations.some((operation) =>
		["archive", "consolidate", "supersede"].includes(operation),
	);
	const supersedeDirections = extractSupersedeDirections(
		text,
		allowedMemoryIdsByOperation.supersede ?? [],
	);
	if (scopedAllowedOperations.includes("supersede") && supersedeDirections.length === 0) {
		return undefined;
	}

	if (destructive || DESTRUCTIVE_MUTATION_PATTERN.test(text)) {
		if (!hasExplicitConfirmation(text) || allowedMemoryIds.length === 0) return undefined;
		return {
			destructive: true,
			allowedMemoryIds,
			allowedMemoryIdsByOperation,
			allowedOperations: scopedAllowedOperations,
			...(supersedeDirections.length > 0 ? { supersedeDirections } : {}),
		};
	}
	if (allowedMemoryIds.length === 0) return undefined;
	return {
		additive: true,
		allowedMemoryIds,
		allowedMemoryIdsByOperation,
		allowedOperations: scopedAllowedOperations,
	};
}

function hasExplicitConfirmation(text: string): boolean {
	const match = AFFIRMATIVE_CONFIRMATION_PATTERN.exec(text);
	if (!match) return false;
	const prefix = text.slice(Math.max(0, match.index - 48), match.index);
	if (NEGATED_CONFIRMATION_PREFIX_PATTERN.test(prefix)) return false;
	const suffix = text.slice(match.index + match[0].length);
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
	if (
		LINK_MUTATION_PATTERN.test(text) ||
		LINK_MEMORY_ID_CLAUSE_PATTERN.test(text) ||
		MARK_RELATIONSHIP_MUTATION_PATTERN.test(text)
	) {
		operations.add("link");
	}
	if (/\b(archive|deprecate|prune)\b/i.test(text)) operations.add("archive");
	if (/\b(consolidate|merge)\b/i.test(text)) operations.add("consolidate");
	if (/\b(supersede|supersedes|superseded|replace)\b/i.test(text)) operations.add("supersede");
	return [...operations];
}

function extractMemoryIdsByOperation(
	text: string,
	operations: readonly MemoryWriteOperation[],
): MemoryWriteOperationIds {
	const spans = operations
		.flatMap((operation) =>
			[...text.matchAll(operationPattern(operation))].map((match) => ({
				operation,
				index: match.index ?? 0,
			})),
		)
		.sort((a, b) => a.index - b.index);
	const idsByOperation: MemoryWriteOperationIds = {};
	for (let index = 0; index < spans.length; index++) {
		const span = spans[index];
		if (!span) continue;
		const nextSpan = spans[index + 1];
		const segment = text.slice(span.index, nextSpan?.index ?? text.length);
		const ids = extractMemoryIds(segment);
		if (ids.length === 0) continue;
		idsByOperation[span.operation] = uniqueStrings([
			...(idsByOperation[span.operation] ?? []),
			...ids,
		]);
	}
	return idsByOperation;
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

function extractSupersedeDirections(
	text: string,
	allowedSupersedeIds: readonly string[],
): MemorySupersedeDirection[] {
	if (allowedSupersedeIds.length === 0) return [];
	const allowed = new Set(allowedSupersedeIds.map((id) => id.toLowerCase()));
	const directions: MemorySupersedeDirection[] = [];
	const addDirection = (fromId: string | undefined, toId: string | undefined) => {
		if (!fromId || !toId) return;
		if (!allowed.has(fromId) || !allowed.has(toId)) return;
		directions.push({ fromId, toId });
	};
	for (const match of text.matchAll(SUPERSEDE_WITH_PATTERN)) {
		addDirection(normalizeMemoryReference(match[2]), normalizeMemoryReference(match[1]));
	}
	for (const match of text.matchAll(SUPERSEDES_PATTERN)) {
		addDirection(normalizeMemoryReference(match[1]), normalizeMemoryReference(match[2]));
	}
	for (const match of text.matchAll(SUPERSEDED_BY_PATTERN)) {
		addDirection(normalizeMemoryReference(match[2]), normalizeMemoryReference(match[1]));
	}
	return uniqueSupersedeDirections(directions);
}

function normalizeMemoryReference(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return extractMemoryIds(value)[0];
}

function uniqueSupersedeDirections(
	directions: readonly MemorySupersedeDirection[],
): MemorySupersedeDirection[] {
	const seen = new Set<string>();
	const unique: MemorySupersedeDirection[] = [];
	for (const direction of directions) {
		const key = `${direction.fromId}->${direction.toId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(direction);
	}
	return unique;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}
