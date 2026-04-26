export interface MemoryWriteAuthorization {
	additive?: boolean;
	destructive?: boolean;
}

const MEMORY_REFERENCE_PATTERN =
	/\b(memory|memories|long[- ]term memory|mem_[a-z0-9]+|archivist)\b/i;
const ADDITIVE_MUTATION_PATTERN =
	/\b(annotate|annotation|link|relate|corroborate|conflict|contextualize|refine|supersede|supersedes|archive|consolidate|merge)\b/i;
const DESTRUCTIVE_MUTATION_PATTERN =
	/\b(archive|consolidate|merge|supersede|supersedes|superseded|replace|deprecate|prune)\b/i;
const CONFIRMATION_PATTERN =
	/\b(i confirm|confirmed|explicitly confirm|explicit confirmation|i approve|approved|explicitly approve|go ahead|you have confirmation)\b/i;

export function deriveTrustedMemoryWriteAuthorization(input: {
	agentName: string;
	userInstruction?: string;
}): MemoryWriteAuthorization | undefined {
	if (input.agentName !== "archivist") return undefined;
	const text = input.userInstruction?.trim();
	if (!text) return undefined;
	if (!MEMORY_REFERENCE_PATTERN.test(text) || !ADDITIVE_MUTATION_PATTERN.test(text))
		return undefined;

	if (DESTRUCTIVE_MUTATION_PATTERN.test(text) && CONFIRMATION_PATTERN.test(text)) {
		return { destructive: true };
	}
	return { additive: true };
}
