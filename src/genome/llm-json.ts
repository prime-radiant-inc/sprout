/**
 * Hygiene for JSON produced by LLM completions: models wrap payloads in code
 * fences and emit typographic quotes / trailing commas that break JSON.parse.
 * Every genome pipeline that parses model JSON shares these instead of
 * re-declaring them (they drifted as private copies before).
 */

/** Unwrap a ```json fenced block, returning the inner text (or the input unchanged). */
export function stripCodeFence(text: string): string {
	const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	return match?.[1]?.trim() ?? text;
}

/** Repair the common LLM JSON mistakes: smart quotes and trailing commas. */
export function repairJson(text: string): string {
	return text
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/,\s*([}\]])/g, "$1");
}
