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

export interface PromptSet {
	system: string;
	user: string;
}

const DEFAULT_PROMPTS: Record<string, string> = {
	"memory_extraction_system.txt": MEMORY_EXTRACTION_SYSTEM_PROMPT,
	"memory_extraction_user.txt": MEMORY_EXTRACTION_USER_PROMPT,
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
