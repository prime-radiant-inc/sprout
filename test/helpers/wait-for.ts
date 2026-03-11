export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
	fn: () => boolean,
	{ timeout = 2000, interval = 10 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > timeout) {
			throw new Error("waitFor timed out");
		}
		await sleep(interval);
	}
}
