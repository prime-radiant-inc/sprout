import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `You extract durable Sprout memories from coding-agent transcripts.

Rules:
- Extract only from user-authored content. Assistant messages may explain context,
  but they are not sources for new facts unless they quote the user.
- Keep only information useful weeks or months later: project decisions,
  constraints, preferences, recurring failures, architecture facts, commands,
  paths, and operational lessons.
- Skip ephemeral task status, generic reference facts, and one-off actions that
  do not reveal a durable pattern.
- Write each memory as a direct factual statement. Lead with the core fact.
- Preserve precise nouns: file paths, commands, APIs, model names, thresholds,
  error messages, and project names.
- Do not use relative time words like today, yesterday, or tomorrow.
- Do not invent implications that are not grounded in the transcript.

Respond with only valid JSON. No markdown, no code fences.

Return an array. If nothing should be stored, return [].

Each item:
{
  "text": "string",
  "tags": ["optional", "strings"],
  "entities": [
    {
      "name": "string",
      "type": "PROJECT|LIBRARY|FILE_PATH|COMMAND|ERROR_TYPE|TECHNOLOGY|PERSON"
    }
  ],
  "happens_at": "optional ISO-8601 timestamp",
  "expires_at": "optional ISO-8601 timestamp"
}`;

export const MEMORY_EXTRACTION_USER_PROMPT = `<conversation>
{formatted_messages}
</conversation>

Extract new durable memories from the conversation above. Return only JSON.`;

export const SEGMENT_SUMMARY_SYSTEM_PROMPT = `You summarize completed Sprout coding-agent sessions for long-term memory.

Return only valid JSON. No markdown.

The JSON object must contain:
{
  "summary": "A compact factual synopsis of the durable work, decisions, constraints, and outcomes.",
  "title": "Short display title",
  "complexity": 1
}

Rules:
- Preserve exact project names, commands, file paths, APIs, and constraints.
- Prefer concrete outcomes over narration.
- Do not invent facts not present in the transcript.
- Use absolute dates if dates are important.
- Complexity is 1 for simple, 2 for moderate, 3 for complex.`;

export const SEGMENT_SUMMARY_USER_PROMPT = `<session_transcript>
{formatted_messages}
</session_transcript>

Summarize this completed session for future recall. Return only JSON.`;

export const MEMORY_RELATIONSHIP_CLASSIFICATION_PROMPT = `Classify the relationship between two memories from a user's long-term memory system.

CRITICAL CONTEXT: These pairs were surfaced by similarity search. Every pair shares topic overlap. Topical similarity is the baseline, not a signal. Your job: determine whether the similarity constitutes a specific, actionable relationship -- or whether it's just proximity that doesn't warrant a link. Most pairs should be null.

RELATIONSHIP TYPES:

conflicts -- Direct logical contradiction. One memory, if true, makes the other false.
supersedes -- Temporal replacement. The newer memory explicitly replaces the older.
corroborates -- Independent evidence that increases confidence in the other memory.
refines -- Actionable detail that changes how the other memory should be used.
precedes -- Temporal sequence where one event happened before the other.
contextualizes -- Cross-domain framing that changes how to act on the other memory.
exemplifies -- A specific instance of a general pattern, or vice versa.
null -- Similar topic, but no actionable relationship.

DECISION PROCESS:
1. Check for contradiction -> conflicts
2. Check for explicit temporal replacement -> supersedes
3. Ask: "Would one change what I DO with the other?" If no -> null
4. If yes, choose the single best relationship type
5. If uncertain, use null

OUTPUT: Respond with only a valid JSON object.
{"relationship_type": "null", "reasoning": "Both about home automation but knowing one does not change advice on the other"}

WORKED EXAMPLES:

NEW: "The user wants the MIRA port to use SQLite rather than Postgres."
EXISTING: "The MIRA reference implementation stores memory in Postgres."
{"relationship_type":"supersedes","reasoning":"The newer implementation preference replaces the storage decision that would otherwise be copied from the reference."}

NEW: "The user says no fallbacks should be added to the local embedding provider."
EXISTING: "The embedding adapter previously returned empty vectors when the provider failed."
{"relationship_type":"conflicts","reasoning":"The no-fallback requirement directly contradicts fail-soft empty-vector behavior."}

NEW: "The Phase 4 gate proved delegated agents reuse the same surfaced memory block."
EXISTING: "The surfacing design requires recall to run once and fan out to delegated agents."
{"relationship_type":"corroborates","reasoning":"The test result independently supports the design requirement."}

NEW: "The local embedding provider uses MongoDB/mdbr-leaf-ir with 768 dimensions."
EXISTING: "Sprout uses local embeddings for memory search."
{"relationship_type":"refines","reasoning":"The model and dimension details change how local embedding code should be configured."}

NEW: "Phase 2 routed learn memory writes through extraction."
EXISTING: "Phase 1 added embedded memory writes and the SQLite-derived index."
{"relationship_type":"precedes","reasoning":"The index foundation had to exist before learn writes could route through embedded extraction."}

NEW: "The user strongly rejects hidden fallback behavior."
EXISTING: "The memory port needs a relationship classifier that fails loud on invalid JSON."
{"relationship_type":"contextualizes","reasoning":"The user's general engineering preference changes how classifier errors should be handled."}

NEW: "The user asked to use CodeMira as a template without blindly copying decisions."
EXISTING: "The user prefers SQLite for this MIRA port."
{"relationship_type":"exemplifies","reasoning":"Choosing SQLite instead of Postgres is a concrete instance of adapting CodeMira rather than copying it."}

NEW: "The archivist prompt requires cited answers."
EXISTING: "Segment collapse stores summaries in memories/segments.jsonl."
{"relationship_type":"null","reasoning":"Both involve memory architecture, but knowing one does not change how to act on the other."}`;

export const MEMORY_CONSOLIDATION_PROMPT = `You review clusters of Sprout long-term memories and decide whether they should be merged.

Rules:
- Merge only when a single durable memory can preserve every actionable fact.
- Reject if the memories are merely related, if nuance would be lost, or if the cluster was previously rejected for good reason.
- Never delete information. A merge creates one consolidated memory and archives the source memories.
- Preserve exact project names, commands, paths, models, dates, thresholds, and user preferences.
- Prefer one direct factual sentence unless the durable content genuinely needs more detail.

Respond with only valid JSON. No markdown.

For a safe merge:
{
  "action": "merge",
  "memory": {
    "text": "single consolidated durable memory",
    "tags": ["optional", "strings"],
    "entities": [
      {"name": "Sprout", "type": "PROJECT"}
    ],
    "confidence": 0.9
  },
  "reasoning": "one sentence explaining why no nuance is lost"
}

For a rejected merge:
{
  "action": "reject",
  "reasoning": "one sentence explaining why these memories should remain separate"
}`;

export const SUBCORTICAL_RECALL_PROMPT = `You are Sprout's subcortical memory-recall pre-pass.

Your job is query expansion only. Do not answer the user.

Given a user goal and optional retained context, produce:
- an expanded memory-search query with concrete synonyms, project names, file paths, technologies, and likely durable facts
- entity hints that should feed entity-hub recall directly
- pinned memory ids that must be retained if the context already names them

Rules:
- Preserve exact literals from the goal and additional context.
- Add only plausible recall terms; do not invent facts.
- Prefer storage/project/technology synonyms that improve retrieval.
- Keep output compact.
- Return only valid JSON. No markdown.

Schema:
{
  "expanded_query": "compact search query",
  "entities": [
    {"name": "Sprout", "type": "PROJECT"}
  ],
  "pinned_memory_ids": ["optional-full-memory-id-or-mem_shortid"],
  "reasoning": "short reason"
}`;

export interface PromptSet {
	system: string;
	user: string;
}

const DEFAULT_PROMPTS: Record<string, string> = {
	"memory_extraction_system.txt": MEMORY_EXTRACTION_SYSTEM_PROMPT,
	"memory_extraction_user.txt": MEMORY_EXTRACTION_USER_PROMPT,
	"segment_summary_system.txt": SEGMENT_SUMMARY_SYSTEM_PROMPT,
	"segment_summary_user.txt": SEGMENT_SUMMARY_USER_PROMPT,
	"memory_relationship_classification.txt": MEMORY_RELATIONSHIP_CLASSIFICATION_PROMPT,
	"memory_consolidation.txt": MEMORY_CONSOLIDATION_PROMPT,
	"subcortical_recall.txt": SUBCORTICAL_RECALL_PROMPT,
};

export async function loadMemoryExtractionPrompts(
	genomeRoot: string,
	rootDir?: string,
): Promise<PromptSet> {
	return {
		system: await loadPrompt(genomeRoot, rootDir, "memory_extraction_system.txt"),
		user: await loadPrompt(genomeRoot, rootDir, "memory_extraction_user.txt"),
	};
}

export async function loadSegmentSummaryPrompts(
	genomeRoot: string,
	rootDir?: string,
): Promise<PromptSet> {
	return {
		system: await loadPrompt(genomeRoot, rootDir, "segment_summary_system.txt"),
		user: await loadPrompt(genomeRoot, rootDir, "segment_summary_user.txt"),
	};
}

export async function loadRelationshipClassificationPrompt(
	genomeRoot: string,
	rootDir?: string,
): Promise<string> {
	return loadPrompt(genomeRoot, rootDir, "memory_relationship_classification.txt");
}

export async function loadMemoryConsolidationPrompt(
	genomeRoot: string,
	rootDir?: string,
): Promise<string> {
	return loadPrompt(genomeRoot, rootDir, "memory_consolidation.txt");
}

export async function loadSubcorticalRecallPrompt(
	genomeRoot: string,
	rootDir?: string,
): Promise<string> {
	return loadPrompt(genomeRoot, rootDir, "subcortical_recall.txt");
}

export async function loadPrompt(
	genomeRoot: string,
	rootDir: string | undefined,
	name: keyof typeof DEFAULT_PROMPTS,
): Promise<string> {
	const paths = [
		join(genomeRoot, "prompts", name),
		...(rootDir ? [join(rootDir, "prompts", name)] : []),
	];
	for (const path of paths) {
		const content = await readOptionalFile(path);
		if (content !== undefined) return content;
	}
	return DEFAULT_PROMPTS[name]!;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
