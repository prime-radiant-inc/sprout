/** Known context window sizes by model prefix. */
const CONTEXT_WINDOWS: [prefix: string, size: number][] = [
	["claude", 200_000],
	["gpt-4o", 128_000],
	["gpt-4", 128_000],
	["o1", 200_000],
	["o3", 200_000],
	["gemini-2", 1_000_000],
	["gemini-1.5", 1_000_000],
];

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Return the context window size for a model name. */
export function getContextWindowSize(model: string): number {
	const lower = model.toLowerCase();
	for (const [prefix, size] of CONTEXT_WINDOWS) {
		if (lower.startsWith(prefix)) return size;
	}
	return DEFAULT_CONTEXT_WINDOW;
}
