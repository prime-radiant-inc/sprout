export function replayPathFromLogBase(logBasePath: string): string {
	return `${logBasePath}.replay.jsonl`;
}

export function resolveReplayPath(inputPath: string): string {
	if (inputPath.endsWith(".replay.jsonl")) {
		return inputPath;
	}
	if (inputPath.endsWith(".jsonl")) {
		return `${inputPath.slice(0, -".jsonl".length)}.replay.jsonl`;
	}
	return replayPathFromLogBase(inputPath);
}
